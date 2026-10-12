// End-to-end test on a local chain with Monad's chain id (143).
// Starts ganache and a mock gap133 questions feed, deploys GapGame in points mode
// and in staked mode, then drives the real API handlers and the contract through
// joining, gasless calls, settlement, scoring and the failure cases.
import ganache from 'ganache';
import http from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';
import { createWalletClient, createPublicClient, http as vhttp, getAddress, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const PORT_CHAIN = 18645, PORT_FEED = 18646;
const deployerKey = '0x' + '31'.repeat(32), aliceKey = '0x' + '32'.repeat(32), bobKey = '0x' + '33'.repeat(32), agentKey = '0x' + '34'.repeat(32), carolKey = '0x' + '35'.repeat(32);
process.env.SERVICE_SECRET = 'monad test secret phrase that is long enough';
process.env.GAME_CHAIN = 'mainnet';
process.env.MONAD_RPC_URL = `http://127.0.0.1:${PORT_CHAIN}`;
process.env.GAP133_API = `http://127.0.0.1:${PORT_FEED}`;
process.env.BOT_MAX_QUESTIONS = '2';
process.env.TICK_GUARD_MS = '0';
process.env.QUESTIONS_TTL_MS = '0';

const core = await import('../lib/core.mjs');
const operator = core.operatorAccount(), bot = core.botAccount();
const fund = '0x' + (10n ** 21n).toString(16);
const server = ganache.server({
  chain: { chainId: 143 },
  wallet: { accounts: [deployerKey, aliceKey, bobKey, agentKey, carolKey].map((k) => ({ secretKey: k, balance: fund })) },
  logging: { quiet: true },
});
await server.listen(PORT_CHAIN);

// gap133 questions feed mock; tests move the gaps
const feed = { questions: [
  { kxTicker: 'KXA-1', pmId: '11', question: 'Will A happen?', windowHours: 6, closesAt: 0, openGap: 2.0 },
  { kxTicker: 'KXB-2', pmId: '22', question: 'Will B happen?', windowHours: 24, closesAt: 0, openGap: 0.5 },
] };
const mock = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(feed)); });
await new Promise((r) => mock.listen(PORT_FEED, r));

const art = JSON.parse(readFileSync('public/contract.json', 'utf8'));
const chain = core.chainInfo().viem;
const t = vhttp(process.env.MONAD_RPC_URL);
const pub = createPublicClient({ chain, transport: t });
const wallet = (k) => createWalletClient({ account: privateKeyToAccount(k), chain, transport: t });
const dep = wallet(deployerKey);
// fund the derived operator from the deployer
await pub.waitForTransactionReceipt({ hash: await dep.sendTransaction({ to: operator.address, value: parseEther('50') }) });

let pass = 0, failN = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { failN++; console.log('  FAIL', m); } };
const reverts = async (p, name) => { try { await p; return false; } catch (e) { return name ? String(e?.shortMessage || e?.message || e).includes(name) || JSON.stringify(e?.cause?.data || '').length > 0 : true; } };
const timeTravel = async (s) => { await pub.request({ method: 'evm_increaseTime', params: [s] }); await pub.request({ method: 'evm_mine', params: [] }); };

function call(handler, method, url, body) {
  return new Promise((resolve) => {
    const req = { method, url, headers: {}, body };
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { resolve({ status: this.statusCode, body: b ? JSON.parse(b) : null }); } };
    handler(req, res);
  });
}
const H = {};
for (const n of ['state', 'join', 'round', 'call', 'tick', 'info']) H[n] = (await import(`../api/${n}.js`)).default;

// ---------------------------------------------------------------- deploy (points mode)
let r = await call(H.info, 'GET', '/api/info');
ok(r.status === 200 && getAddress(r.body.operator) === operator.address, 'info reports the derived operator before deployment');
const dh = await dep.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [operator.address, false, 10n] });
const game = (await pub.waitForTransactionReceipt({ hash: dh })).contractAddress;
process.env.GAME_CONTRACT = game;
const read = (fn, args = []) => pub.readContract({ address: game, abi: art.abi, functionName: fn, args });
const chainId = 143;

// ---------------------------------------------------------------- gasless join
const alice = privateKeyToAccount(aliceKey), bob = privateKeyToAccount(bobKey), agent = privateKeyToAccount(agentKey), carol = privateKeyToAccount(carolKey);
const deadline = async () => Number((await pub.getBlock()).timestamp) + 600;
async function signedJoin(acct, handle, isAgent) {
  const nonce = await read('nonces', [acct.address]);
  const dl = await deadline();
  return { player: acct.address, handle, agent: isAgent, deadline: dl, sig: await core.signJoin(acct, game, chainId, handle, isAgent, nonce, dl) };
}
const aliceBal = await pub.getBalance({ address: alice.address });
r = await call(H.join, 'POST', '/api/join', await signedJoin(alice, 'alice', false));
ok(r.status === 200 && r.body.tx, 'player joins with a signature; operator relays');
ok((await pub.getBalance({ address: alice.address })) === aliceBal, 'joining costs the player no gas');
let p = await core.readPlayer(pub, game, alice.address);
ok(p.joined && p.points === 100 && p.handle === 'alice' && !p.agent, 'new player starts with 100 points');
r = await call(H.join, 'POST', '/api/join', await signedJoin(alice, 'alice2', false));
ok(r.status === 400 && /AlreadyJoined/.test(r.body.error), 'a wallet can join only once');
const forged = await signedJoin(bob, 'mallory', false); forged.player = carol.address;
r = await call(H.join, 'POST', '/api/join', forged);
ok(r.status === 400 && /BadSignature/.test(r.body.error), 'join signed by someone else is rejected');
r = await call(H.join, 'POST', '/api/join', await signedJoin(agent, 'claude-test', true));
ok(r.status === 200 && (await core.readPlayer(pub, game, agent.address)).agent === true, 'an AI agent joins and is labelled as an agent');
await call(H.join, 'POST', '/api/join', await signedJoin(bob, 'bob', false));

// ---------------------------------------------------------------- rounds and gasless calls
r = await call(H.state, 'GET', `/api/state?me=${alice.address}`);
ok(r.status === 200 && r.body.questions.length === 2 && r.body.questions.every((q) => q.round === null), 'state lists board questions with no rounds yet');
const qA = r.body.questions[0];
r = await call(H.round, 'POST', '/api/round', { key: qA.key });
ok(r.status === 200 && r.body.opened && r.body.round.openGap === 200 && r.body.round.windowHours === 6, 'first call opens an on-chain round at the current gap');
const roundA = r.body.roundId;
r = await call(H.round, 'POST', '/api/round', { key: qA.key });
ok(r.body.roundId === roundA && !r.body.opened, 'later players join the same round (shared close time)');

async function signedCall(acct, roundId, higher) {
  const nonce = await read('nonces', [acct.address]);
  const dl = await deadline();
  return { player: acct.address, roundId, higher, deadline: dl, sig: await core.signCall(acct, game, chainId, acct.address, roundId, higher, nonce, dl) };
}
const aliceCall = await signedCall(alice, roundA, false);
r = await call(H.call, 'POST', '/api/call', aliceCall);
ok(r.status === 200 && r.body.tx, 'signed call relayed and locked on-chain');
ok((await core.readPlayer(pub, game, alice.address)).points === 90, 'stake of 10 points escrowed');
r = await call(H.call, 'POST', '/api/call', aliceCall);
ok(r.status === 400, 'replayed signature rejected');
r = await call(H.call, 'POST', '/api/call', await signedCall(alice, roundA, true));
ok(r.status === 400 && /AlreadyCalled/.test(r.body.error), 'one call per player per round');
const tampered = await signedCall(bob, roundA, true); tampered.higher = false;
r = await call(H.call, 'POST', '/api/call', tampered);
ok(r.status === 400 && /BadSignature/.test(r.body.error), 'changing the direction after signing breaks the signature');
await call(H.call, 'POST', '/api/call', await signedCall(bob, roundA, true));
await call(H.call, 'POST', '/api/call', await signedCall(agent, roundA, false));
r = await call(H.call, 'POST', '/api/call', await signedCall(carol, roundA, true));
ok(r.status === 400 && /NotJoined/.test(r.body.error), 'a wallet that never joined cannot call');
ok(await reverts(wallet(aliceKey).writeContract({ address: game, abi: art.abi, functionName: 'settle', args: [BigInt(roundA), 100] })), 'only the operator can post a result');
ok(await reverts(core.opWrite(core.clients(), 'settle', [BigInt(roundA), 100])), 'a round cannot be settled before it closes');

// ---------------------------------------------------------------- house bot
r = await call(H.tick, 'GET', '/api/tick');
ok(r.status === 200 && r.body.bot.length === 2, 'house bot joins and plays the open questions');
const bp = await core.readPlayer(pub, game, bot.address);
ok(bp.agent && bp.handle === 'gap133-bot' && bp.calls === 2, 'house bot is a labelled agent player');
const [botDirA] = await read('entries', [BigInt(roundA), bot.address]);
ok(botDirA === 2, 'bot calls lower on a wide 2.0c gap (gaps tend to close)');

// ---------------------------------------------------------------- settle and score
feed.questions[0].openGap = 1.4; // gap closed by 0.6c
await timeTravel(6 * 3600 + 5);
r = await call(H.tick, 'GET', '/api/tick');
ok(r.status === 200 && r.body.settled.some((x) => x.id === roundA && x.closeGap === 1.4), 'tick settles the closed round at the current gap');
ok(r.body.settled.some((x) => x.id === roundA && x.scored === 4), 'tick scores every caller in the round');
const A = await core.readPlayer(pub, game, alice.address), B = await core.readPlayer(pub, game, bob.address), G = await core.readPlayer(pub, game, agent.address);
ok(A.points === 110 && A.wins === 1 && A.streak === 1, 'lower call wins: stake back plus 10');
ok(B.points === 90 && B.losses === 1 && B.streak === 0, 'higher call loses its stake');
ok(G.points === 110 && G.wins === 1, 'the agent is scored by the same rules');
ok(Number(await read('houseBook')) === -20, 'house book records the even-odds result (3 wins, 1 loss)');
const rb = await call(H.state, 'GET', '/api/state');
ok(rb.body.leaderboard[0].points === 110 && rb.body.teams.agents.players === 2 && rb.body.teams.humans.players === 2, 'leaderboard read from chain, split into people and agents');

// push and void
r = await call(H.round, 'POST', '/api/round', { key: qA.key });
const roundA2 = r.body.roundId;
ok(roundA2 !== roundA && r.body.round.status === 'open', 'a closed question reopens as a new round');
await call(H.call, 'POST', '/api/call', await signedCall(alice, roundA2, true));
feed.questions[0].openGap = 1.45; // moved 0.05c: inside the push band
await timeTravel(6 * 3600 + 5);
await core.settleDue(core.clients());
const A2 = await core.readPlayer(pub, game, alice.address);
ok(A2.points === 110 && A2.pushes === 1 && A2.streak === 1, 'a move under 0.10c is a push: stake back, streak kept');

// ---------------------------------------------------------------- direct play without the relayer
const bh = await wallet(carolKey).writeContract({ address: game, abi: art.abi, functionName: 'join', args: ['carol', false] });
await pub.waitForTransactionReceipt({ hash: bh });
r = await call(H.round, 'POST', '/api/round', { key: qA.key });
const ch = await wallet(carolKey).writeContract({ address: game, abi: art.abi, functionName: 'call', args: [BigInt(r.body.roundId), true] });
ok((await pub.waitForTransactionReceipt({ hash: ch })).status === 'success', 'anyone can also play directly against the contract, paying their own gas');
ok(await reverts(wallet(carolKey).writeContract({ address: game, abi: art.abi, functionName: 'call', args: [BigInt(r.body.roundId), true], value: 1n })), 'points mode refuses real coins');
ok(await reverts(dep.sendTransaction({ to: game, value: 1n })), 'points mode contract cannot receive coins');

// ---------------------------------------------------------------- AI agent via MCP
const PORT_SVC = 18647;
const svc = http.createServer(async (req, res) => {
  const h = { '/api/state': H.state, '/api/join': H.join, '/api/round': H.round, '/api/call': H.call }[req.url.split('?')[0]];
  if (!h) { res.statusCode = 404; return res.end('{}'); }
  h(req, res);
});
await new Promise((r) => svc.listen(PORT_SVC, r));
const home = mkdtempSync(pjoin(tmpdir(), 'g133-'));
const mcp = spawn(process.execPath, ['mcp/server.mjs'], { env: { ...process.env, HOME: home, USERPROFILE: home, GAP133_GAME_URL: `http://127.0.0.1:${PORT_SVC}`, GAP133_AGENT_HANDLE: 'claude-e2e' }, stdio: ['pipe', 'pipe', 'pipe'] });
const replies = new Map(); let buf = '';
mcp.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) { const m = JSON.parse(l); replies.get(m.id)?.(m); } } });
let rid = 0;
const rpc = (method, params) => new Promise((resolve) => { const id = ++rid; replies.set(id, resolve); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const tool = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
ok(init.result.serverInfo.name === 'gap133-game', 'agent MCP handshake');
const list = await rpc('tools/list', {});
ok(['gap133_game_board', 'gap133_game_call', 'gap133_game_me', 'gap133_game_leaderboard'].every((n) => list.result.tools.some((x) => x.name === n)), 'agent MCP lists the four game tools');
let tr = await tool('gap133_game_board');
ok(!tr.isError && /1\. Will A happen\?/.test(tr.content[0].text), 'agent reads the board');
tr = await tool('gap133_game_call', { question: 2, direction: 'higher' });
ok(!tr.isError && /Called HIGHER/.test(tr.content[0].text) && /Locked on Monad/.test(tr.content[0].text), 'agent joins and makes a gasless call with its own key');
tr = await tool('gap133_game_me');
ok(!tr.isError && /claude-e2e \(AI agent\)/.test(tr.content[0].text) && /Points: 90/.test(tr.content[0].text), 'agent record shows the agent label and the stake');
tr = await tool('gap133_game_call', { question: 2, direction: 'lower' });
ok(tr.isError && /already called/.test(tr.content[0].text), 'agent cannot call the same round twice');
tr = await tool('gap133_game_leaderboard');
ok(!tr.isError && /AI agents/.test(tr.content[0].text) && /claude-e2e \[agent\]/.test(tr.content[0].text), 'agent sees itself on the people-vs-agents leaderboard');
mcp.stdin.end(); svc.close();

// ---------------------------------------------------------------- staked mode (testnet design)
const stakeWei = parseEther('0.1');
const sh = await dep.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [operator.address, true, stakeWei] });
const sgame = (await pub.waitForTransactionReceipt({ hash: sh })).contractAddress;
const sread = (fn, args = []) => pub.readContract({ address: sgame, abi: art.abi, functionName: fn, args });
const opw = wallet(core.operatorKey());
await pub.waitForTransactionReceipt({ hash: await dep.sendTransaction({ to: sgame, value: parseEther('1') }) });
const key = core.questionKey('KXS-1', '9', 6);
await pub.waitForTransactionReceipt({ hash: await opw.writeContract({ address: sgame, abi: art.abi, functionName: 'openRound', args: [key, 6, 300, 'staked demo'] }) });
const sid = await sread('roundCount');
ok(await reverts(wallet(aliceKey).writeContract({ address: sgame, abi: art.abi, functionName: 'call', args: [sid, false], value: stakeWei - 1n })), 'staked mode needs the exact stake');
await pub.waitForTransactionReceipt({ hash: await wallet(aliceKey).writeContract({ address: sgame, abi: art.abi, functionName: 'call', args: [sid, false], value: stakeWei }) });
await pub.waitForTransactionReceipt({ hash: await wallet(bobKey).writeContract({ address: sgame, abi: art.abi, functionName: 'call', args: [sid, true], value: stakeWei }) });
ok((await sread('escrow')) === 2n * stakeWei, 'stakes held in escrow');
ok(await reverts(dep.writeContract({ address: sgame, abi: art.abi, functionName: 'withdraw', args: [dep.account.address, parseEther('1') + 1n] })), 'owner cannot withdraw players\' escrow');
await timeTravel(6 * 3600 + 5);
await pub.waitForTransactionReceipt({ hash: await opw.writeContract({ address: sgame, abi: art.abi, functionName: 'settle', args: [sid, 200] }) });
const before = await pub.getBalance({ address: alice.address });
await pub.waitForTransactionReceipt({ hash: await dep.writeContract({ address: sgame, abi: art.abi, functionName: 'claim', args: [sid, [alice.address, bob.address]] }) });
ok((await pub.getBalance({ address: alice.address })) - before === 2n * stakeWei, 'staked mode pays the winner double the stake');
ok((await sread('escrow')) === 0n && (await sread('houseBook')) === 0n, 'escrow cleared; house even on a split round');
ok(await reverts(opw.writeContract({ address: sgame, abi: art.abi, functionName: 'callFor', args: [alice.address, sid, true, 9999999999n, '0x' + '00'.repeat(65)] })), 'staked mode has no gasless path (players pay their own stake)');

console.log(`\n${pass} passed, ${failN} failed`);
await server.close();
mock.close();
process.exit(failN ? 1 : 0);
