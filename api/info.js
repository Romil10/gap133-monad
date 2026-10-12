import { chainInfo, operatorAccount, botAccount, json, fail } from '../lib/core.mjs';

// Service description. Works before deployment, so the deploy page can read the operator address.
export default async function handler(req, res) {
  try {
    const c = chainInfo();
    return json(res, 200, {
      service: 'gap133 game on Monad: call cross-venue prediction-market gaps, every call locked on-chain',
      chain: { id: c.id, name: c.name, explorer: c.explorer },
      contract: process.env.GAME_CONTRACT || null,
      operator: operatorAccount().address,
      bot: botAccount().address,
      mode: 'points',
      endpoints: { state: '/api/state?me=0x...', round: 'POST /api/round {key}', join: 'POST /api/join', call: 'POST /api/call', tick: '/api/tick' },
    });
  } catch (err) {
    return fail(res, err);
  }
}
