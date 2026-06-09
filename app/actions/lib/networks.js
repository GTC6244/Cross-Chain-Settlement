/**
 * Chain registry for the Cross-Chain-Settlement Lit Actions.
 *
 * This module is the single source of truth for every chain's parameters:
 * signing family, address type, network version bytes, block-explorer API
 * endpoints, dust thresholds, and fee conventions.
 *
 * It is a normal ES module (imported by the action templates and by the
 * browser apps via app/lib/templates.js). `chainConfigSrc()` serializes the relevant
 * subset into a code string that gets embedded *inside* the Lit Action, since
 * action code runs in the Lit sandbox and cannot import local files — only
 * jsDelivr ESM URLs.
 *
 * RPC endpoints here MUST stay key-free: this subset is embedded in the action
 * code, so its hash IS the published CID — anything here ships to IPFS for
 * anyone to read. The EVM `rpc` values are key-free public nodes used as the
 * default; to point a leg at a private/keyed endpoint at runtime, inject it via
 * the `legRpcUrls` js_param (chainId → url) instead of editing it here. The
 * engine's makeEvmLeg prefers `params.legRpcUrls[chain]` over this default.
 *
 * Testnet values throughout. Anything here that touches the live network
 * (API base URLs, Zcash consensus branch id, fee rates) is the part that
 * needs verification on a live testnet before production use.
 */

export const CHAINS = {
  // ---- EVM mainnet — top chains by activity/volume ----------------------
  // chainIds are canonical registry values. The `rpc` here is a KEY-FREE public
  // default (see header) so it is safe to embed in the action/CID; point a leg
  // at a private/keyed node at runtime via the legRpcUrls js_param instead of
  // editing these. "By volume" is an approximate, time-varying ordering — treat
  // this as a curated set of the major EVM chains, not a live leaderboard.
  //
  // Only chains whose settlement path is PROVEN (standard EIP-1559 type-2 + the
  // 21000 native-transfer gas the engine assumes) are listed here. Six otherwise
  // top chains are EXCLUDED pending a live funded settlement test — see TODOS.md
  // ("EVM chains excluded pending live verification") for the list, the reason,
  // and the re-enable steps. The engine already supports the two fixes those
  // chains need (txType:'legacy' for no-EIP-1559 chains, nativeGasLimit for
  // Arbitrum-class gas), so re-adding each is a config line + one live test.
  'ethereum':      { family: 'evm', rpc: 'https://ethereum-rpc.publicnode.com',         chainId: 1 },
  'bnb-chain':     { family: 'evm', rpc: 'https://bsc-rpc.publicnode.com',              chainId: 56 },
  'base':          { family: 'evm', rpc: 'https://base-rpc.publicnode.com',             chainId: 8453 },
  'polygon':       { family: 'evm', rpc: 'https://polygon-bor-rpc.publicnode.com',      chainId: 137 },
  'optimism':      { family: 'evm', rpc: 'https://optimism-rpc.publicnode.com',         chainId: 10 },
  'avalanche':     { family: 'evm', rpc: 'https://avalanche-c-chain-rpc.publicnode.com', chainId: 43114 },
  'linea':         { family: 'evm', rpc: 'https://linea-rpc.publicnode.com',            chainId: 59144 },
  'scroll':        { family: 'evm', rpc: 'https://scroll-rpc.publicnode.com',           chainId: 534352 },
  'mantle':        { family: 'evm', rpc: 'https://mantle-rpc.publicnode.com',           chainId: 5000 },
  'blast':         { family: 'evm', rpc: 'https://rpc.blast.io',                        chainId: 81457 },
  'gnosis':        { family: 'evm', rpc: 'https://gnosis-rpc.publicnode.com',           chainId: 100 },
  'celo':          { family: 'evm', rpc: 'https://forno.celo.org',                      chainId: 42220 },
  'cronos':        { family: 'evm', rpc: 'https://evm.cronos.org',                      chainId: 25 },
  'sonic':         { family: 'evm', rpc: 'https://rpc.soniclabs.com',                   chainId: 146 },
  'fantom':        { family: 'evm', rpc: 'https://rpc.fantom.network',                  chainId: 250 },
  'moonbeam':      { family: 'evm', rpc: 'https://moonbeam-rpc.publicnode.com',         chainId: 1284 },
  'opbnb':         { family: 'evm', rpc: 'https://opbnb-rpc.publicnode.com',            chainId: 204 },
  'mode':          { family: 'evm', rpc: 'https://mainnet.mode.network',                chainId: 34443 },
  'manta-pacific': { family: 'evm', rpc: 'https://pacific-rpc.manta.network/http',      chainId: 169 },
  'berachain':     { family: 'evm', rpc: 'https://rpc.berachain.com',                   chainId: 80094 },
  'unichain':      { family: 'evm', rpc: 'https://mainnet.unichain.org',                chainId: 130 },
  'world-chain':   { family: 'evm', rpc: 'https://worldchain-mainnet.g.alchemy.com/public', chainId: 480 },
  'taiko':         { family: 'evm', rpc: 'https://rpc.mainnet.taiko.xyz',               chainId: 167000 },
  'sei':           { family: 'evm', rpc: 'https://evm-rpc.sei-apis.com',                chainId: 1329 },

  // ---- EVM testnet (secp256k1, signed with micro-eth-signer) ------------
  // Key-free public default (see header). Override at runtime via legRpcUrls.
  'base-sepolia':      { family: 'evm', rpc: 'https://sepolia.base.org',            chainId: 84532 },
  'ethereum-sepolia':  { family: 'evm', rpc: 'https://ethereum-sepolia-rpc.publicnode.com', chainId: 11155111 }, // was rpc.sepolia.org (404, rpc-smoke)
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
  //   2. The api below is a DEAD key-free placeholder (explorer.testnet.z.cash
  //      DNS gone; blockchair has no zcash testnet — both confirmed dead
  //      2026-06-07). A live run MUST inject a working provider at runtime via
  //      the `legApiConfig` js_param (chainId → api object) — exactly how EVM
  //      legs take legRpcUrls — so no endpoint or key is baked into the action.
  //      The zec leg supports these api styles:
  //        - blockbook: hosted REST from NOWNodes / GetBlock (free tier + key).
  //            { style: 'blockbook', base: '<host>',
  //              apiKeyHeader: 'api-key', apiKey: '<key>' }   // NOWNodes
  //            { style: 'blockbook', base: 'https://go.getblock.io/<token>' } // GetBlock
  //          Endpoints: /api/v2/utxo/:addr, /api/v2/tx/:txid, /api/v2/sendtx/.
  //        - tatum: the Tatum RPC gateway, a zcashd-compatible node. Verified
  //            live (2026-06-07) for broadcast + confirmations + branch-id
  //            (live-resolved — testnet is past NU6, see branchId below). It can
  //            NOT list a t-address's UTXOs: the node has no address index
  //            (getaddressutxos → method not found) and Tatum's v4 Data API does
  //            not serve Zcash (only btc/ltc/doge/cardano). So `tatum` delegates
  //            UTXO listing to api.utxoApi — pair the gateway with a blockbook
  //            (NOWNodes/GetBlock) source:
  //            { style: 'tatum', rpc: 'https://zcash-testnet.gateway.tatum.io',
  //              apiKey: '<tatum-key>',  // x-api-key
  //              utxoApi: { style: 'blockbook', base: '<blockbook-host>',
  //                         apiKeyHeader: 'api-key', apiKey: '<key>' } }
  //        - zcashd: self-hosted node (run with -insightexplorer for
  //            getaddressutxos). { style: 'zcashd', rpc: '<url>',
  //            rpcAuth: 'Basic <b64 user:pass>' }. ALSO resolves the branch id
  //            live (getblockchaininfo → consensus.nextblock), so branchId
  //            above is then only a fallback.
  //        - insight: classic Bitcore explorer (no live public instance known).
  //      ZIP-243 sign/serialize verified end-to-end on a self-hosted regtest
  //      node — see .context/zec-verify/harness/verify-node.mjs. Provider wiring
  //      is exercised by .context/zec-verify/verify-live.mjs.
  'zcash-testnet': {
    family: 'zec',
    addrType: 't-p2pkh',
    pubKeyHash2: [0x1d, 0x25],   // tm... transparent testnet
    scriptHash2: [0x1c, 0xba],
    // DEAD placeholder — override at runtime via legApiConfig (see note above).
    api: { style: 'insight', base: 'https://explorer.testnet.z.cash/api',
           fallback: 'https://api.blockchair.com/zcash/testnet' },
    dust: 5460,
    amountField: 'satoshis',
    txVersion: 4,                // Sapling v4 (ZIP-243)
    versionGroupId: 0x892f2085,  // Sapling version group id
    // Live testnet branch id observed 2026-06-07 via the Tatum gateway
    // (getblockchaininfo → consensus.nextblock = 5437f330) — testnet is PAST NU6
    // (c8e71055). This default is only used by styles that can't live-fetch
    // (blockbook/insight); the zcashd/tatum styles read it live from the node,
    // which is the robust path since testnet activates upgrades ahead of mainnet.
    branchId: 0x5437f330,        // active testnet branch id — MUST match active upgrade
    // Fees follow ZIP-317 (zip317Fee in the zec leg), not these sat/byte values;
    // kept only for reference. dust is the only field the zec leg still reads.
    defaultFeeRate: 10,          // zat/byte (unused — ZIP-317 conventional fee applies)
    minFee: 1000,                // zatoshis (unused)
    decimals: 8,
  },

  // ---- Zcash MAINNET (transparent t1, same ZIP-243 shim as testnet) -----
  // Live mainnet. UTXO/broadcast/confirmations are served by NOWNodes blockbook
  // (zecbook.nownodes.io — verified live 2026-06-08); the api below is the
  // key-free host, the api-key is injected at runtime via legApiConfig so the
  // action CID carries no secret. branchId is NU6 (mainnet active since Nov
  // 2024); blockbook can't live-fetch it, so it's hardcoded here — keep current.
  'zcash-mainnet': {
    family: 'zec',
    addrType: 't-p2pkh',
    pubKeyHash2: [0x1c, 0xb8],   // t1... transparent mainnet P2PKH
    scriptHash2: [0x1c, 0xbd],   // t3... mainnet P2SH
    api: { style: 'blockbook', base: 'https://zecbook.nownodes.io' }, // key-free; key via legApiConfig
    dust: 5460,
    amountField: 'satoshis',
    txVersion: 4,                // Sapling v4 (ZIP-243)
    versionGroupId: 0x892f2085,  // Sapling version group id
    // Live mainnet branch id observed 2026-06-08 via the Tatum gateway
    // (getblockchaininfo → consensus.nextblock = 5437f330) — mainnet is PAST NU6
    // (c8e71055). An earlier c8e71055 here made the FIRST live settle (swap #14)
    // sign with the stale id → mandatory-script-verify-flag-failed; the fix was a
    // runtime `tatum` provider that live-fetches the id. Prefer the zcashd/tatum
    // style (live-fetch) over blockbook-only, since this hardcoded value goes
    // stale at every network upgrade.
    branchId: 0x5437f330,        // active mainnet branch id — MUST match active upgrade
    defaultFeeRate: 10,          // unused — ZIP-317 conventional fee applies
    minFee: 1000,                // unused
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

/**
 * Emit a code string that defines `var CHAINS = {...}` inside the action.
 * Pass the chain ids the action actually uses to keep the embed minimal.
 * The Base contract RPC is injected at runtime (params.baseRpcUrl); EVM leg
 * RPCs default to the key-free `rpc` here and can be overridden per chain via
 * params.legRpcUrls — so no endpoint needs to be embedded for the contract.
 */
export function chainConfigSrc(ids) {
  const subset = {};
  for (const id of ids) {
    if (!CHAINS[id]) throw new Error(`Unknown chain id: ${id}`);
    subset[id] = CHAINS[id];
  }
  return `var CHAINS = ${JSON.stringify(subset)};\n`;
}
