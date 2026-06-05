/**
 * Settled — CID verification.
 *
 * Trust check the user runs before funding a solver's swap: recompute the CID
 * from the published salt + the audited template for the swap's chains, and
 * compare it to the CID stored on-chain. A match proves the deposit address is
 * controlled by the expected (audited) action code, not something the solver
 * swapped in.
 */

import { templateKeyForChains, getActionCode, computeCid } from './derive.js';

/** Pure compare. Returns { match, computed, stored }. */
export function compareCid(computed, stored) {
  return { match: computed === stored, computed, stored };
}

/**
 * Recompute the CID for a swap and compare to the stored value.
 * @param {{sourceChain,destChain,salt,litActionCid}} swap
 * @returns {Promise<{match, computed, stored, actionType}>}
 */
export async function verifySwapCid(swap) {
  const actionType = templateKeyForChains(swap.sourceChain, swap.destChain);
  if (!actionType) throw new Error('Unsupported chain pair: ' + swap.sourceChain + ' <> ' + swap.destChain);
  const code = getActionCode(actionType, swap.salt, swap.sourceChain, swap.destChain);
  const computed = await computeCid(code);
  return { ...compareCid(computed, swap.litActionCid), actionType };
}
