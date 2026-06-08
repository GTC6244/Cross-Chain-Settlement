# TODOS

Organized by component, then priority (P0 highest → P4 lowest). Completed items
move to the bottom.

## Security

- **Rotate the leaked Base Alchemy RPC key**
  **Priority:** P0
  The keyed Base RPC (`BASE_ALCHEMY_RPC`) was committed in git history (`main`,
  commit `1788def`) and is still live. It was removed from the working tree (the
  action CID is now key-free), but the secret remains in history and is in use
  locally (`.env`, the `.context/zec-live/run.mjs` driver). Generate a new
  Alchemy key, swap it into `.env`, and revoke the old one. Until then, treat the
  Base RPC as compromised.

- **Zcash consensus `branchId` defaults will go stale**
  **Priority:** P2
  `networks.js` hardcodes `zcash-mainnet`/`zcash-testnet` `branchId = 5437f330`
  (current as of 2026-06; both nets are past NU6 `c8e71055`). This value is only
  used by styles that can't live-fetch (`blockbook`/`insight`); a stale value
  makes every ZEC tx fail `mandatory-script-verify-flag-failed` (it cost the
  first swap #14 attempt). Robust fix: for any ZEC leg, ALWAYS use a live-fetching
  provider (`zcashd`/`tatum` style — the shipped hybrid does this), and/or add a
  CI check that compares the hardcoded id against a live `getblockchaininfo`.

## Chain Verification

These are the real production blockers. The engine state machine (`runSwap`) and
UTXO coin-selection math are unit-tested, but in-sandbox signing/broadcast for each
pair runs only in the Lit runtime and is not covered by the Node tests.

- **Verify in-sandbox signing/broadcast on live for the remaining pairs**
  **Priority:** P1
  Done live (full settle path): EVM↔EVM (Base mainnet), EVM↔BTC (Base mainnet ↔
  signet), EVM↔SOL (Base mainnet ↔ Solana devnet — swap 13, 2026-06-07), and
  **EVM↔ZEC (Base mainnet ↔ Zcash mainnet, swap #14, 2026-06-08)** — the ZEC
  transparent ZIP-243 signer is now proven on a live network, not just regtest.
  `derive` mode verified live for all 11 pairs. Still need a live settle: the
  remaining Zcash pairs (`btc-zec`, `zec-sol`, `zec-ltc`, `zec-doge`), the
  remaining Solana pairs (`btc-sol`, `zec-sol`), and Bitcoin↔Litecoin /
  Bitcoin↔Dogecoin. (LTC/DOGE reuse the proven BTC UTXO leg, and btc-sol/zec-sol
  reuse the now-proven SOL leg, so they're lower-risk.) Each needs BOTH legs'
  providers wired — and any ZEC leg needs the hybrid (see the Zcash item).

- **Wire a live Zcash provider for the ZEC pairs**
  **Priority:** P1
  ZIP-243 shim is verified on regtest only. `evm-zec`, `btc-zec`, `zec-sol`,
  `zec-ltc`, `zec-doge` need a live provider before production.
  **Update (2026-06-07):** the leg now accepts a runtime-injected provider via
  the `legApiConfig` js_param (key-free, mirrors EVM's `legRpcUrls`) and supports
  `blockbook` (NOWNodes/GetBlock REST) and `tatum` (the Tatum RPC gateway) styles
  alongside `zcashd`/`insight`. All parsing is unit-tested (`test/zec-leg.test.js`,
  11 tests).
  **Tatum verified live** against `zcash-testnet.gateway.tatum.io`: broadcast,
  confirmations, and branch-id all work — and the gateway live-resolved the
  branch id to **5437f330** (testnet is PAST NU6 `c8e71055`; networks.js default
  corrected). BUT Tatum can NOT list a t-address's UTXOs (gateway node has no
  address index; Tatum's v4 Data API serves only btc/ltc/doge/cardano, not zcash;
  `/rest` 404s). So the `tatum` style delegates UTXO listing to `api.utxoApi`.
  Dead endpoints (`explorer.testnet.z.cash`, blockchair) confirmed dead; Trezor
  blockbook is Cloudflare-walled (unusable from the Lit sandbox).
  **MAINNET: RESOLVED (2026-06-08).** The hybrid is `{ style:'tatum',
  rpc:'https://zcash-mainnet.gateway.tatum.io', apiKey, utxoApi:{
  style:'blockbook', base:'https://zecbook.nownodes.io', apiKeyHeader:'api-key',
  apiKey } }` — Tatum gateway live-fetches the branch id + broadcasts + confirms;
  NOWNodes mainnet blockbook lists UTXOs. Proven by swap #14. The solver builds
  it from `localStorage.zecProviderKeys` via `zecHybridProvider` (keys in `.env`).
  **TESTNET: still blocked on a UTXO source.** NOWNodes has NO Zcash *testnet*
  blockbook (only mainnet), Tatum's testnet gateway has no address index, and the
  public explorers are dead — so no hosted provider can list testnet ZEC UTXOs.
  Testnet ZEC verification needs a **self-hosted zebrad/zcashd with the address
  index** (`-insightexplorer`; zebra supports `getaddressutxos`), exposed to the
  Lit sandbox via a public URL/tunnel (the action runs server-side, not local).
  Verify any provider with `.context/zec-verify/verify-live.mjs`; full results in
  `.context/zec-verify/LIVE-HANDOFF.md`.

- **Litecoin testnet verification**
  **Priority:** P2
  `evm-btc` is now verified live on signet. `btc-ltc` and `btc-sol` still need a
  live run (same UTXO leg as BTC, just different network params).

- **Production: enforce a contract-side confirmation-depth floor**
  **Priority:** P2
  DONE (solver side, 2026-06-08): the solver no longer hardcodes `1` —
  `confirmationBlocksFor(source, dest)` in `app/lib/derive.js` picks a chain-aware
  depth (zcash-mainnet 5; BTC/LTC 4, DOGE 10 via family fallback for future
  mainnet chains; testnets 1; floored at 1). Unit-tested in `test/lib.test.js`.
  STILL TODO: the contract enforces no minimum, so a hand-crafted `createSwap`
  could still pass a gate-disabling `0`. Add a contract-side
  `require(confirmationBlocks >= MIN)` for swaps with a UTXO/ZEC leg.
  (Adversarial review F1+F2, 2026-06-07.)

- **Confirmation-wait budget is per-swap, not per-leg**
  **Priority:** P3
  `MAX_CONF_WAITS` in the solver step loop is one counter shared across both legs;
  a two-UTXO-leg swap (btc-ltc, btc-doge) that confirms one leg slowly can exhaust
  the budget before the second leg is polled to depth. Scale the budget by the
  number of confirmation-gated legs, or track per-leg. Funds still recover via the
  expiry refund, so this is a liveness/UX issue, not a loss. (Adversarial review F6.)

- **Dogecoin testnet + broadcast API**
  **Priority:** P2
  `btc-doge` needs testnet verification and a DOGE broadcast API.

- **Solana devnet verification**
  **Priority:** P2
  `evm-sol` is now VERIFIED LIVE (Base mainnet ↔ devnet, swap 13, 2026-06-07 —
  settle + sweep + signed receipt, no funds stranded). `btc-sol` and `zec-sol`
  still need a live run (same SOL leg, now proven; btc-sol is zero-mainnet-spend:
  signet + devnet). Note: public devnet faucet was rate-limited/dry — funding the
  action's SOL deposit needed an external airdrop (faucet.solana.com needs GitHub
  auth).

## Web App (UI)

- **Deeper consumer UX pass: single guided swap flow**
  **Priority:** P2
  Collapse the 5 tabs (Create / Status / Execute / Gas Preview / Verify CID) into
  one guided swap-card flow with progressive disclosure, per the design vision.
  Reference mockup: `~/.gstack/projects/cross-chain-settlement/designs/swap-app-20260604/finalized.html`.

- **Self-host General Sans if a CSP locks font origins**
  **Priority:** P3
  General Sans loads from the Fontshare CDN. If font sources are locked down,
  self-host it. Do not fall back to Inter (see `DESIGN.md`).

## Two-Sided Market (RFQ)

The two-sided market (signed-intent + solver-builds-swap) shipped on `GTC6244/seattle`.
Full plan: `docs/plans/two-sided-rfq-plan.md`. Remaining is deployment + live
verification (see Chain Verification) and the phase-2 items below.

- **Phase-2: competitive price auction**
  **Priority:** P3
  v1 competition is "each solver builds a swap with its quote; user funds the best."
  Real price discovery, but each quote costs the solver gas. A formal on-chain timed
  auction or off-chain RFQ relay would tighten spreads. Deferred until solver behavior
  is observed in v1.

- **Phase-2: gasless quote channel**
  **Priority:** P3
  Today a solver pays gas to `createSwap` even for a quote the user doesn't pick. A
  signed-quote relay (solver posts a signed offer, only the winning quote hits the
  chain) removes that cost and lowers the barrier to quoting. Depends on the v1 model
  shipping first.

- **Phase-2: real-time order book (push instead of poll)**
  **Priority:** P3
  v1 order book is a client-side `getLogs` scan on an interval + manual refresh, with a
  visible "some may be missing — rescanning" state on RPC range limits. A websocket /
  push feed (or a light indexer) would make it live. Keep the no-backend constraint in
  mind — evaluate public relays before standing up a server.

## Tooling / QA

- **Build the gstack browse + design binaries**
  **Priority:** P3
  Enables automated viewport screenshots during `/ship` and `/design-review`
  (currently skipped — binaries not built, so UI changes need manual eyeballing).

## Completed

- **First live EVM↔ZEC settlement (Zcash mainnet)** — swap #14: Base-mainnet EVM leg `0x58dbf3bc…73b227` + ZEC payout `34a0a653…2112c4` (0.001 ZEC), `markExecuted` + signed receipt. First live exercise of the transparent ZIP-243 signer (previously regtest-only). Added a `zcash-mainnet` chain config, `base`/`zcash-mainnet` routing, a `tatum` provider style + `utxoApi` delegation, and a `blockbook` style; working provider is the Tatum-gateway + NOWNodes-blockbook hybrid (built by `zecHybridProvider` from `localStorage.zecProviderKeys`). Found + fixed: mainnet/testnet branch id is `5437f330` (past NU6) — a stale `c8e71055` failed `mandatory-script-verify`; fixed via runtime live-fetch without changing the swap's CID. Solver now sets a chain-aware `confirmationBlocks`. UI gained mainnet chain options + Base-mainnet contract switching. Tests +14 (zec-leg 11, lib +5). **Completed:** 2026-06-08
- **Production: confirmation pass for UTXO/ZEC legs before finalize** — added a confirmation gate in `runSwap`: once both legs are settled and the fee is paid, each leg that exposes `confirmations()` (UTXO + ZEC) must reach the swap's `confirmationBlocks` depth before the terminal `markExecuted`. EVM legs are skipped (nonce ordering already protects them). Fail-closed: a lookup error/throw counts as 0 confirmations and defers finalize, never passes an unconfirmed payment through. New `confirmations()` on the UTXO leg (esplora `/tx/:id/status` + tip, or blockchair) and ZEC leg (zcashd `getrawtransaction`/insight). Solver app re-invokes on `awaiting_confirmations` (own wait budget, ~8 min). Late-fail recovery is the existing expiry refund. Engine tests +5. (Also fixed a latent `MAX_INVOCATIONS` ReferenceError in the solver step loop.) **Completed:** 2026-06-07
- **Production: leg RPC injected via params, action CID is key-free** — `makeEvmLeg` now prefers `params.legRpcUrls[chain]` over the embedded default; `networks.js` `base` rpc is a key-free public node (`base-rpc.publicnode.com`); the dead `EVM_RPC` embed was removed. Solver app passes `legRpcUrls: CHAIN_RPC`. A generated base-mainnet action carries no API key (verified). **NOTE:** the old Alchemy key was committed in `1788def` (on `main`) — it is in git history and MUST be rotated. **Completed:** 2026-06-07
- **First live cross-chain settlement: EVM↔BTC** — Base mainnet (EVM) ↔ signet (BTC), both legs settled + signed receipt; real signet tx broadcast (first live `@scure/btc-signer` exercise). **Completed:** 2026-06-05
- **First live EVM↔EVM settlement on Base mainnet** — full settle path (both legs, fee, markExecuted, signed receipt). **Completed:** 2026-06-05
- **One-step-per-invocation engine (HTTP-frugal)** — fixed the intermittent 500s (Lit sandbox ~24-call HTTP cap); each `execute` does one step, caller invokes-then-polls. Solver app updated. **Completed:** 2026-06-05
- **Live-execution bug fixes** — derive-mode crash, UTXO `pubECDSA` rename, EVM signer `undefined` data field. **Completed:** 2026-06-05
- **Contract deployed to Base mainnet** — `0xC0a9c217e643DbdF1b6195a18C0802a1231507A1`, wired into `app/lib/contract.js`. **Completed:** 2026-06-05
- **Two-sided market: user + solver apps (signed-intent + solver-builds-swap)** — contract `announceIntent`/`createSwap`, engine 4-address mapping + floor assert, shared `app/lib/*`, `index.html` + `solver.html`, deploy script. **Completed:** 2026-06-05
- **F1: four-address model (latent cross-chain bug)** — `SwapContract.sol` + `engine.js` + mapping tests. **Completed:** 2026-06-05
- **Inputs bumped to 16px (no iOS zoom-on-focus)** — `app/settled.css`. **Completed:** 2026-06-05
- **"Settled" design system + consumer re-skin** — DESIGN.md, app/index.html, CLAUDE.md. **Completed:** 2026-06-04
- **Custody-model copy corrected to TEE + root-of-trust** — README.md + UI. **Completed:** 2026-06-04
