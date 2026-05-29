/**
 * Zcash (transparent) <> Solana swap action — no EVM value leg.
 *
 * ZEC: in-action ZIP-243 shim. SOL: micro-sol-signer (Ed25519 seed). Base
 * contract written via micro-eth-signer. Settles ZEC (source) first; fee
 * retained on source.
 *
 * NOTE: the ZEC transparent path is unverified and must be checked on testnet.
 */
import { assembleAction } from './lib/assemble.js';

export function getZecSolActionCode(salt, source = 'zcash-testnet', dest = 'solana-devnet') {
  return assembleAction({
    salt, source, dest,
    settleOrder: ['source', 'dest'],
    feeLeg: 'source',
    feeMode: 'retain',
  });
}
