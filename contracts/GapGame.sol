// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title gap133 game on Monad
/// @notice Players call whether a cross-venue prediction-market gap (Polymarket or
/// Limitless vs Kalshi, in cents) will be higher or lower when a 6 or 24 hour window
/// closes. Every call is locked on-chain before the window ends, and every result is
/// scored by this contract.
///
/// Two modes, fixed at deployment:
///  - points mode (mainnet): play points only. Players start with 100 points and stake
///    10 per call. Calls can be signed off-chain (EIP-712) and relayed by anyone, so a
///    player needs no gas token. Points have no cash value and cannot be transferred.
///  - staked mode (testnet design demo): each call is paid in the native coin and the
///    contract pays winners. Gated by jurisdiction and not deployed on mainnet.
///
/// Scoring, both modes: a move of PUSH_BAND (0.10c) or more in the called direction
/// wins at even odds (stake back plus the same again), a smaller move is a push (stake
/// back), anything else loses. The house book takes the other side of every call.
contract GapGame {
    // ---------------------------------------------------------------- config
    address public owner;
    address public operator; // opens rounds and posts closing gaps (gap133 attester)
    bool public immutable staked;
    uint256 public immutable stake; // points per call, or wei per call in staked mode

    uint64 public constant START_POINTS = 100;
    int32 public constant PUSH_BAND = 10; // gaps are stored in hundredths of a cent
    uint8 private constant OPEN = 1;
    uint8 private constant SETTLED = 2;
    uint8 private constant VOID = 3;
    uint8 private constant HIGHER = 1;
    uint8 private constant LOWER = 2;

    // ---------------------------------------------------------------- state
    struct Player {
        bool joined;
        bool agent; // self-declared AI agent; shown separately on the leaderboard
        uint64 points;
        uint32 calls;
        uint32 wins;
        uint32 losses;
        uint32 pushes;
        uint32 streak;
        uint32 bestStreak;
        string handle;
    }

    struct Round {
        bytes32 questionKey; // keccak256(kalshiTicker, otherVenueId, windowHours)
        uint32 windowHours;
        uint64 opensAt;
        uint64 closesAt;
        int32 openGap;
        int32 closeGap;
        uint8 status;
        uint32 nHigher;
        uint32 nLower;
    }

    struct Entry {
        uint8 dir;
        bool claimed;
    }

    mapping(address => Player) public players;
    address[] public playerList;
    mapping(uint256 => Round) public rounds;
    uint256 public roundCount;
    mapping(bytes32 => uint256) public liveRound; // questionKey => latest round id
    mapping(uint256 => mapping(address => Entry)) public entries;
    mapping(uint256 => address[]) private callers;
    mapping(address => uint256) public nonces;
    int256 public houseBook; // net result of the house side (points, or wei)
    uint256 public escrow; // staked mode: wei held for open calls

    // ---------------------------------------------------------------- EIP-712
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant JOIN_TYPEHASH =
        keccak256("Join(address player,string handle,bool agent,uint256 nonce,uint256 deadline)");
    bytes32 public constant CALL_TYPEHASH =
        keccak256("Call(address player,uint256 roundId,bool higher,uint256 nonce,uint256 deadline)");

    // ---------------------------------------------------------------- events
    event Joined(address indexed player, string handle, bool agent);
    event RoundOpened(uint256 indexed roundId, bytes32 indexed questionKey, uint32 windowHours, int32 openGap, uint64 closesAt, string question);
    event Called(uint256 indexed roundId, address indexed player, bool higher, uint256 stake, bool relayed);
    event RoundSettled(uint256 indexed roundId, int32 closeGap);
    event RoundVoided(uint256 indexed roundId);
    event Scored(uint256 indexed roundId, address indexed player, uint8 outcome, uint256 payout); // 1 win 2 loss 3 push 4 void
    event OperatorChanged(address operator);

    error NotOwner();
    error NotOperator();
    error BadSignature();
    error Expired();
    error NotJoined();
    error AlreadyJoined();
    error BadHandle();
    error RoundNotOpen();
    error RoundClosed();
    error AlreadyCalled();
    error NotEnoughPoints();
    error WrongStake();
    error StakedModeOnly();
    error PointsModeOnly();
    error TooEarly();
    error QuestionLive();
    error HouseCannotPay();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address operator_, bool staked_, uint256 stake_) {
        owner = msg.sender;
        operator = operator_;
        staked = staked_;
        stake = stake_;
        emit OperatorChanged(operator_);
    }

    // ---------------------------------------------------------------- players
    function join(string calldata handle, bool agent) external {
        _join(msg.sender, handle, agent);
    }

    /// @notice Join on behalf of a player who signed a Join message. Gasless for them.
    function joinFor(address player, string calldata handle, bool agent, uint256 deadline, bytes calldata sig) external {
        if (block.timestamp > deadline) revert Expired();
        bytes32 structHash = keccak256(abi.encode(JOIN_TYPEHASH, player, keccak256(bytes(handle)), agent, nonces[player]++, deadline));
        if (_recover(structHash, sig) != player) revert BadSignature();
        _join(player, handle, agent);
    }

    function _join(address player, string calldata handle, bool agent) private {
        Player storage p = players[player];
        if (p.joined) revert AlreadyJoined();
        uint256 n = bytes(handle).length;
        if (n == 0 || n > 18) revert BadHandle();
        p.joined = true;
        p.agent = agent;
        p.handle = handle;
        if (!staked) p.points = START_POINTS;
        playerList.push(player);
        emit Joined(player, handle, agent);
    }

    // ---------------------------------------------------------------- rounds
    /// @notice Open a round for a question. Gaps are in hundredths of a cent.
    function openRound(bytes32 questionKey, uint32 windowHours, int32 openGap, string calldata question) external onlyOperator returns (uint256 id) {
        uint256 prev = liveRound[questionKey];
        if (prev != 0 && rounds[prev].status == OPEN && block.timestamp < rounds[prev].closesAt) revert QuestionLive();
        id = ++roundCount;
        uint64 closesAt = uint64(block.timestamp) + uint64(windowHours) * 1 hours;
        rounds[id] = Round(questionKey, windowHours, uint64(block.timestamp), closesAt, openGap, 0, OPEN, 0, 0);
        liveRound[questionKey] = id;
        emit RoundOpened(id, questionKey, windowHours, openGap, closesAt, question);
    }

    function settle(uint256 roundId, int32 closeGap) external onlyOperator {
        Round storage r = rounds[roundId];
        if (r.status != OPEN) revert RoundNotOpen();
        if (block.timestamp < r.closesAt) revert TooEarly();
        r.closeGap = closeGap;
        r.status = SETTLED;
        emit RoundSettled(roundId, closeGap);
    }

    /// @notice Void a round whose data died on both venues. Every stake is returned.
    function voidRound(uint256 roundId) external onlyOperator {
        Round storage r = rounds[roundId];
        if (r.status != OPEN) revert RoundNotOpen();
        r.status = VOID;
        emit RoundVoided(roundId);
    }

    // ---------------------------------------------------------------- calls
    /// @notice Points mode: call directly, paying your own gas.
    function call(uint256 roundId, bool higher) external payable {
        if (staked) {
            if (msg.value != stake) revert WrongStake();
            escrow += msg.value;
        } else if (msg.value != 0) {
            revert PointsModeOnly();
        }
        _call(msg.sender, roundId, higher, false);
    }

    /// @notice Points mode: submit a call the player signed off-chain. Anyone may relay.
    function callFor(address player, uint256 roundId, bool higher, uint256 deadline, bytes calldata sig) external {
        if (staked) revert PointsModeOnly();
        if (block.timestamp > deadline) revert Expired();
        bytes32 structHash = keccak256(abi.encode(CALL_TYPEHASH, player, roundId, higher, nonces[player]++, deadline));
        if (_recover(structHash, sig) != player) revert BadSignature();
        _call(player, roundId, higher, true);
    }

    function _call(address player, uint256 roundId, bool higher, bool relayed) private {
        Player storage p = players[player];
        if (!p.joined) {
            if (!staked) revert NotJoined();
            p.joined = true; // staked mode players need no sign-up
            p.handle = "anon";
            playerList.push(player);
            emit Joined(player, "anon", false);
        }
        Round storage r = rounds[roundId];
        if (r.status != OPEN) revert RoundNotOpen();
        if (block.timestamp >= r.closesAt) revert RoundClosed();
        Entry storage e = entries[roundId][player];
        if (e.dir != 0) revert AlreadyCalled();
        if (!staked) {
            if (p.points < stake) revert NotEnoughPoints();
            p.points -= uint64(stake);
        }
        e.dir = higher ? HIGHER : LOWER;
        if (higher) r.nHigher++;
        else r.nLower++;
        p.calls++;
        callers[roundId].push(player);
        emit Called(roundId, player, higher, stake, relayed);
    }

    // ---------------------------------------------------------------- scoring
    /// @notice Score calls in a settled or voided round. Anyone may trigger it.
    function claim(uint256 roundId, address[] calldata who) external {
        Round storage r = rounds[roundId];
        if (r.status != SETTLED && r.status != VOID) revert RoundNotOpen();
        int32 move = r.closeGap - r.openGap;
        for (uint256 i = 0; i < who.length; i++) {
            Entry storage e = entries[roundId][who[i]];
            if (e.dir == 0 || e.claimed) continue;
            e.claimed = true;
            Player storage p = players[who[i]];
            uint8 outcome;
            uint256 payout;
            if (r.status == VOID) {
                outcome = 4;
                payout = stake;
            } else if ((e.dir == HIGHER && move >= PUSH_BAND) || (e.dir == LOWER && move <= -PUSH_BAND)) {
                outcome = 1;
                payout = 2 * stake;
                p.wins++;
                p.streak++;
                if (p.streak > p.bestStreak) p.bestStreak = p.streak;
                houseBook -= int256(stake);
            } else if (move < PUSH_BAND && move > -PUSH_BAND) {
                outcome = 3;
                payout = stake;
                p.pushes++;
            } else {
                outcome = 2;
                p.losses++;
                p.streak = 0;
                houseBook += int256(stake);
            }
            if (staked) {
                escrow -= stake;
                if (payout > 0) {
                    if (address(this).balance < payout) revert HouseCannotPay();
                    (bool ok, ) = who[i].call{value: payout}("");
                    if (!ok) revert HouseCannotPay();
                }
            } else {
                p.points += uint64(payout);
            }
            emit Scored(roundId, who[i], outcome, payout);
        }
    }

    // ---------------------------------------------------------------- views
    function getCallers(uint256 roundId) external view returns (address[] memory) {
        return callers[roundId];
    }

    function playerCount() external view returns (uint256) {
        return playerList.length;
    }

    /// @notice A page of the leaderboard, in join order. The page sorts it.
    function getPlayers(uint256 offset, uint256 limit) external view returns (address[] memory addrs, Player[] memory ps) {
        uint256 n = playerList.length;
        uint256 end = offset + limit > n ? n : offset + limit;
        uint256 len = end > offset ? end - offset : 0;
        addrs = new address[](len);
        ps = new Player[](len);
        for (uint256 i = 0; i < len; i++) {
            addrs[i] = playerList[offset + i];
            ps[i] = players[addrs[i]];
        }
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("gap133 game"), keccak256("1"), block.chainid, address(this)));
    }

    // ---------------------------------------------------------------- owner
    function setOperator(address operator_) external onlyOwner {
        operator = operator_;
        emit OperatorChanged(operator_);
    }

    function transferOwnership(address owner_) external onlyOwner {
        owner = owner_;
    }

    /// @notice Staked mode: the owner funds the house book so winners can be paid.
    receive() external payable {
        if (!staked) revert StakedModeOnly();
    }

    /// @notice Staked mode: withdraw house funds, never the escrow of open calls.
    function withdraw(address payable to, uint256 amount) external onlyOwner {
        if (amount > address(this).balance - escrow) revert HouseCannotPay();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert HouseCannotPay();
    }

    // ---------------------------------------------------------------- internal
    function _recover(bytes32 structHash, bytes calldata sig) private view returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }
}
