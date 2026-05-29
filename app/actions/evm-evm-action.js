/**
 * EVM <> EVM swap action.
 *
 * Signing: micro-eth-signer (audited). The ethers global is used only for
 * read-only RPC, nonce, gas, and broadcast. Composed from the shared engine +
 * leg drivers in ./lib.
 */
import { assembleAction } from './lib/assemble.js';

export function getEvmEvmActionCode(salt, source = 'base-sepolia', dest = 'ethereum-sepolia') {
  return assembleAction({
    salt, source, dest,
    settleOrder: ['source', 'dest'],
    feeLeg: 'source',
    feeMode: 'send-evm',
  });
}
