/**
 * Action assembler. Composes a complete Lit Action code string from the shared
 * snippet generators: jsDelivr imports + chain config + engine + the leg
 * drivers the pair needs + a thin main() that wires the two legs into runSwap.
 *
 * The assembled string is what gets deployed to Lit/IPFS. It runs in the Lit
 * sandbox (ESM, jsDelivr-only imports) — it is never executed via new Function
 * in tests; the test harness uses simplified per-pair copies of the settlement
 * flow instead.
 */

import { importsSrc } from './imports.js';
import { chainConfigSrc, CHAINS } from './networks.js';
import { engineSrc } from './engine.js';
import { UTXO_MATH_SRC, utxoLegSrc } from './utxo-leg.js';
import { zecLegSrc } from './zec-leg.js';
import { solLegSrc } from './sol-leg.js';

const FACTORY = { evm: 'makeEvmLeg', utxo: 'makeUtxoLeg', zec: 'makeZecLeg', sol: 'makeSolLeg' };

function familyOf(id) {
  if (!CHAINS[id]) throw new Error(`Unknown chain id: ${id}`);
  return CHAINS[id].family;
}

/**
 * @param {object} o
 * @param {string} o.salt
 * @param {string} o.source       - source chain id (e.g. 'bitcoin-signet')
 * @param {string} o.dest         - dest chain id
 * @param {string[]} o.settleOrder- ['dest','source'] etc.
 * @param {'source'|'dest'} o.feeLeg
 * @param {'send-evm'|'retain'} o.feeMode
 * @returns {string} complete action code
 */
export function assembleAction(o) {
  const sFam = familyOf(o.source);
  const dFam = familyOf(o.dest);
  const need = {
    utxo: sFam === 'utxo' || dFam === 'utxo',
    zec: sFam === 'zec' || dFam === 'zec',
    sol: sFam === 'sol' || dFam === 'sol',
  };

  const parts = [];
  parts.push(importsSrc(need));
  parts.push(`const SWAP_SALT = ${JSON.stringify(o.salt)};`);
  parts.push(chainConfigSrc([o.source, o.dest]));
  parts.push(engineSrc());
  if (need.utxo || need.zec) parts.push(UTXO_MATH_SRC); // selectCoins/drainCoins + SIZES_*
  if (need.utxo) parts.push(utxoLegSrc());
  if (need.zec) parts.push(zecLegSrc());
  if (need.sol) parts.push(solLegSrc());

  const cfg = JSON.stringify({ settleOrder: o.settleOrder, feeLeg: o.feeLeg, feeMode: o.feeMode });
  parts.push(`
async function main(params) {
  var privateKeyHex = await Lit.Actions.getLitActionPrivateKey();
  var ctx = { privateKeyHex: privateKeyHex, keyBytes: keyToBytes(privateKeyHex), params: params };
  var sourceLeg = ${FACTORY[sFam]}(ctx, ${JSON.stringify(o.source)}, "source");
  var destLeg = ${FACTORY[dFam]}(ctx, ${JSON.stringify(o.dest)}, "dest");
  return runSwap(ctx, ${cfg}, sourceLeg, destLeg);
}
`);
  return parts.join('\n');
}
