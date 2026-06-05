/**
 * Settled — swap verification the user runs BEFORE funding a solver's swap.
 *
 * Three independent checks, because a solver supplies the swap's fields and is
 * NOT trusted:
 *   1. compareCid / verifySwapCid — recompute the CID from the on-chain salt +
 *      the audited template. Proves the action *code* is the audited one. It does
 *      NOT, on its own, prove the stored deposit address is the one that code
 *      derives (a solver can post a real CID but a deposit address it controls).
 *   2. verifySwapDeposits — derive the addresses from that code via Lit and assert
 *      they equal the on-chain depositAddressSource/Dest + litActionEvmAddress.
 *      THIS is what makes funding safe (closes audit finding H-1).
 *   3. intentMatches — assert the on-chain swap matches the intent the user
 *      announced (the solver re-supplies those fields; closes H-2).
 *
 * fullVerifySwap runs 1+2 together; the caller also runs intentMatches (pure).
 */

import { templateKeyForChains, getActionCode, computeCid, deriveAddresses, pickDeposit } from './derive.js';

/** Pure compare. Returns { match, computed, stored }. */
export function compareCid(computed, stored) {
  return { match: computed === stored, computed, stored };
}

/** Recompute the CID from the on-chain salt + audited template and compare. */
export async function verifySwapCid(swap) {
  const actionType = templateKeyForChains(swap.sourceChain, swap.destChain);
  if (!actionType) throw new Error('Unsupported chain pair: ' + swap.sourceChain + ' <> ' + swap.destChain);
  const code = getActionCode(actionType, swap.salt, swap.sourceChain, swap.destChain);
  const computed = await computeCid(code);
  return { ...compareCid(computed, swap.litActionCid), actionType };
}

function addrEq(a, b) {
  if (!a || !b) return false;
  return a === b || a.toLowerCase() === b.toLowerCase();
}

/**
 * Derive the deposit addresses from the swap's audited code and assert they
 * equal what's stored on-chain. This is the check that makes funding safe — a
 * solver cannot point the deposit address at itself while passing the CID check.
 * Requires a Lit API key (derivation runs the action in derive mode).
 * @returns {Promise<{match, checks, derived}>}
 */
export async function verifySwapDeposits(swap, litApiKey) {
  const actionType = templateKeyForChains(swap.sourceChain, swap.destChain);
  if (!actionType) throw new Error('Unsupported chain pair: ' + swap.sourceChain + ' <> ' + swap.destChain);
  const code = getActionCode(actionType, swap.salt, swap.sourceChain, swap.destChain);
  const derived = await deriveAddresses(litApiKey, code);
  const depSrc = pickDeposit(derived, 'source');
  const depDst = pickDeposit(derived, 'dest');
  const checks = {
    depositAddressSource: depSrc === swap.depositAddressSource,
    depositAddressDest: depDst === swap.depositAddressDest,
    litActionEvmAddress: addrEq(derived.evmAddress, swap.litActionEvmAddress),
  };
  return {
    match: checks.depositAddressSource && checks.depositAddressDest && checks.litActionEvmAddress,
    checks,
    derived: { depositAddressSource: depSrc, depositAddressDest: depDst, evmAddress: derived.evmAddress },
  };
}

/** CID check + deposit-address derivation in one call. Returns { match, cid, deposits }. */
export async function fullVerifySwap(swap, litApiKey) {
  const cid = await verifySwapCid(swap);
  const deposits = await verifySwapDeposits(swap, litApiKey);
  return { match: cid.match && deposits.match, cid, deposits };
}

/**
 * Pure cross-check: does this on-chain swap honor the intent the user announced?
 * The solver re-supplies these fields into createSwap, so the user must confirm
 * they were not tampered with before funding (closes H-2). `intent` is the
 * locally-stored announced intent. Returns { match, mismatches }.
 */
export function intentMatches(swap, intent) {
  const mismatches = [];
  const eqStr = (k) => { if (String(swap[k]) !== String(intent[k])) mismatches.push(k); };
  const eqAddr = (k) => { if (!addrEq(swap[k], intent[k])) mismatches.push(k); };
  const eqBig = (k) => { if (BigInt(swap[k]) !== BigInt(intent[k])) mismatches.push(k); };

  eqStr('sourceChain');
  eqStr('destChain');
  eqStr('userRefundSource');
  eqStr('userReceiveDest');
  eqBig('sourceAmount');
  if (Number(swap.feeBps) !== Number(intent.feeBps)) mismatches.push('feeBps');
  eqAddr('tokenAddressSource');
  eqAddr('tokenAddressDest');
  // The solver may quote a HIGHER floor but never one below what the user set.
  if (BigInt(swap.minDestAmount) < BigInt(intent.minDestAmount)) mismatches.push('minDestAmount');

  return { match: mismatches.length === 0, mismatches };
}
