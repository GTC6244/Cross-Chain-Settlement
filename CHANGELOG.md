# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Security
- Before you fund a solver's quote, the app now derives the deposit address from
  the swap's audited code (via your Lit key) and confirms it matches the on-chain
  address — a green "code verified" badge alone is no longer enough to fund. Closes
  an issue where a solver could post real audited code but a deposit address it
  controlled (audit H-1).
- The app also cross-checks the on-chain swap against the intent you announced
  (receive address, amount, fee, and that the floor wasn't lowered) and refuses to
  fund on any mismatch (audit H-2).
- The contract rejects empty role/deposit address strings in `createSwap`, so a swap
  can't be bricked or misrouted by a missing address (audit L-2).

### Added
- **First real cross-chain swaps, settled live.** An EVM↔EVM swap on Base mainnet
  and an EVM↔Bitcoin swap (Base mainnet ↔ signet) both ran end to end through the
  Lit Action: both legs settled on-chain, fee paid, swap marked executed, and a
  signed receipt returned. The Bitcoin leg broadcast a real, valid signet
  transaction — the first live exercise of the `@scure/btc-signer` path.
- The contract is deployed on **Base mainnet** (`0xC0a9c217e643DbdF1b6195a18C0802a1231507A1`),
  with `CONTRACT_ADDRESS` + `CONTRACT_DEPLOY_BLOCK` wired into `app/lib/contract.js`.
- Two-sided market. Post a swap as an *intent* (what you'll send, the minimum
  you'll accept) and let solvers compete to fill it. You compare their quotes and
  fund the best one — nothing is escrowed until you choose.
- Solver app (`app/solver.html`): browse an on-chain order book of open intents,
  quote a price at or above each floor, build the swap, fund the destination leg,
  and settle — all from your own wallet.
- On-chain order book with no backend: a client-side scan of `IntentAnnounced` /
  `SwapCreated` events. Truncated scans are shown plainly so you never act on a
  partial book.
- Per-quote CID verification in the user app: before you fund, the chosen swap's
  code is recomputed from its salt and checked against the audited template (funding
  is blocked on a mismatch).
- `announceIntent` (stateless order-book event) and `getSwapIntent` contract
  functions; `contracts/script/Deploy.s.sol` to deploy and print the values to wire up.
- "Settled" design system (`DESIGN.md`) as the project's design source of truth:
  light-first warm canvas, honey-gold accent, and Fraunces / General Sans /
  JetBrains Mono with mono reserved for technical-truth values (addresses, CIDs,
  tx hashes, raw amounts).
- Dark-mode toggle in the web app, with no-flash pre-paint theme init,
  `localStorage` persistence, and `prefers-color-scheme` / `prefers-reduced-motion`
  support.
- "No one holds your funds" trust panel and a hero headline on the Create tab,
  stating the TEE custody model in plain language.
- Design-system rule in `CLAUDE.md` (read `DESIGN.md` before any UI change).

### Changed
- The Lit Action now settles **one step per invocation** (settle a leg, pay the
  fee, or finalize) and returns until the swap is fully executed. This keeps each
  run within the Lit sandbox's outbound-HTTP budget, which a cross-chain swap (with
  a Bitcoin leg's extra API calls) would otherwise blow. The execute flow in the
  solver app is now "invoke, watch the contract, invoke again until executed."
- The EVM signer no longer waits for each transaction's receipt inside the action.
  Safety comes from nonce ordering instead — the finalize transaction can't be
  mined until every value transfer before it has — which is both faster and
  cheaper on outbound calls.
- Split the single-page app into two role-scoped apps (`index.html` user,
  `solver.html` solver) sharing one design system (`app/settled.css`) and one
  shared ES-module core (`app/lib/*`). The user app is now Announce → Quotes →
  Status; the solver app is Order Book → Quote → My Fills.
- `createSwap` now records a solver's fill: it takes the intent id, the real
  `destAmount` (enforced at or above the user's `minDestAmount` floor), the four
  role addresses, and the salt; `getSwapAddresses` returns all four addresses.
- The settlement engine now uses a four-address model, so a real two-party swap
  settles and refunds to the correct chain for each party.
- Re-skinned `app/index.html` to the Settled system: theme-aware buttons, inputs,
  tabs, status boxes, badges, and empty states. All swap functionality, element
  IDs, event handlers, and `ActionTemplates` wiring preserved.
- Renamed the app wordmark from "Action Swaps" to "Settled".
- Corrected the custody-model copy in `README.md` and the UI to TEE +
  root-of-trust: each swap's signing key is generated and used only inside a
  Trusted Execution Environment, attested by a root-of-trust system. No one,
  not even Lit, can extract it. (Previously described as threshold / decentralized
  cryptography, which was inaccurate.)

### Removed
- Webhooks and the gas-preview tab, which lived in the retired single-wallet
  `swap-engine.js`. (May return in the role-scoped apps later.)

### Fixed
- Three bugs that only surfaced when the action first ran live against a real Lit
  node (the unit tests run a simplified copy, so they couldn't catch these):
  derive mode crashed before returning deposit addresses; every Bitcoin-family
  pair failed because of a renamed library call (`@scure/btc-signer` dropped
  `utils.pubECDSA`); and EVM value transfers were rejected by the signer over a
  stray `undefined` field. All three would have broken the live apps, not just a test.
- **Latent cross-chain fund-loss bug.** The contract stored only two refund-address
  slots, which the engine used on opposite chains for settle vs refund — safe only in
  the EVM↔EVM demo where one wallet owned every role. A real cross-family swap would
  have refunded to an address on the wrong chain. Now four role-named addresses, with
  settle/refund mapping tests.
- Salt is now a client-random value instead of being derived from the predicted next
  swap id, removing a race when two creators acted at once.
- User/solver funding correctly takes the one-click wallet path for native EVM legs
  (token addresses are now read), and the order-book scan no longer throws on its first
  block-number lookup.
