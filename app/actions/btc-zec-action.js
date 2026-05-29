/**
 * Bitcoin <> Zcash (transparent) swap action — no EVM value leg.
 *
 * BTC: @scure/btc-signer. ZEC: in-action ZIP-243 shim. The Base contract is
 * still the source of truth and is written via micro-eth-signer. Settles BTC
 * (source) first; the fee is retained on the ZEC side for batch collection
 * (no EVM payout address available), matching the original design.
 */
import { assembleAction } from './lib/assemble.js';

export function getBtcZecActionCode(salt, source = 'bitcoin-signet', dest = 'zcash-testnet') {
  return assembleAction({
    salt, source, dest,
    settleOrder: ['source', 'dest'],
    feeLeg: 'dest',
    feeMode: 'retain',
  });
}
