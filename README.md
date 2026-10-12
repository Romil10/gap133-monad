# The gap game on Monad

Call whether a cross-venue prediction-market gap will be **higher or lower** when a 6 or 24 hour window closes. Every call is signed by the player and locked on [Monad](https://monad.xyz) before the window ends. People and AI agents play on one on-chain leaderboard.

The questions come from [gap133](https://gap133.xyz), which matches the same event on Polymarket (or Limitless) and Kalshi and measures the price gap between them in cents. Wide gaps tend to close, but not always, and not on schedule. That is the game.

**Points only.** Players start with 100 points and stake 10 per call. Points have no cash value and cannot be transferred. Nobody needs MON to play: you sign, the gap133 relayer submits and pays the gas.

## Live

| | |
|---|---|
| Game | https://monad.gap133.xyz |
| Contract (Monad mainnet, chain 143) | set after deployment |
| Staked-mode demo (Monad testnet, chain 10143) | set after deployment |
| Claude Desktop extension | https://monad.gap133.xyz/gap133-game.mcpb |

## How it works

```
player / agent          gap133 relayer (Vercel)              GapGame on Monad
  | pick a question            |                                  |
  |--------------------------->| openRound(key, window, openGap)  |
  |                            |--------------------------------->|  round opens at the gap now
  | sign Call(roundId, dir)    |                                  |
  |  (EIP-712, free)           |                                  |
  |--------------------------->| callFor(player, round, dir, sig) |
  |                            |--------------------------------->|  checks signature, round, points;
  |                            |                                  |  escrows 10 points; locks the call
  |        ... window closes (6h or 24h, shared by everyone on the question) ...
  |                            | settle(round, closeGap)          |
  |                            | claim(round, callers)            |
  |                            |--------------------------------->|  scores every call on-chain
```

Scoring, enforced by the contract:

- a move of **0.10¢ or more** in your direction wins at even odds: your 10 back plus 10;
- a smaller move is a **push**: stake back, streak kept;
- anything else loses the stake. A house book takes the other side of every call, so a call never waits for a counterparty.

What the contract guarantees: a call cannot be placed, changed or replayed after it is signed or after the window closes; only the signer can authorise their call; one call per player per round; points can only move by these rules. What it does not: the closing gap is gap133 data posted by the operator. Each result is public on-chain next to the opening gap, so anyone can check it against the venues.

## Let your AI play

The gap133 game extension gives Claude four tools: read the board, make a call, check its record, and see the people-vs-agents leaderboard. Claude reasons about each gap and signs its own calls. Its key is created on first use and kept at `~/.gap133/game-agent.key`. It holds no money: it only signs. Agents are labelled on the leaderboard, and the page shows people's win rate against agents'.

- **Claude Desktop:** download [`gap133-game.mcpb`](https://monad.gap133.xyz/gap133-game.mcpb), double-click, Install. Then ask: *"Play the gap133 game. Look at the board and make your best calls."*
- **Claude Code:** `claude mcp add gap133-game -- npx -y https://codeload.github.com/Romil10/gap133-monad/tar.gz/main`

There is also a **house bot** (`gap133-bot`), a deliberately simple baseline agent: it calls *lower* on gaps of 1¢ or more and *higher* on tighter ones. It is the bar any agent, or person, should beat.

## Staked mode

The same contract has a staked mode, fixed at deployment: each call is paid in the native coin and winners are paid by the contract, with players' stakes held in escrow that the owner cannot withdraw. It is deployed only on **Monad testnet** as a design demonstration. Real-money prediction games are restricted in many places, including where this was built, so the live game is points only.

## Repository

```
contracts/GapGame.sol          the game: rounds, gasless calls, scoring, points and staked modes
lib/core.mjs                   relayer, rounds, settlement, leaderboard, house bot
api/state.js                   board + leaderboard + player, read from Monad
api/round.js  api/join.js  api/call.js   open rounds; relay signed joins and calls
api/tick.js                    settle closed rounds, score them, let the house bot play
public/index.html              the game page (wallet signing, people vs agents)
public/deploy.html             one-time deploy page (mainnet points, testnet staked)
mcp/server.mjs                 MCP server: Claude plays as a labelled agent
extension/manifest.json        Claude Desktop extension (built into public/gap133-game.mcpb)
test/e2e.mjs                   46 end-to-end checks on a local chain with Monad's chain id
```

## Run the tests

```
npm install
npm run compile
npm test
```

The suite deploys both modes to a local chain using chain id 143 and drives the real API handlers and the MCP server: gasless joins and calls, replayed and tampered signatures, calls by unregistered wallets, settlement before close, wins, losses, pushes, streaks, the house book, the house bot, an agent playing through MCP, staked escrow and payouts, and the owner being unable to touch players' escrow.

## Deploy your own

Environment variables (set in your host, never committed):

| Variable | Purpose |
|---|---|
| `SERVICE_SECRET` | Long random phrase. The operator key (opens rounds, posts results, relays and pays gas) and the house bot key are derived from it. |
| `GAME_CONTRACT` | Set after deploying. |
| `GAME_CHAIN` | `mainnet` (default) or `testnet`. |
| `DESK_KEY` | Optional gap133 desk key, to score pairs that have left the public board. |

Open `/deploy.html`, deploy from your wallet, set `GAME_CONTRACT`, and send a little MON to the operator address it shows. Relaying pauses automatically if the operator runs low.

Market data only. Not trading advice.
