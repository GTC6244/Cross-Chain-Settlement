/**
 * EVM <> Zcash (transparent) swap action.
 *
 * ZEC signing: in-action ZIP-243 shim (@noble/hashes BLAKE2b + @noble/curves
 * secp256k1) — see lib/zec-leg.js. EVM signing: micro-eth-signer. Settles ZEC
 * (dest) first; fee on EVM source, paid to owner.
 *
 * NOTE: the ZEC transparent path is unverified and must be checked on testnet.
 */
import { assembleAction } from './lib/assemble.js';

export function getEvmZecActionCode(salt, source = 'base-sepolia', dest = 'zcash-testnet') {
  return assembleAction({
    salt, source, dest,
    settleOrder: ['dest', 'source'],
    feeLeg: 'source',
    feeMode: 'send-evm',
  });
}
