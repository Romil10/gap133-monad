import { clients, gameAddress, operatorAccount, readBody, json, fail, HttpError, ABI } from '../lib/core.mjs';
import { verifyMessage, getAddress, isHex, formatEther, parseEther } from 'viem';

// Return the operator's MON to the contract owner. Only the owner can trigger it (signed
// message), and the destination is always owner() read from the contract, never an input.
export const sweepMessage = (deadline, amount) => `gap133-monad: return ${amount} operator MON to the contract owner. Valid until ${deadline}.`;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, '');
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');
    const b = await readBody(req);
    if (!isHex(b.sig || '') || !b.deadline) throw new HttpError(400, 'need deadline, amount ("all" or MON), sig');
    if (Math.floor(Date.now() / 1000) > Number(b.deadline)) throw new HttpError(400, 'Expired');
    const amount = String(b.amount || 'all');
    const ctx = clients();
    const game = gameAddress();
    const owner = getAddress(await ctx.pub.readContract({ address: game, abi: ABI, functionName: 'owner' }));
    const okSig = await verifyMessage({ address: owner, message: sweepMessage(b.deadline, amount), signature: b.sig });
    if (!okSig) throw new HttpError(403, 'only the contract owner can return operator MON');
    const op = operatorAccount().address;
    const bal = await ctx.pub.getBalance({ address: op });
    const gasPrice = await ctx.pub.getGasPrice();
    const reserve = gasPrice * 21_000n * 2n;
    let value = amount === 'all' ? bal - reserve : parseEther(amount);
    if (value <= 0n || value > bal - reserve) throw new HttpError(400, `operator holds ${formatEther(bal)} MON`);
    const hash = await ctx.op.sendTransaction({ to: owner, value, gas: 21_000n });
    await ctx.pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
    return json(res, 200, { ok: true, to: owner, mon: formatEther(value), tx: hash, explorer: `${ctx.chain.explorer}/tx/${hash}` });
  } catch (err) {
    return fail(res, err);
  }
}
