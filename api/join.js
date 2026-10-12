import { clients, opWrite, operatorFunded, readBody, json, fail, HttpError } from '../lib/core.mjs';
import { isAddress, getAddress, isHex } from 'viem';

// Relay a signed Join. The player pays nothing; the operator pays the gas.
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, '');
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');
    const b = await readBody(req);
    if (!isAddress(b.player || '') || !isHex(b.sig || '') || typeof b.handle !== 'string') throw new HttpError(400, 'need player, handle, agent, deadline, sig');
    const handle = b.handle.trim();
    if (!/^[A-Za-z0-9_.-]{2,18}$/.test(handle)) throw new HttpError(400, 'handle: 2-18 letters, numbers, _ . -');
    const ctx = clients();
    if (!(await operatorFunded(ctx.pub)).ok) throw new HttpError(503, 'sponsored gas is paused right now; you can still join directly with join() on the contract');
    const { hash } = await opWrite(ctx, 'joinFor', [getAddress(b.player), handle, !!b.agent, BigInt(b.deadline), b.sig]);
    return json(res, 200, { ok: true, tx: hash, explorer: `${ctx.chain.explorer}/tx/${hash}` });
  } catch (err) {
    return fail(res, err);
  }
}
