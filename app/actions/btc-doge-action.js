/**
 * Bitcoin <> Dogecoin swap action.
 *
 * BTC = SegWit P2WPKH; DOGE = legacy P2PKH (no native SegWit), so the DOGE leg
 * fetches each input's previous transaction for nonWitnessUtxo signing. Both
 * via @scure/btc-signer. Settles BTC (source) first; fee retained on source.
 *
 * NOTE: the Dogecoin testnet explorer API base in lib/networks.js is a
 * placeholder and must point at a working endpoint before live use.
 */
import { assembleAction } from './lib/assemble.js';

export function getBtcDogeActionCode(salt, source = 'bitcoin-signet', dest = 'dogecoin-testnet') {
  return assembleAction({
    salt, source, dest,
    settleOrder: ['source', 'dest'],
    feeLeg: 'source',
    feeMode: 'retain',
  });
}
