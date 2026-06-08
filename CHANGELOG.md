# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **24 EVM mainnet chains you can pick in the swap selector.** The From/To menus
  now cover the major EVM networks (Ethereum, BNB Chain, Base, Polygon, OP,
  Avalanche, Linea, Scroll, Mantle, Blast, Gnosis, Celo, Cronos, Sonic, Fantom,
  Moonbeam, opBNB, Mode, Manta, Berachain, Unichain, World Chain, Taiko, Sei),
  each with canonical chain ids and key-free public RPC defaults. Six more top
  chains (zkSync Era, Arbitrum, Aurora, Kava, Metis, Polygon zkEVM) are held back
  until a live funded settlement proves them, since their transaction shape
  differs from the proven path (see TODOS).
- **Chain logos in the selectors and explorer.** Each chain now shows its brand
  mark, so you recognise the asset at a glance. The selector is a custom dropdown
  (native menus can't show images) that still behaves like a normal field; a
  logo that fails to load falls back to a small monogram, never a broken image.

### Changed
- **The settlement engine now picks the right transaction type per chain.** It
  signs EIP-1559 (type-2) by default and a legacy (type-0) transaction for chains
  that don't support 1559, plus a per-chain gas limit for chains that price L1
  data into L2 gas. This is the groundwork that lets the six excluded chains be
  switched on with a config line once each is live-verified. The proven
  Base/Ethereum path is unchanged.

### Added
- **Market price quotes in the solver's Quote tab.** When a solver selects an
  intent, a live **Market price** panel now pulls each leg asset's USD spot from
  three independent, key-free sources (CoinGecko, Coinbase, CryptoCompare) and
  shows each source's price, the **median** cross-rate, the fair dest amount for
  the intent's source amount, and how the floor sits versus market. A live
  margin readout under the dest-amount input shows the solver's spread (gross
  margin when quoting below market value, a loss warning above it). Prices are
  advisory display only — the on-chain floor and the solver's judgement still
  govern, and no source is trusted alone. New `app/lib/prices.js` (asset/decimals
  maps, the three sources, `fetchMarketRate`, median/unit helpers) with unit
  coverage for the pure helpers in `test/lib.test.js`.
- First live **EVM↔Zcash mainnet** settlement (swap #14): the transparent
  ZIP-243 signer is now proven on mainnet, not just regtest. The working provider
  is a hybrid — Tatum's RPC gateway live-fetches the consensus branch id
  (mainnet/testnet are past NU6 → `5437f330`; the `zcash-mainnet`/`zcash-testnet`
  `branchId` defaults were corrected, but live-fetch is the robust path) and
  handles broadcast + confirmations, while NOWNodes blockbook lists the
  t-address UTXOs. The solver app now builds this hybrid for `legApiConfig`
  automatically from operator keys in `localStorage.zecProviderKeys`
  (`{"tatumKey":"…","nownodesKey":"…"}`) via the key-free `zecHybridProvider`
  helper — no secret ever touches the repo or the action CID. A `zcash-mainnet`
  chain config and `base`/`zcash-mainnet` routing were added, the user/solver
  apps gained Base-mainnet + Zcash-mainnet chain options (and now switch to Base
  mainnet — not Sepolia — for the contract calls), and the solver sets a
  chain-aware `confirmationBlocks` via `confirmationBlocksFor()` (zcash-mainnet 5,
  BTC/LTC 4, DOGE 10, testnets 1) instead of a hardcoded `1`.
- Zcash legs can now take their provider at runtime via a `legApiConfig`
  js_param (chainId → api object) — the non-EVM analogue of `legRpcUrls`, so the
  published action CID stays free of any keyed endpoint. The ZEC leg gained a
  `blockbook` provider style (the REST shape NOWNodes / GetBlock expose:
  `/api/v2/utxo`, `/api/v2/tx`, `/api/v2/sendtx`) and a `tatum` style (the Tatum
  zcashd-compatible RPC gateway — verified live for broadcast / confirmations /
  live branch-id; it can't enumerate a t-address's UTXOs, so it delegates UTXO
  listing to an `api.utxoApi` blockbook/insight source) alongside the existing
  `zcashd` and `insight` styles, with optional header auth. The zcash-testnet
  `branchId` default was corrected to `5437f330` (testnet is past NU6, observed
  live via the gateway). This unblocks live
  verification of all five ZEC pairs (the previously baked-in public testnet
  explorer is dead). New `test/zec-leg.test.js` covers the blockbook parsing,
  and `.context/zec-verify/verify-live.mjs` validates a provider before a live
  settle. A live EVM↔ZEC run still needs a provider key + testnet funds (TAZ).

### Security
- The published Lit Action no longer carries any RPC API key. The leg RPC is now
  injected at runtime via a `legRpcUrls` param (chain → url), and the endpoint
  baked into the action code is a key-free public node — so the action's IPFS
  CID, which anyone can read, exposes no secret. (A keyed endpoint had been
  embedded in `networks.js` and serialized into the action.)
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
- A swap with a Bitcoin/Litecoin/Dogecoin/Zcash leg is no longer marked executed
  the instant its payout broadcasts. The settlement now waits for that
  transaction to reach the swap's required confirmation depth before finalizing,
  so a payout that never confirms can't leave the swap recorded as complete.
  (EVM legs were already safe — their nonce ordering guarantees finalize can't
  land before the transfers.) If the explorer can't be reached, finalize waits
  rather than assuming success. Re-org protection scales with the configured
  confirmation depth; the depth is per-swap (see TODOS for raising the default
  past one confirmation on UTXO chains before mainnet use).

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
- Read-only **Swaps Explorer** (`app/explorer.html`): a third view that lists every
  swap the contract has recorded and expands each row to its full on-chain record —
  state, the four role addresses, both deposit addresses, per-leg and fee settlement
  (with tx hashes), the Lit Action CID/salt, intent linkage, and token addresses.
  No wallet and no writes; "Jump to #" loads any swap by id beyond the recent window.
  Cross-linked from the user and solver apps. Adds a `getFeeStatus` read path so
  fee-settlement status is visible (`app/lib/contract.js`).

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
