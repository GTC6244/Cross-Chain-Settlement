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

- **Inputs use 14px font (<16px → iOS zoom-on-focus)**
  **Priority:** P3
  Bump form inputs to 16px or add a mobile-specific rule to stop iOS from
  zooming when a field is focused.

- **Self-host General Sans if a CSP locks font origins**
  **Priority:** P3
  General Sans loads from the Fontshare CDN. If font sources are locked down,
  self-host it. Do not fall back to Inter (see `DESIGN.md`).

## Two-Sided Market (RFQ)

Splitting the single UI into a user (intent) interface + a solver (quote) interface.
Full plan: `docs/plans/two-sided-rfq-plan.md`. ENG + DESIGN reviewed/cleared.

- **Implement the two-sided market (signed-intent + solver-builds-swap)**
  **Priority:** P2
  Lane A first: contract `F1` four-address fix (`userRefundSource`/`userReceiveDest`/
  `solverReceiveSource`/`solverRefundDest`) + stateless `announceIntent` event +
  `createSwap` gains `intentId`/`minDestAmount` + Foundry tests + audit-the-diff. Then
  engine 4-address mapping + floor assert (`engine.js`), then split `index.html`
  (user) and new `solver.html` from a shared `app/lib/*` core. Settlement state machine
  stays UNCHANGED. Design spec (order book = warm ledger rows, deliberate fund, pro
  density) is in the plan.

- **F1: four-address model is a latent cross-chain bug (fix even if RFQ slips)**
  **Priority:** P1
  `engine.js` uses `refundAddressSource`/`refundAddressDest` on opposite chains in
  settle vs refund paths. Only safe today because the demo points all four roles at one
  EVM wallet on EVM↔EVM. A real cross-family swap refunds to the wrong chain → lost
  funds. Needs the four role-named addresses + a mapping test.

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

- **"Settled" design system + consumer re-skin** — DESIGN.md, app/index.html, CLAUDE.md. **Completed:** 2026-06-04
- **Custody-model copy corrected to TEE + root-of-trust** — README.md + UI. **Completed:** 2026-06-04
