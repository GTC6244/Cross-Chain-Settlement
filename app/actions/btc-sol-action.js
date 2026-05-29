/**
 * Bitcoin <> Solana swap action — no EVM value leg.
 *
 * BTC: @scure/btc-signer (P2WPKH). SOL: micro-sol-signer (Ed25519 seed from
 * the same key). Base contract written via micro-eth-signer. Settles BTC
 * (source, slower) first; fee retained on source (no EVM payout address).
 */
import { assembleAction } from './lib/assemble.js';

export function getBtcSolActionCode(salt, source = 'bitcoin-signet', dest = 'solana-devnet') {
  return assembleAction({
    salt, source, dest,
    settleOrder: ['source', 'dest'],
    feeLeg: 'source',
    feeMode: 'retain',
  });
}
