/**
 * Bitcoin <> Litecoin swap action — both SegWit P2WPKH via @scure/btc-signer.
 *
 * The cleanest new pair: standard Bitcoin sighash on both sides, only the
 * network params differ. Settles BTC (source, slower finality) first; fee
 * retained on the source side for batch collection (no EVM payout leg). The
 * Base contract is written via micro-eth-signer.
 */
import { assembleAction } from './lib/assemble.js';

export function getBtcLtcActionCode(salt, source = 'bitcoin-signet', dest = 'litecoin-testnet') {
  return assembleAction({
    salt, source, dest,
    settleOrder: ['source', 'dest'],
    feeLeg: 'source',
    feeMode: 'retain',
  });
}
