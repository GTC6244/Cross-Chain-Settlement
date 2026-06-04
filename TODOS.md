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

## Tooling / QA

- **Build the gstack browse + design binaries**
  **Priority:** P3
  Enables automated viewport screenshots during `/ship` and `/design-review`
  (currently skipped — binaries not built, so UI changes need manual eyeballing).

## Completed

- **"Settled" design system + consumer re-skin** — DESIGN.md, app/index.html, CLAUDE.md. **Completed:** 2026-06-04
- **Custody-model copy corrected to TEE + root-of-trust** — README.md + UI. **Completed:** 2026-06-04
