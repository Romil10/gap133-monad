import { clients, gameAddress, board, leaderboard, readPlayer, chainNow, operatorAccount, botAccount, operatorFunded, json, fail, ABI } from '../lib/core.mjs';
import { formatEther, isAddress, getAddress } from 'viem';

// Everything the game page and the agent tools need, read live from Monad.
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const meParam = url.searchParams.get('me');
    const me = meParam && isAddress(meParam) ? getAddress(meParam) : null;
    const ctx = clients();
    const game = gameAddress();
    const [questions, rows, funded, now] = await Promise.all([board(ctx.pub, game, me), leaderboard(ctx.pub, game), operatorFunded(ctx.pub), chainNow(ctx.pub)]);
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
