import { clients, settleDue, botPlay, operatorFunded, json, fail } from '../lib/core.mjs';

// Housekeeping: settle closed rounds, score them, and let the house bot play.
// Safe to call from anyone or any scheduler; it is idempotent and time-bounded.
let last = 0;
export default async function handler(req, res) {
  try {
    if (Date.now() - last < Number(process.env.TICK_GUARD_MS ?? 30_000)) return json(res, 200, { skipped: 'ran less than 30s ago' });
    last = Date.now();
    const ctx = clients();
    const settled = await settleDue(ctx, 7_000);
    let bot = [];
    if ((await operatorFunded(ctx.pub)).ok && process.env.BOT_ENABLED !== '0') bot = await botPlay(ctx, 6_000);
    return json(res, 200, { settled, bot });
  } catch (err) {
    return fail(res, err);
  }
}
