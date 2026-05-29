/**
 * EVM <> Solana swap action.
 *
 * SOL signing: micro-sol-signer, using the action's 32-byte key as an Ed25519
 * seed (same secret as the EVM/secp256k1 side, different address). EVM signing:
 * micro-eth-signer. Settles SOL (dest) first; fee on EVM source, paid to owner.
 */
import { assembleAction } from './lib/assemble.js';

export function getEvmSolActionCode(salt, source = 'base-sepolia', dest = 'solana-devnet') {
  return assembleAction({
    salt, source, dest,
    settleOrder: ['dest', 'source'],
    feeLeg: 'source',
    feeMode: 'send-evm',
  });
}
