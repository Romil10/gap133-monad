#!/usr/bin/env node
// The gap133 game on Monad, as an MCP server (stdio). An AI assistant plays the game
// as a labelled agent: it reads the board, decides, and signs its own calls (EIP-712).
// The gap133 relayer submits them on Monad and pays the gas, so the agent's key never
// needs funds.
//
// Tools:
//   gap133_game_board        live questions: the gap now, the round, who called what
//   gap133_game_call         call one question higher or lower (10 points)
//   gap133_game_me           this agent's points, record and address
//   gap133_game_leaderboard  top players, and people vs agents
//
// Configuration (all optional):
//   GAP133_GAME_KEY      private key for the agent's identity. Without it, a key is
//                        created on first use and kept in ~/.gap133/game-agent.key.
//                        It holds no funds; it only signs calls.
//   GAP133_AGENT_HANDLE  leaderboard name (default claude-<last 4 of address>)
//   GAP133_GAME_URL      default https://monad.gap133.xyz
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

const VERSION = '1.0.0';
const env = (k, d) => { const v = (process.env[k] || '').trim(); return v && !v.startsWith('${') ? v : d; };
const SERVICE = env('GAP133_GAME_URL', 'https://monad.gap133.xyz').replace(/\/$/, '');

function loadAccount() {
  const given = env('GAP133_GAME_KEY', '').replace(/["'\s]/g, '');
  if (given) {
    const hex = given.replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('GAP133_GAME_KEY is not a valid private key (expected 64 hex characters)');
    return { account: privateKeyToAccount('0x' + hex), source: 'configured key' };
  }
  const dir = join(homedir(), '.gap133');
  const file = join(dir, 'game-agent.key');
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, generatePrivateKey() + '\n', { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch {}
  }
  return { account: privateKeyToAccount(readFileSync(file, 'utf8').trim()), source: file };
}

let ACCT = null;
let keyError = null;
try { ACCT = loadAccount(); } catch (e) { keyError = e.message; }
const handleFor = (addr) => env('GAP133_AGENT_HANDLE', 'claude-' + addr.slice(-4).toLowerCase()).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 18);

async function api(path, body) {
  for (let i = 0; ; i++) {
    const r = await fetch(SERVICE + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j;
    if ((r.status === 503 || r.status === 500) && i < 3 && !/sponsored gas/.test(j.error || '')) { await new Promise((res) => setTimeout(res, 900 * (i + 1))); continue; }
    throw new Error(j.error || `request failed with ${r.status}`);
  }
}

const DOMAIN = (S) => ({ name: 'gap133 game', version: '1', chainId: S.chain.id, verifyingContract: S.contract });

async function ensureJoined(S) {
  if (S.player?.joined) return S;
  const a = ACCT.account;
  const handle = handleFor(a.address);
  const deadline = (S.chainTime || Math.floor(Date.now() / 1000)) + 600;
  const sig = await a.signTypedData({
    domain: DOMAIN(S),
    types: { Join: [{ name: 'player', type: 'address' }, { name: 'handle', type: 'string' }, { name: 'agent', type: 'bool' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'Join',
    message: { player: a.address, handle, agent: true, nonce: BigInt(S.player?.nonce ?? 0), deadline: BigInt(deadline) },
  });
  await api('/api/join', { player: a.address, handle, agent: true, deadline, sig });
  return api(`/api/state?me=${a.address}`);
}

const c2 = (v) => (v == null ? 'n/a' : `${Number(v).toFixed(2)}c`);
function left(closesAt) {
  const s = closesAt - Date.now() / 1000;
  if (s <= 0) return 'closing';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m left` : `${m}m left`;
}

const TOOLS = [
  {
    name: 'gap133_game_board',
    description: 'Free. The gap133 game on Monad: live questions about the price gap (in cents) between Polymarket and Kalshi for the same event. For each question: its number, the gap now, the window (6h or 24h), the open on-chain round with its opening gap, how many players called higher or lower, time left, and whether you already called it. Use the question number with gap133_game_call. Wider gaps tend to close over time, but not always.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'gap133_game_call',
    description: 'Make a call in the gap133 game on Monad: will this gap be higher or lower when the window closes? Stakes 10 play points (no money, no gas: you sign, gap133 relays). A move of 0.10c or more in your direction wins 10 points; under 0.10c is a push. One call per question per round. You play as a labelled AI agent on the same leaderboard as people. Explain your reasoning to the user when you call.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'number', description: 'Question number from gap133_game_board' },
        direction: { type: 'string', enum: ['higher', 'lower'] },
      },
      required: ['question', 'direction'],
      additionalProperties: false,
    },
  },
  {
    name: 'gap133_game_me',
    description: 'Free. Your agent record in the gap133 game: handle, points, wins, losses, pushes, streak, and your Monad address.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'gap133_game_leaderboard',
    description: 'Free. The gap133 game leaderboard on Monad (people and AI agents), plus the people-vs-agents win rates.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// Calls are signed with the player's sequential nonce, so two calls signed at the same time would share one and the
// second would be rejected. Claude often calls tools in parallel; queue them so each signs with a fresh nonce.
let callQueue = Promise.resolve();
const queued = (fn) => { const run = callQueue.then(fn, fn); callQueue = run.catch(() => {}); return run; };

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

async function callTool(name, args = {}) {
  if (!ACCT) return text(`Game key problem: ${keyError}`, true);
  const me = ACCT.account.address;
  const S = await api(`/api/state?me=${me}`);
  if (name === 'gap133_game_board') {
    if (!S.questions.length) return text('The board is quiet right now. Try again in a few minutes.');
    const lines = S.questions.map((q, i) => {
      const r = q.round;
      const round = r ? `round #${r.id} opened at ${c2(r.openGap / 100)}, ${r.nHigher} higher / ${r.nLower} lower, ${left(r.closesAt)}` : 'no round open yet (your call opens one at the current gap)';
      return `${i + 1}. ${q.question}\n   ${q.windowHours}h window · gap now ${c2(q.gapCents)} · ${round}${q.mine ? ` · YOU CALLED ${q.mine.toUpperCase()}` : ''}`;
    });
    return text(`gap133 game on ${S.chain.name} (contract ${S.contract})\n\n${lines.join('\n')}`);
  }
  if (name === 'gap133_game_me') {
    const p = S.player;
    if (!p?.joined) return text(`Not joined yet. Your first call joins you automatically as "${handleFor(me)}" with 100 points.\nAddress: ${me}`);
    return text(`${p.handle} (AI agent)\nPoints: ${p.points}\nRecord: ${p.wins}W / ${p.losses}L / ${p.pushes}P, streak ${p.streak}, best ${p.bestStreak}\nCalls: ${p.calls}\nAddress: ${me}\nExplorer: ${S.chain.explorer}/address/${me}`);
  }
  if (name === 'gap133_game_leaderboard') {
    const rate = (t) => (t.wins + t.losses ? Math.round((100 * t.wins) / (t.wins + t.losses)) + '%' : 'n/a');
    const rows = S.leaderboard.slice(0, 10).map((r) => `${r.rank}. ${r.handle}${r.agent ? ' [agent]' : ''}  ${r.points} pts  ${r.wins}W/${r.losses}L/${r.pushes}P${r.address.toLowerCase() === me.toLowerCase() ? '  <- you' : ''}`);
    return text(`People ${rate(S.teams.humans)} win rate (${S.teams.humans.players} players) vs AI agents ${rate(S.teams.agents)} (${S.teams.agents.players} agents)\n\n${rows.join('\n') || 'Nobody yet.'}`);
  }
  if (name === 'gap133_game_call') return queued(() => placeCall(args));
  throw new Error(`unknown tool ${name}`);
}

async function placeCall(args) {
  const me = ACCT.account.address;
  const S = await api(`/api/state?me=${me}`);
  {
    const q = S.questions[Number(args.question) - 1];
    if (!q) return text(`No question number ${args.question}. Use gap133_game_board first.`, true);
    if (q.mine) return text(`You already called ${q.mine} on this round.`, true);
    const higher = args.direction === 'higher';
    let S2 = await ensureJoined(S);
    if ((S2.player?.points ?? 0) < 10) return text('Not enough points for another call (each call stakes 10).', true);
    const rd = await api('/api/round', { key: q.key });
    S2 = await api(`/api/state?me=${me}`);
    const deadline = (S2.chainTime || Math.floor(Date.now() / 1000)) + 600;
    const sig = await ACCT.account.signTypedData({
      domain: DOMAIN(S2),
      types: { Call: [{ name: 'player', type: 'address' }, { name: 'roundId', type: 'uint256' }, { name: 'higher', type: 'bool' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
      primaryType: 'Call',
      message: { player: me, roundId: BigInt(rd.roundId), higher, nonce: BigInt(S2.player.nonce), deadline: BigInt(deadline) },
    });
    const j = await api('/api/call', { player: me, roundId: rd.roundId, higher, deadline, sig });
    const r = rd.round;
    return text(`Called ${args.direction.toUpperCase()} on "${q.question}" (${q.windowHours}h).\nRound #${rd.roundId} opened at ${c2(r.openGap / 100)}; closes ${new Date(r.closesAt * 1000).toISOString()}.\nWins if the gap moves 0.10c or more ${higher ? 'up' : 'down'} by then.\nLocked on Monad: ${j.explorer}\nPoints left: ${S2.player.points - 10}`);
  }
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    let result;
    if (method === 'initialize') {
      result = {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'gap133-game', version: VERSION },
        instructions: 'The gap133 game on Monad: call whether a Polymarket vs Kalshi price gap will be higher or lower when a 6h or 24h window closes. Play points only, no money. You play as a labelled AI agent against people. Read the board, reason about each gap, then call.',
      };
    } else if (method === 'tools/list') result = { tools: TOOLS };
    else if (method === 'tools/call') {
      try { result = await callTool(params?.name, params?.arguments || {}); }
      catch (e) { result = text(`error: ${e.shortMessage || e.message || e}`, true); }
    } else if (method === 'ping') result = {};
    else if (!isRequest) return;
    else return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    if (isRequest) send({ jsonrpc: '2.0', id, result });
  } catch (e) {
    if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } });
  }
}

const rl = createInterface({ input: process.stdin });
const pending = new Set();
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
  const p = handle(msg).finally(() => pending.delete(p));
  pending.add(p);
});
rl.on('close', async () => { await Promise.all(pending); process.exit(0); });
process.stderr.write(`gap133-game MCP ${VERSION} ready (${ACCT ? ACCT.account.address + ', ' + ACCT.source : keyError})\n`);
