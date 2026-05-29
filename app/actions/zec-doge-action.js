/**
 * Zcash (transparent) <> Dogecoin swap action — no EVM value leg.
 *
 * ZEC: in-action ZIP-243 shim. DOGE: @scure/btc-signer legacy P2PKH (fetches
 * previous txs for nonWitnessUtxo signing). Base contract written via
 * micro-eth-signer. Settles DOGE (dest) first; fee retained on the ZEC source.
 *
 * NOTE: both the ZEC transparent path and the Dogecoin testnet API base are
 * unverified and must be checked on testnet.
 */
import { assembleAction } from './lib/assemble.js';

export function getZecDogeActionCode(salt, source = 'zcash-testnet', dest = 'dogecoin-testnet') {
  return assembleAction({
    salt, source, dest,
    settleOrder: ['dest', 'source'],
    feeLeg: 'source',
    feeMode: 'retain',
  });
}
