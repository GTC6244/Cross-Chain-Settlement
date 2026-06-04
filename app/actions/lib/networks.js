/**
 * Chain registry for the Cross-Chain-Settlement Lit Actions.
 *
 * This module is the single source of truth for every chain's parameters:
 * signing family, address type, network version bytes, block-explorer API
 * endpoints, dust thresholds, and fee conventions.
 *
 * It is a normal ES module (imported by the action templates and by
 * swap-engine.js in the browser). `chainConfigSrc()` serializes the relevant
 * subset into a code string that gets embedded *inside* the Lit Action, since
 * action code runs in the Lit sandbox and cannot import local files — only
 * jsDelivr ESM URLs.
 *
 * Testnet values throughout. Anything here that touches the live network
 * (API base URLs, Zcash consensus branch id, fee rates) is the part that
 * needs verification on a live testnet before production use.
 */

export const CHAINS = {
  // ---- EVM (secp256k1, signed with micro-eth-signer) --------------------
  'base-sepolia':      { family: 'evm', rpc: 'https://sepolia.base.org',            chainId: 84532 },
  'ethereum-sepolia':  { family: 'evm', rpc: 'https://rpc.sepolia.org',             chainId: 11155111 },
  'arbitrum-sepolia':  { family: 'evm', rpc: 'https://sepolia-rollup.arbitrum.io/rpc', chainId: 421614 },
  'optimism-sepolia':  { family: 'evm', rpc: 'https://sepolia.optimism.io',         chainId: 11155420 },

  // ---- Bitcoin (secp256k1, P2WPKH SegWit, @scure/btc-signer) ------------
  'bitcoin-signet': {
    family: 'utxo',
    addrType: 'p2wpkh',
    network: { bech32: 'tb', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef },
    api: { style: 'esplora', base: 'https://mempool.space/signet/api' },
    dust: 546,
    amountField: 'value',     // esplora UTXO amount field
    feeRateField: 'halfHourFee',
    defaultFeeRate: 2,        // sat/vByte
    minFee: 0,
    decimals: 8,
  },

  // ---- Litecoin (secp256k1, P2WPKH SegWit, @scure/btc-signer) -----------
  // Litecoin testnet4. Esplora-compatible explorer at litecoinspace.org.
  'litecoin-testnet': {
    family: 'utxo',
    addrType: 'p2wpkh',
    network: { bech32: 'tltc', pubKeyHash: 0x6f, scriptHash: 0x3a, wif: 0xef },
    api: { style: 'esplora', base: 'https://litecoinspace.org/testnet/api' },
    dust: 546,
    amountField: 'value',
    feeRateField: 'halfHourFee',
    defaultFeeRate: 2,
    minFee: 0,
    decimals: 8,
  },

  // ---- Dogecoin (secp256k1, LEGACY P2PKH only — no native SegWit) -------
  // Dogecoin has no widely-deployed bech32/SegWit, so legacy P2PKH + the
  // full previous-tx (nonWitnessUtxo) is required when signing.
  // Testnet UTXO API endpoints are sparse; this base must be confirmed live.
  'dogecoin-testnet': {
    family: 'utxo',
    addrType: 'p2pkh',
    network: { bech32: null, pubKeyHash: 0x71, scriptHash: 0xc4, wif: 0xf1 },
    api: { style: 'blockchair', base: 'https://api.blockchair.com/dogecoin/testnet' },
    dust: 1000000,            // Dogecoin dust/min-output is high (~0.01 DOGE)
    amountField: 'value',
    feeRateField: null,
    defaultFeeRate: 1000,     // koinu/byte — DOGE fees are large in absolute units
    minFee: 100000000,        // ~1 DOGE min fee is common on Dogecoin
    decimals: 8,
  },

  // ---- Zcash transparent (secp256k1 t-addr, ZIP-243 sighash shim) -------
  // NOT signable by @scure/btc-signer — uses the custom zcash leg.
  // pubKeyHash2/scriptHash2 are the 2-byte t-address version prefixes.
  //
  // The ZIP-243 v4 sighash + serialization is VERIFIED correct against zcashd
  // 6.20.0 regtest (see .context/zec-verify/FINDINGS.md). v4 is still accepted
  // post-NU5/NU6. TWO things remain deployment-critical:
  //   1. branchId MUST equal the chain's ACTIVE consensus branch id, or every
  //      tx fails mandatory-script-verify (the branch id feeds the sighash).
  //      Branch ids:  Sapling 76b809bb | Blossom 2bb40e60 | Heartwood f5b9230b
  //                   Canopy  e9ff75a6 | NU5 c2d6d0b4 | NU6 c8e71055
  //      Default below is NU6 (mainnet since Nov 2024; testnet is NU6+). If the
  //      target chain has activated a later upgrade, update this. The robust
  //      fix is to fetch consensus.nextblock from a node at runtime.
  //   2. Both explorer endpoints below are DEAD (explorer.testnet.z.cash DNS
  //      gone; blockchair has no zcash testnet). Wire a working provider before
  //      live use. The zec leg supports a self-hosted node directly:
  //        api: { style: 'zcashd', rpc: '<url>', rpcAuth: 'Basic <b64 user:pass>' }
  //      (run zcashd with -insightexplorer for getaddressutxos). The zcashd
  //      style ALSO resolves the branch id live (getblockchaininfo →
  //      consensus.nextblock), so branchId above is then only a fallback.
  //      Verified end-to-end against a self-hosted regtest node — see
  //      .context/zec-verify/harness/verify-node.mjs.
  'zcash-testnet': {
    family: 'zec',
    addrType: 't-p2pkh',
    pubKeyHash2: [0x1d, 0x25],   // tm... transparent testnet
    scriptHash2: [0x1c, 0xba],
    api: { style: 'insight', base: 'https://explorer.testnet.z.cash/api',
           fallback: 'https://api.blockchair.com/zcash/testnet' }, // DEAD — see note above
    dust: 5460,
    amountField: 'satoshis',
    txVersion: 4,                // Sapling v4 (ZIP-243)
    versionGroupId: 0x892f2085,  // Sapling version group id
    branchId: 0xc8e71055,        // NU6 consensus branch id — MUST match active upgrade
    // Fees follow ZIP-317 (zip317Fee in the zec leg), not these sat/byte values;
    // kept only for reference. dust is the only field the zec leg still reads.
    defaultFeeRate: 10,          // zat/byte (unused — ZIP-317 conventional fee applies)
    minFee: 1000,                // zatoshis (unused)
    decimals: 8,
  },

  // ---- Solana (Ed25519 seed from the same 32-byte key, micro-sol-signer)
  'solana-devnet': {
    family: 'sol',
    rpc: 'https://api.devnet.solana.com',
    lamportsPerSol: 1000000000,
    decimals: 9,
  },
};

/** EVM rpc lookup, embedded for the engine's contract + EVM-leg use. */
export function evmRpcMap() {
  const m = {};
  for (const [id, c] of Object.entries(CHAINS)) {
    if (c.family === 'evm') m[id] = { rpc: c.rpc, chainId: c.chainId };
  }
  return m;
}

/**
 * Emit a code string that defines `var CHAINS = {...}` inside the action.
 * Pass the chain ids the action actually uses to keep the embed minimal.
 */
export function chainConfigSrc(ids) {
  const subset = {};
  for (const id of ids) {
    if (!CHAINS[id]) throw new Error(`Unknown chain id: ${id}`);
    subset[id] = CHAINS[id];
  }
  // Always include the EVM rpc map (the contract lives on Base/EVM and every
  // action needs to read/write it regardless of the swap's chains).
  return `var CHAINS = ${JSON.stringify(subset)};\nvar EVM_RPC = ${JSON.stringify(evmRpcMap())};\n`;
}
