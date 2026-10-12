// Shared server logic for the gap133 game on Monad.
//
// The operator key (derived from SERVICE_SECRET) opens rounds, posts closing gaps,
// relays players' signed calls and pays their gas. The house bot key (also derived)
// plays as a labelled AI agent with a simple baseline strategy.
//
// Environment (set in the host, never committed):
//   SERVICE_SECRET   long random phrase; operator and bot keys are derived from it
//   GAME_CONTRACT    deployed GapGame address
//   GAME_CHAIN       "mainnet" (default) or "testnet"
//   DESK_KEY         optional gap133 desk key, used to score pairs that left the board
import { createHash } from 'node:crypto';
import { createPublicClient, createWalletClient, http, keccak256, stringToBytes, getAddress, parseAbi, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';

export const CHAINS = {
  mainnet: { id: 143, name: 'Monad', rpc: 'https://rpc.monad.xyz', explorer: 'https://monadvision.com' },
  testnet: { id: 10143, name: 'Monad Testnet', rpc: 'https://testnet-rpc.monad.xyz', explorer: 'https://testnet.monadvision.com' },
};
export const GAP133 = process.env.GAP133_API || 'https://gap133.xyz';
export const PUSH_BAND = 10; // hundredths of a cent

export function chainInfo() {
  const c = CHAINS[process.env.GAME_CHAIN || 'mainnet'] || CHAINS.mainnet;
  const rpc = process.env.MONAD_RPC_URL || c.rpc;
  return {
    ...c,
    rpc,
    viem: { id: c.id, name: c.name, nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } },
  };
}

const ART = JSON.parse(readFileSync(new URL('../public/contract.json', import.meta.url), 'utf8'));
export const ABI = ART.abi;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function secret() {
  const s = process.env.SERVICE_SECRET;
  if (!s || s.length < 24) throw new HttpError(500, 'service not configured (SERVICE_SECRET missing or too short)');
  return s;
}
export const operatorKey = () => keccak256(stringToBytes('gap133-monad:operator:' + secret()));
export const operatorAccount = () => privateKeyToAccount(operatorKey());
export const botAccount = () => privateKeyToAccount(keccak256(stringToBytes('gap133-monad:bot:' + secret())));

export function gameAddress() {
  const a = process.env.GAME_CONTRACT;
  if (!a) throw new HttpError(503, 'game contract not deployed yet (GAME_CONTRACT missing)');
  return getAddress(a);
}

export function clients() {
  const c = chainInfo();
  const transport = http(c.rpc, { timeout: 12_000, retryCount: 2 });
  const pub = createPublicClient({ chain: c.viem, transport });
  const op = createWalletClient({ account: operatorAccount(), chain: c.viem, transport });
  return { pub, op, chain: c };
}

export const questionKey = (kx, pm, windowHours) => keccak256(stringToBytes(`${kx}|${pm}|${windowHours}`));
export const toGapInt = (cents) => Math.round(Number(cents) * 100);

// ---------------------------------------------------------------- data
let qCache = null;
export async function fetchQuestions() {
  if (qCache && Date.now() - qCache.at < Number(process.env.QUESTIONS_TTL_MS ?? 30_000)) return qCache.list;
  const r = await fetch(`${GAP133}/api/game?view=questions`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new HttpError(502, `gap133 questions feed returned ${r.status}`);
  const j = await r.json();
  const list = (j.questions || []).filter((q) => q.kxTicker && q.pmId && q.windowHours).slice(0, 24).map((q) => ({
    kx: q.kxTicker,
    pm: String(q.pmId),
    windowHours: Number(q.windowHours),
    question: q.question,
    gapCents: Math.round(Number(q.openGap) * 100) / 100,
    key: questionKey(q.kxTicker, String(q.pmId), Number(q.windowHours)),
  }));
  qCache = { at: Date.now(), list };
  return list;
}

/** Current gap for a pair, from the board, or from the desk API if it left the board. */
export async function currentGap(kx, pm) {
  const qs = await fetchQuestions();
  const hit = qs.find((q) => q.kx === kx && q.pm === pm);
  if (hit) return hit.gapCents;
  if (!process.env.DESK_KEY) return null;
  const r = await fetch(`${GAP133}/api/v1/pairs?ticker=${encodeURIComponent(kx)}&include=held,dismissed`, { headers: { 'X-API-Key': process.env.DESK_KEY } });
  if (!r.ok) return null;
  const d = await r.json();
  const pairs = Array.isArray(d) ? d : d.pairs || [];
  const p = pairs.find((x) => !pm || String(x.second?.id ?? x.pm?.id ?? '') === pm) || pairs[0];
  return p?.gap?.rawCents ?? null;
}

// ---------------------------------------------------------------- chain reads
export async function chainNow(pub) {
  return Number((await pub.getBlock({ blockTag: 'latest' })).timestamp);
}

export async function readRound(pub, game, id) {
  const r = await pub.readContract({ address: game, abi: ABI, functionName: 'rounds', args: [BigInt(id)] });
  const [questionKey_, windowHours, opensAt, closesAt, openGap, closeGap, status, nHigher, nLower] = r;
  return { id: Number(id), questionKey: questionKey_, windowHours: Number(windowHours), opensAt: Number(opensAt), closesAt: Number(closesAt), openGap: Number(openGap), closeGap: Number(closeGap), status: ['none', 'open', 'settled', 'void'][status], nHigher: Number(nHigher), nLower: Number(nLower) };
}

export async function readPlayer(pub, game, addr) {
  const p = await pub.readContract({ address: game, abi: ABI, functionName: 'players', args: [getAddress(addr)] });
  const [joined, agent, points, calls, wins, losses, pushes, streak, bestStreak, handle] = p;
  return { address: getAddress(addr), joined, agent, points: Number(points), calls: Number(calls), wins: Number(wins), losses: Number(losses), pushes: Number(pushes), streak: Number(streak), bestStreak: Number(bestStreak), handle };
}

export async function leaderboard(pub, game) {
  const n = Number(await pub.readContract({ address: game, abi: ABI, functionName: 'playerCount' }));
  const rows = [];
  for (let off = 0; off < n; off += 200) {
    const [addrs, ps] = await pub.readContract({ address: game, abi: ABI, functionName: 'getPlayers', args: [BigInt(off), 200n] });
    addrs.forEach((a, i) => {
      const p = ps[i];
      rows.push({ address: a, handle: p.handle, agent: p.agent, points: Number(p.points), calls: Number(p.calls), wins: Number(p.wins), losses: Number(p.losses), pushes: Number(p.pushes), streak: Number(p.streak), bestStreak: Number(p.bestStreak) });
    });
  }
  rows.sort((a, b) => b.points - a.points || b.wins - a.wins || a.calls - b.calls);
  rows.forEach((r, i) => (r.rank = i + 1));
  return rows;
}

/** Board: each question with its live on-chain round, if any. */
export async function board(pub, game, me) {
  const qs = await fetchQuestions();
  const now = await chainNow(pub);
  const out = await Promise.all(qs.map(async (q) => {
    const id = Number(await pub.readContract({ address: game, abi: ABI, functionName: 'liveRound', args: [q.key] }));
    let round = null;
    let mine = null;
    if (id) {
      const r = await readRound(pub, game, id);
      if (r.status === 'open' && r.closesAt > now) {
        round = r;
        if (me) {
          const [dir] = await pub.readContract({ address: game, abi: ABI, functionName: 'entries', args: [BigInt(id), getAddress(me)] });
          if (dir) mine = dir === 1 ? 'higher' : 'lower';
        }
      }
    }
    return { ...q, round, mine };
  }));
  return out;
}

// ---------------------------------------------------------------- operator writes
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Send an operator transaction and wait for it, retrying on nonce races. */
export async function opWrite(ctx, functionName, args) {
  const { pub, op } = ctx;
  const game = gameAddress();
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const { request } = await pub.simulateContract({ account: op.account, address: game, abi: ABI, functionName, args });
      const hash = await op.writeContract(request);
      const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
      if (rcpt.status !== 'success') throw new HttpError(502, `${functionName} reverted: ${hash}`);
      return { hash, rcpt };
    } catch (e) {
      lastErr = e;
      const m = String(e?.shortMessage || e?.message || e);
      if (!/nonce|replacement|underpriced|already known/i.test(m)) throw e;
      await sleep(300 * (attempt + 1));
    }
  }
  throw lastErr;
}

export async function operatorFunded(pub) {
  const bal = await pub.getBalance({ address: operatorAccount().address });
  return { balance: bal, ok: bal > 5n * 10n ** 16n }; // keep 0.05 MON as a floor
}

/** Make sure a question has an open round; returns its id. */
export async function ensureRound(ctx, q) {
  const { pub } = ctx;
  const game = gameAddress();
  const now = await chainNow(pub);
  const id = Number(await pub.readContract({ address: game, abi: ABI, functionName: 'liveRound', args: [q.key] }));
  if (id) {
    const r = await readRound(pub, game, id);
    if (r.status === 'open' && r.closesAt > now) return { id, round: r, opened: false };
  }
  const { rcpt, hash } = await opWrite(ctx, 'openRound', [q.key, q.windowHours, toGapInt(q.gapCents), q.question]);
  const ev = rcpt.logs.find((l) => getAddress(l.address) === game);
  const newId = ev ? Number(BigInt(ev.topics[1])) : Number(await pub.readContract({ address: game, abi: ABI, functionName: 'liveRound', args: [q.key] }));
  return { id: newId, round: await readRound(pub, game, newId), opened: true, hash };
}

/** Settle due rounds and score their callers. Bounded by a time budget. */
export async function settleDue(ctx, budgetMs = 8_000) {
  const { pub } = ctx;
  const game = gameAddress();
  const started = Date.now();
  const now = await chainNow(pub);
  const n = Number(await pub.readContract({ address: game, abi: ABI, functionName: 'roundCount' }));
  const done = [];
  const qs = await fetchQuestions();
  for (let id = Math.max(1, n - 300); id <= n; id++) {
    if (Date.now() - started > budgetMs) break;
    const r = await readRound(pub, game, id);
    if (r.status === 'open' && r.closesAt <= now) {
      const q = qs.find((x) => x.key === r.questionKey);
      let gap = q ? q.gapCents : null;
      if (gap === null) {
        const meta = await questionMeta(pub, game, id);
        if (meta) gap = await currentGap(meta.kx, meta.pm);
      }
      if (gap === null) {
        if (now - r.closesAt > 24 * 3600) {
          await opWrite(ctx, 'voidRound', [BigInt(id)]);
          done.push({ id, voided: true });
        }
        continue;
      }
      await opWrite(ctx, 'settle', [BigInt(id), toGapInt(gap)]);
      r.status = 'settled';
      done.push({ id, closeGap: gap });
    }
    if (r.status === 'settled' || r.status === 'void') {
      const who = await pub.readContract({ address: game, abi: ABI, functionName: 'getCallers', args: [BigInt(id)] });
      const pending = [];
      for (const a of who) {
        const [, claimed] = await pub.readContract({ address: game, abi: ABI, functionName: 'entries', args: [BigInt(id), a] });
        if (!claimed) pending.push(a);
      }
      if (pending.length) {
        await opWrite(ctx, 'claim', [BigInt(id), pending]);
        done.push({ id, scored: pending.length });
      }
    }
  }
  return done;
}

/** Recover the pair for a round from its RoundOpened event text (key is a hash). */
const metaCache = new Map();
async function questionMeta(pub, game, id) {
  if (metaCache.has(id)) return metaCache.get(id);
  const qs = await fetchQuestions();
  const r = await readRound(pub, game, id);
  const q = qs.find((x) => x.key === r.questionKey);
  const meta = q ? { kx: q.kx, pm: q.pm } : null;
  metaCache.set(id, meta);
  return meta;
}

// ---------------------------------------------------------------- house bot
/** Baseline agent: gaps tend to close, so it calls "lower" on wide gaps and "higher" on tight ones. */
export function botDirection(gapCents) {
  return gapCents >= 1 ? 'lower' : 'higher';
}

export async function signCall(account, game, chainId, player, roundId, higher, nonce, deadline) {
  return account.signTypedData({
    domain: { name: 'gap133 game', version: '1', chainId, verifyingContract: game },
    types: { Call: [{ name: 'player', type: 'address' }, { name: 'roundId', type: 'uint256' }, { name: 'higher', type: 'bool' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'Call',
    message: { player, roundId: BigInt(roundId), higher, nonce: BigInt(nonce), deadline: BigInt(deadline) },
  });
}

export async function signJoin(account, game, chainId, handle, agent, nonce, deadline) {
  return account.signTypedData({
    domain: { name: 'gap133 game', version: '1', chainId, verifyingContract: game },
    types: { Join: [{ name: 'player', type: 'address' }, { name: 'handle', type: 'string' }, { name: 'agent', type: 'bool' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'Join',
    message: { player: account.address, handle, agent, nonce: BigInt(nonce), deadline: BigInt(deadline) },
  });
}

/** Let the house bot play every open question it has not called yet. */
export async function botPlay(ctx, budgetMs = 6_000) {
  const { pub, chain } = ctx;
  const game = gameAddress();
  const bot = botAccount();
  const started = Date.now();
  let me = await readPlayer(pub, game, bot.address);
  if (!me.joined) {
    const nonce = await pub.readContract({ address: game, abi: ABI, functionName: 'nonces', args: [bot.address] });
    const deadline = (await chainNow(pub)) + 600;
    const sig = await signJoin(bot, game, chain.id, 'gap133-bot', true, nonce, deadline);
    await opWrite(ctx, 'joinFor', [bot.address, 'gap133-bot', true, BigInt(deadline), sig]);
    me = await readPlayer(pub, game, bot.address);
  }
  const placed = [];
  const qs = await fetchQuestions();
  for (const q of qs.slice(0, Number(process.env.BOT_MAX_QUESTIONS || 8))) {
    if (Date.now() - started > budgetMs) break;
    if (me.points < 10) break;
    const { id } = await ensureRound(ctx, q);
    const [dir] = await pub.readContract({ address: game, abi: ABI, functionName: 'entries', args: [BigInt(id), bot.address] });
    if (dir) continue;
    const higher = botDirection(q.gapCents) === 'higher';
    const nonce = await pub.readContract({ address: game, abi: ABI, functionName: 'nonces', args: [bot.address] });
    const deadline = (await chainNow(pub)) + 600;
    const sig = await signCall(bot, game, chain.id, bot.address, id, higher, nonce, deadline);
    const { hash } = await opWrite(ctx, 'callFor', [bot.address, BigInt(id), higher, BigInt(deadline), sig]);
    me.points -= 10;
    placed.push({ roundId: id, dir: higher ? 'higher' : 'lower', hash });
  }
  return placed;
}

// ---------------------------------------------------------------- http helpers
export function json(res, status, obj, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

const ERR_SELECTORS = Object.fromEntries(ABI.filter((x) => x.type === 'error').map((x) => [keccak256(stringToBytes(x.name + '()')).slice(0, 10), x.name]));
function errorFromSelector(text) {
  const hit = Object.keys(ERR_SELECTORS).find((sel) => text.includes(sel));
  return hit ? ERR_SELECTORS[hit] : '';
}

export function fail(res, err) {
  if (err instanceof HttpError) return json(res, err.status, { error: err.message });
  const named = typeof err?.walk === 'function' ? err.walk((e) => e?.data?.errorName)?.data?.errorName : null;
  const sel = typeof err?.walk === 'function' ? JSON.stringify(err.walk((e) => typeof e?.data === 'string' || typeof e?.data?.data === 'string') ?? {}) : '';
  const m = String(named || '') + ' ' + String(err?.shortMessage || err?.message || err) + ' ' + errorFromSelector(sel);
  const known = m.match(/(AlreadyJoined|AlreadyCalled|NotJoined|NotEnoughPoints|RoundClosed|RoundNotOpen|BadSignature|Expired|BadHandle)/);
  if (known) return json(res, 400, { error: known[1] });
  console.error(err);
  return json(res, 500, { error: 'internal error' });
}

export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export const fmtMon = (wei) => formatEther(wei);
export const sha = (s) => createHash('sha256').update(s).digest('hex');
