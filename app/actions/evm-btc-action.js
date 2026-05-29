/**
 * EVM <> Bitcoin swap action.
 *
 * BTC signing: @scure/btc-signer (audited, P2WPKH SegWit). EVM signing:
 * micro-eth-signer. Settles the BTC (dest) leg first — slower finality —
 * then the EVM leg; fee deducted on the EVM source side and paid to owner.
 */
import { assembleAction } from './lib/assemble.js';

export function getEvmBtcActionCode(salt, source = 'base-sepolia', dest = 'bitcoin-signet') {
  return assembleAction({
    salt, source, dest,
    settleOrder: ['dest', 'source'],
    feeLeg: 'source',
    feeMode: 'send-evm',
  });
}
