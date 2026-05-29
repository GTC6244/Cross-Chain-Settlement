/**
 * Zcash (transparent) <> Litecoin swap action — no EVM value leg.
 *
 * ZEC: in-action ZIP-243 shim. LTC: @scure/btc-signer (P2WPKH). Base contract
 * written via micro-eth-signer. Settles LTC (dest, slower confirmation) first;
 * fee retained on the ZEC source side.
 *
 * NOTE: the ZEC transparent path is unverified and must be checked on testnet.
 */
import { assembleAction } from './lib/assemble.js';

export function getZecLtcActionCode(salt, source = 'zcash-testnet', dest = 'litecoin-testnet') {
  return assembleAction({
    salt, source, dest,
    settleOrder: ['dest', 'source'],
    feeLeg: 'source',
    feeMode: 'retain',
  });
}
