import { clients, ensureRound, fetchQuestions, operatorFunded, readBody, json, fail, HttpError } from '../lib/core.mjs';

// Open (or return) the live on-chain round for a question, so the player can sign a call for it.
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, '');
  try {
    const b = req.method === 'POST' ? await readBody(req) : Object.fromEntries(new URL(req.url, 'http://x').searchParams);
    const qs = await fetchQuestions();
    const q = qs.find((x) => x.key === b.key) || qs.find((x) => x.kx === b.kx && String(x.windowHours) === String(b.window));
    if (!q) throw new HttpError(404, 'that question is not on the board right now');
    const ctx = clients();
    if (!(await operatorFunded(ctx.pub)).ok) throw new HttpError(503, 'sponsored gas is paused right now');
    const r = await ensureRound(ctx, q);
    return json(res, 200, { roundId: r.id, round: r.round, opened: r.opened, tx: r.hash || null, question: q });
  } catch (err) {
    return fail(res, err);
  }
}
