# TODOS

Organized by component, then priority (P0 highest → P4 lowest). Completed items
move to the bottom.

## Chain Verification

These are the real production blockers. The engine state machine (`runSwap`) and
UTXO coin-selection math are unit-tested, but in-sandbox signing/broadcast for each
pair runs only in the Lit runtime and is not covered by the Node tests.

- **Verify in-sandbox signing/broadcast on live testnets for every pair**
  **Priority:** P1
  Only the engine + UTXO math are exercised by `test/`. The signers and the
  ZIP-243 shim run only inside the Lit runtime and need live verification before
  production use.

- **Wire a live Zcash provider for the ZEC pairs**
  **Priority:** P1
  ZIP-243 shim is verified on regtest only. `evm-zec`, `btc-zec`, `zec-sol`,
  `zec-ltc`, `zec-doge` need a live provider before production.

- **Bitcoin / Litecoin testnet verification**
  **Priority:** P2
  `evm-btc`, `btc-ltc`, `btc-sol` are marked "needs testnet".

- **Dogecoin testnet + broadcast API**
  **Priority:** P2
  `btc-doge` needs testnet verification and a DOGE broadcast API.

- **Solana devnet verification**
  **Priority:** P2
  `evm-sol`, `btc-sol`, `zec-sol` are marked "needs devnet".

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

- **Two-sided market: user + solver apps (signed-intent + solver-builds-swap)** — contract `announceIntent`/`createSwap`, engine 4-address mapping + floor assert, shared `app/lib/*`, `index.html` + `solver.html`, deploy script. **Completed:** 2026-06-05
- **F1: four-address model (latent cross-chain bug)** — `SwapContract.sol` + `engine.js` + mapping tests. **Completed:** 2026-06-05
- **Inputs bumped to 16px (no iOS zoom-on-focus)** — `app/settled.css`. **Completed:** 2026-06-05
- **"Settled" design system + consumer re-skin** — DESIGN.md, app/index.html, CLAUDE.md. **Completed:** 2026-06-04
- **Custody-model copy corrected to TEE + root-of-trust** — README.md + UI. **Completed:** 2026-06-04
