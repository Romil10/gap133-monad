import { clients, opWrite, operatorFunded, readPlayer, gameAddress, settleDue, readBody, json, fail, HttpError } from '../lib/core.mjs';
import { isAddress, getAddress, isHex } from 'viem';

// Relay a signed Call. The contract checks the signature, the round and the points;
// the operator only pays the gas. Afterwards it uses a little spare time to settle
// any rounds that have closed, so the game keeps moving without a scheduler.
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, '');
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');
    const b = await readBody(req);
    if (!isAddress(b.player || '') || !isHex(b.sig || '') || !b.roundId) throw new HttpError(400, 'need player, roundId, higher, deadline, sig');
    const ctx = clients();
    if (!(await operatorFunded(ctx.pub)).ok) throw new HttpError(503, 'sponsored gas is paused right now; you can still call directly with call() on the contract');
    const p = await readPlayer(ctx.pub, gameAddress(), b.player);
    if (!p.joined) throw new HttpError(400, 'NotJoined');
    if (p.points < 10) throw new HttpError(400, 'NotEnoughPoints');
    const { hash } = await opWrite(ctx, 'callFor', [getAddress(b.player), BigInt(b.roundId), !!b.higher, BigInt(b.deadline), b.sig]);
    return json(res, 200, { ok: true, tx: hash, explorer: `${ctx.chain.explorer}/tx/${hash}` });
  } catch (err) {
    return fail(res, err);
  }
}
