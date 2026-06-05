/**
 * jsDelivr ESM import composer for Lit Action templates.
 *
 * Lit Actions may only import npm packages from jsDelivr, must ship native
 * ESM, avoid Node built-ins, and pin exact versions. All signing libraries
 * here are Paul Miller's audited noble/scure/micro family.
 *
 * Every action imports micro-eth-signer + @scure/base because the swap
 * contract lives on Base (an EVM chain) and the action must sign the
 * markLegSettled / markExecuted / markRefunded calls regardless of which
 * chains the swap itself moves value on.
 *
 * NOTE: the exact jsDelivr `+esm` subpath URLs (especially noble subpaths)
 * are a thing to confirm resolve correctly in the live Lit runtime.
 */

const PIN = {
  btcSigner: '@scure/btc-signer@2.2.0',
  base: '@scure/base@1.1.9',
  hashes: '@noble/hashes@1.5.0',
  curves: '@noble/curves@1.6.0',
  ethSigner: 'micro-eth-signer@0.18.1',
  solSigner: 'micro-sol-signer@0.8.2',
};

const url = (pkgPath) => `https://cdn.jsdelivr.net/npm/${pkgPath}/+esm`;

/**
 * @param {object} need - which leg families this action uses
 * @param {boolean} [need.utxo] - any @scure/btc-signer leg (BTC/LTC/DOGE)
 * @param {boolean} [need.zec]  - Zcash transparent (ZIP-243 shim)
 * @param {boolean} [need.sol]  - Solana
 * @returns {string} import lines for the top of the action
 */
export function importsSrc(need = {}) {
  const lines = [
    // Always: EVM signing for the Base contract + hex/base encoders.
    `import { addr as ethAddr, Transaction as EthTx, eip191Signer } from "${url(PIN.ethSigner)}";`,
    `import { hex, base58, base64, base58check } from "${url(PIN.base)}";`,
  ];
  if (need.utxo) {
    lines.push(`import * as btc from "${url(PIN.btcSigner)}";`);
  }
  if (need.zec) {
    lines.push(`import { blake2b } from "${url(PIN.hashes + '/blake2b')}";`);
    lines.push(`import { sha256 } from "${url(PIN.hashes + '/sha256')}";`);
    lines.push(`import { ripemd160 } from "${url(PIN.hashes + '/ripemd160')}";`);
  }
  // Both UTXO (p2wpkh/p2pkh pubkey) and Zcash (sighash signing) need secp256k1.
  // Import it once for either so utxo+zec pairs don't double-import.
  if (need.utxo || need.zec) {
    lines.push(`import { secp256k1 } from "${url(PIN.curves + '/secp256k1')}";`);
  }
  if (need.sol) {
    lines.push(`import * as sol from "${url(PIN.solSigner)}";`);
  }
  return lines.join('\n') + '\n';
}
