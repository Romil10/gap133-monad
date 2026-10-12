import { clients, gameAddress, board, leaderboard, readPlayer, chainNow, operatorAccount, botAccount, operatorFunded, json, fail, ABI } from '../lib/core.mjs';
import { formatEther, isAddress, getAddress } from 'viem';

// Everything the game page and the agent tools need, read live from Monad.
// Shared part of the state (board without "mine", leaderboard, balance) is cached briefly per instance.
let cache = { at: 0, data: null, pending: null };
async function shared(ctx, game) {
  if (cache.data && Date.now() - cache.at < Number(process.env.STATE_TTL_MS ?? 6_000)) return cache.data;
  if (cache.pending) return cache.pending;
  cache.pending = Promise.all([board(ctx.pub, game, null), leaderboard(ctx.pub, game), operatorFunded(ctx.pub), chainNow(ctx.pub)])
    .then((d) => { cache = { at: Date.now(), data: d, pending: null }; return d; })
    .catch((e) => { cache.pending = null; if (cache.data) return cache.data; throw e; });
  return cache.pending;
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const meParam = url.searchParams.get('me');
    const me = meParam && isAddress(meParam) ? getAddress(meParam) : null;
    const ctx = clients();
    const game = gameAddress();
    const [baseQ, rows, funded, now] = await shared(ctx, game);
    let questions = baseQ;
    if (me) {
      // only the player's own entries are read per request (one multicall)
      const mine = await Promise.all(baseQ.map((q) => q.round ? ctx.pub.readContract({ address: game, abi: ABI, functionName: 'entries', args: [BigInt(q.round.id), me] }) : null));
      questions = baseQ.map((q, i) => ({ ...q, mine: mine[i] && mine[i][0] ? (mine[i][0] === 1 ? 'higher' : 'lower') : null }));
    }
    let player = null;
    if (me) {
      player = await readPlayer(ctx.pub, game, me);
      player.nonce = Number(await ctx.pub.readContract({ address: game, abi: ABI, functionName: 'nonces', args: [me] }));
    }
    const humans = rows.filter((r) => !r.agent);
    const agents = rows.filter((r) => r.agent);
    const sum = (a, k) => a.reduce((s, r) => s + r[k], 0);
    return json(res, 200, {
      chain: { id: ctx.chain.id, name: ctx.chain.name, rpc: ctx.chain.rpc, explorer: ctx.chain.explorer },
      contract: game,
      chainTime: now,
      operator: operatorAccount().address,
      bot: botAccount().address,
      sponsoredGas: funded.ok,
      operatorBalanceMon: formatEther(funded.balance),
      questions,
      leaderboard: rows.slice(0, 50),
      teams: {
        humans: { players: humans.length, calls: sum(humans, 'calls'), wins: sum(humans, 'wins'), losses: sum(humans, 'losses') },
        agents: { players: agents.length, calls: sum(agents, 'calls'), wins: sum(agents, 'wins'), losses: sum(agents, 'losses') },
      },
      player,
    }, { 'Cache-Control': me ? 'no-store' : 'public, s-maxage=10' });
  } catch (err) {
    return fail(res, err);
  }
}
