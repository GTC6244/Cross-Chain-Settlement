# Cross-Chain Settlement

Trustless cross-chain swaps using [Lit Protocol](https://developer.litprotocol.com/) Lit Actions as the custodian, with each swap's signing key generated and used only inside a Trusted Execution Environment (TEE). No bridges, no wrapped tokens, no HTLC complexity.

It's a two-sided market: a **user** posts what they want to swap, and **solvers** compete to fill it.

1. A user announces a swap *intent* on a Base contract (chains, source amount, minimum dest amount) via a stateless `announceIntent` event. No funds move, nothing is escrowed.
2. Solvers watch the intent order book and compete. Each builds a swap with `createSwap`, quoting a `destAmount ≥ minDestAmount`. Every swap gets its own salt → unique IPFS CID → unique private key → unique deposit addresses.
3. The user compares the competing quotes, auto-verifies the chosen swap's CID against the audited template, and funds the source leg of the best one. Funding is the commitment — nothing is at risk before the user picks.
4. The solver funds the dest leg and triggers the Lit Action, which reads the contract, verifies balances, and settles both legs.
5. Each leg is logged to the contract as it completes. If execution fails mid-swap, re-running the action picks up where it left off.
6. Once both legs are settled, the action signs a cryptographic receipt and marks the swap executed.

The Lit Action's private key is generated and used only inside a Trusted Execution Environment (TEE), attested by a complete root-of-trust system. No one, not even Lit, can extract it.

## Chain pairs

Eleven pairs across EVM, Bitcoin, Litecoin, Dogecoin, Zcash (transparent), and Solana. All share one chain-agnostic settlement engine (`app/actions/lib/engine.js`) and per-chain leg drivers.

| Pair | Signing | Verification status | Action file |
|------|---------|---------------------|-------------|
| EVM <> EVM | micro-eth-signer | **verified live (Base mainnet)** | `app/actions/evm-evm-action.js` |
| EVM <> Bitcoin | micro-eth-signer + @scure/btc-signer | **verified live (Base mainnet ↔ signet)** | `app/actions/evm-btc-action.js` |
| EVM <> Zcash | micro-eth-signer + ZIP-243 shim | ZIP-243 verified (regtest); needs live provider | `app/actions/evm-zec-action.js` |
| Bitcoin <> Zcash | @scure/btc-signer + ZIP-243 shim | ZIP-243 verified (regtest); needs live provider | `app/actions/btc-zec-action.js` |
| Bitcoin <> Litecoin | @scure/btc-signer | needs testnet | `app/actions/btc-ltc-action.js` |
| Bitcoin <> Dogecoin | @scure/btc-signer (legacy P2PKH) | needs testnet + DOGE API | `app/actions/btc-doge-action.js` |
| EVM <> Solana | micro-eth-signer + micro-sol-signer | needs devnet | `app/actions/evm-sol-action.js` |
| Bitcoin <> Solana | @scure/btc-signer + micro-sol-signer | needs testnet/devnet | `app/actions/btc-sol-action.js` |
| Zcash <> Solana | ZIP-243 shim + micro-sol-signer | ZIP-243 verified (regtest); needs live provider | `app/actions/zec-sol-action.js` |
| Zcash <> Litecoin | ZIP-243 shim + @scure/btc-signer | ZIP-243 verified (regtest); needs live provider | `app/actions/zec-ltc-action.js` |
| Zcash <> Dogecoin | ZIP-243 shim + @scure/btc-signer | ZIP-243 verified (regtest); needs live provider | `app/actions/zec-doge-action.js` |

The chain-agnostic settlement state machine (`runSwap`) is exercised by `test/engine.test.js`. The in-sandbox signing/broadcast runs only in the Lit runtime: **EVM↔EVM (Base mainnet) and EVM↔Bitcoin (signet) are now verified live end to end**, and `derive` mode (deposit-address generation) is verified live for all 11 pairs. The remaining settle paths (Litecoin, Dogecoin, Zcash, Solana) still need live verification before production use.

## Architecture

```
USER (index.html)              SwapContract.sol (Base)         SOLVER (solver.html)
  |                                  |                               |
  +-- announceIntent ----------------> emits IntentAnnounced ------->  order book
  |   (chains, source amt,            |   (no storage, no escrow)      pick + quote
  |    min dest amt; no funds)        |                               |
  |                                   <---- createSwap ----------------+
  |   compare quotes,                 |   (real destAmount >= floor,   own salt ->
  |   auto-verify CID  <-- SwapCreated|    four role addresses, CID)   own deposits
  |                                   |                               |
  +-- fund SOURCE leg --> deposit addr (derived from this swap's Lit Action key)
  |                                                                   |
  |                                          fund DEST leg <----------+
  |                                          + Execute --> Lit Chipotle REST API
  |                                                            |
  |                                                            +-- Lit Action runs:
  |                                                                1. Read swap params + legs
  |                                                                2. Skip already-settled legs
  |                                                                3. Check balances + dest floor
  |                                                                4. Settle slower chain first
  |                                                                5. Log each leg (markLegSettled)
  |                                                                6. Send fees to contract owner
  |                                                                7. Sweep excess to refund addrs
  |                                                                8. Mark executed (both legs)
  +-- watch settlement <---------------------------------------- 9. Sign receipt
```

The settlement cross uses a **four-address model** so a real two-party swap is safe
across chains: on success the source asset pays the solver (`solverReceiveSource`)
and the dest asset pays the user (`userReceiveDest`); on expiry each side is refunded
to its own chain (`userRefundSource` / `solverRefundDest`).

## Per-leg settlement and recovery

Each side of a swap is tracked independently on-chain. When a leg settles, the Lit Action immediately calls `markLegSettled(swapId, isSourceLeg, txHash)` on the contract before attempting the next leg.

```
FIRST EXECUTION (fails after source leg):

  1. Read contract: sourceLeg=false, destLeg=false
  2. Send BTC to dest party              OK
  3. markLegSettled(swapId, true, txHash) OK  <- logged on-chain
  4. Send ETH to source party            FAIL (timeout)
  5. Action exits with error

RE-EXECUTION:

  1. Read contract: sourceLeg=true, destLeg=false
  2. Source leg already settled           SKIP (tx hash from contract)
  3. Send ETH to source party            OK
  4. markLegSettled(swapId, false, txHash) OK
  5. markExecuted(swapId)                OK  (both legs confirmed)
  6. Sign receipt (includes resumed=true)
```

**Contract invariants:**
- Can't settle the same leg twice (`"source leg already settled"`)
- Can't pay the fee twice (`"fee already settled"`)
- Can't mark executed without both legs (`"source leg not settled"`)
- Can't settle legs on an already-executed swap (`"invalid state"`)
- Only the Lit Action's address can call any settlement function (`"not lit action"`)

**One step per invocation + the HTTP budget.** The Lit sandbox caps an action's outbound HTTP calls per run (~24), so the action does **one settlement step per invocation** (settle a leg, pay the fee, or finalize) and returns; the caller re-invokes until the swap is executed. Each step is idempotent — the action reads the on-chain leg/fee/state flags at the top of every run and skips anything already done — so a crash, timeout, or sandbox kill mid-swap is recovered by the next invocation. Before settling either leg it checks that BOTH deposits are funded, so it never pays one side when the other can't be.

**Crash hardening:** the EVM signer broadcasts without waiting for each receipt (per-tx polling would blow the HTTP budget). Correctness comes from nonce ordering instead: the finalize transaction can't be mined until every value transfer before it has, and plain value transfers from a funded account can't revert. The fee is logged on-chain (`markFeeSettled`) independently of the legs, so a crash between a leg settling and the fee being paid is recovered on re-execution. If an expiry refund's drains hard-fail (e.g. RPC down), the swap is left `Created` (status `refund_incomplete`) rather than finalized, so funds are never stranded in a terminal `Refunded` state. UTXO/Zcash legs, which have no nonce ordering, are held back from finalize until their settlement transaction reaches the swap's `confirmationBlocks` depth (fail-closed: an explorer that can't be reached defers finalize rather than assuming success).

The contract stores the tx hash for each leg, making every settlement step auditable.

## Web app

Static HTML + vanilla ES modules. No build step. No framework. No backend.
Two role-scoped apps share one design system and one shared core.

```
app/
  index.html        # USER app — announce intent, compare quotes, fund best, watch settlement
  user-app.js       #   user controller
  solver.html       # SOLVER app — order book, quote + create swap, fund dest, execute
  solver-app.js     #   solver controller
  settled.css       # shared "Settled" design system (see DESIGN.md)
  lib/              # shared browser core (ES modules)
    contract.js     #   config + the single browser ABI home + readSwap()
    derive.js       #   random salt, template dispatch, CID + address derivation
    intents.js      #   order-book reader (chunked log scan, quote grouping/sort)
    verify.js       #   recompute + compare CID against the audited template
    ui.js           #   shared status-box / tabs / theme chrome
    templates.js    #   registers the 11 action generators on window.ActionTemplates
  actions/          # audited action templates + lib/ (loaded as ES modules)
```

The **user app** flow is Announce → Quotes → Status. The **solver app** flow is Order
Book → Quote → My Fills. `lib/templates.js` imports the action-template generators and
exposes them on `window.ActionTemplates`; `lib/derive.js` dispatches to them by pair.
(Loading those modules does not fetch jsDelivr — the jsDelivr imports live only inside
the generated action strings.)

The browser talks directly to Base RPC, the Lit Chipotle API, and the user's wallet (MetaMask).

## Smart contract

```
contracts/
  src/SwapContract.sol    # Swap state machine on Base
  script/Deploy.s.sol     # Foundry deploy script
  test/SwapContract.t.sol # 53 Foundry tests
```

State machine: `Created -> Executed | Refunded` (unchanged by the two-sided work).

Key functions:
- `announceIntent(...)` emits an `IntentAnnounced` order-book event — no storage, no escrow; `msg.sender` authenticates the user
- `createSwap(...)` records a solver's fill: real `destAmount` (enforced `>= minDestAmount`), the four role addresses, deposit addresses, CID + salt; emits `SwapCreated(swapId, intentId, ...)`
- `getSwapAddresses(swapId)` returns the four role addresses + the two deposit addresses; `getSwapIntent(swapId)` returns `intentId`, `minDestAmount`, and `salt`
- `markLegSettled(swapId, isSourceLeg, txHash)` logs each leg's completion
- `markFeeSettled(swapId, txHash)` logs fee payment separately, so a crash between a leg settling and the fee being paid is recoverable (the action re-sends the fee only if this flag is unset)
- `markExecuted(swapId)` finalizes (requires both legs settled)
- `markRefunded(swapId)` handles expired swaps (allowed even after partial settlement)
- `getSwapLegs(swapId)` / `getFeeStatus(swapId)` return per-leg and fee settlement status + tx hashes

Supports native tokens and ERC-20 (token address fields, `address(0)` = native).

## Lit Actions

Each action is assembled (per swap, with salt injection → unique CID → unique key → unique deposit addresses) from a set of shared snippet generators and run inside Lit's Deno sandbox. The CID is derived from the assembled code (so the key/addresses are bound to the exact audited code); current testing runs the code directly against the Lit test environment, and pinning each template to IPFS is the production publishing step.

```
app/actions/
  evm-evm-action.js  evm-btc-action.js  evm-zec-action.js  btc-zec-action.js
  btc-ltc-action.js  btc-doge-action.js evm-sol-action.js  btc-sol-action.js
  zec-sol-action.js  zec-ltc-action.js  zec-doge-action.js
  lib/
    assemble.js    # composes imports + engine + leg drivers + main()
    networks.js    # chain registry (network params, APIs, dust, fees)
    imports.js     # pinned jsDelivr ESM import lines
    engine.js      # chain-agnostic runSwap state machine + EVM leg
    utxo-leg.js    # BTC/LTC/DOGE leg + pure coin-selection math
    zec-leg.js     # Zcash transparent leg (ZIP-243 sighash shim)
    sol-leg.js     # Solana leg
```

Each pair file is a thin wrapper that picks the source/dest chains, settle order, and fee placement; the assembler emits a self-contained action string. Action code can only import from jsDelivr, so the shared logic is composed in as code strings (not runtime imports).

### Signing — audited libraries only

All signing uses Paul Miller's audited, pure-JS, zero-dependency [noble/scure/micro](https://paulmillr.com/noble/) family (replacing the earlier `bitcoinjs-lib`/`tiny-secp256k1`/`ecpair` and `ethers` signing):

- **`@scure/btc-signer`** — Bitcoin / Litecoin / Dogecoin transaction construction (custom network params; SegWit P2WPKH, or legacy P2PKH with `nonWitnessUtxo`)
- **`micro-eth-signer`** — EVM transaction + EIP-191 receipt signing (the `ethers` global is used only for read-only RPC, nonce, gas, and broadcast)
- **`micro-sol-signer`** — Solana, using the action's 32-byte key as an Ed25519 seed (same secret as the secp256k1 side, different address — no dependency on Lit's roadmap Ed25519 signing)
- **`@noble/hashes` + `@noble/curves` + `@scure/base`** — the Zcash ZIP-243 transparent sighash shim (BLAKE2b + secp256k1 + base58check), since no library does Zcash sighash natively

All actions have two modes: `mode: "derive"` returns deposit addresses; `mode: "execute"` advances the swap by one idempotent step per invocation (settle a leg / pay fee / finalize). The caller invokes, waits for the step to land on-chain, and invokes again until the swap reads `Executed` — re-invoking while a step is still pending would recompute nonces and double-send.

**Security:** actions read ALL settlement params from the on-chain contract. Only `swapId`, `baseRpcUrl`, `contractAddress`, and `legRpcUrls` are passed via `js_params`. The RPC endpoints arrive at runtime rather than being baked in, so the action code embedded in the published CID carries no API key (the value left in `networks.js` is a key-free public node used as the default).

**Settlement order:** slower/riskier chain settles first. After each leg, the action logs to the contract before proceeding; on re-execution, settled legs are skipped.

**Chain-specific details:**

| Chain | Address | API | Dust | Notes |
|-------|---------|-----|------|-------|
| Bitcoin (signet) | P2WPKH SegWit | mempool.space esplora | 546 sat | |
| Litecoin (testnet) | P2WPKH SegWit | litecoinspace.org esplora | 546 lit | |
| Dogecoin (testnet) | legacy P2PKH | blockchair | ~0.01 DOGE | testnet API base is a placeholder — confirm before use |
| Zcash (testnet) | transparent t-addr | self-hosted zcashd (`style:'zcashd'`) or insight; public explorers are dead | 5460 zat | ZIP-243 v4 shim verified on zcashd regtest; ZIP-317 fees; branch id resolved live from the node (NU6 fallback) |
| Solana (devnet) | Ed25519 | Solana JSON-RPC | — | seed = same 32-byte action key |

## Features

- **Two-sided market** -- users announce intents; solvers compete by building swaps, each quoting a `destAmount` at or above the user's floor
- **On-chain order book** -- a client-side scan of `IntentAnnounced` / `SwapCreated` events; no backend, no indexer (truncated scans are surfaced, never hidden)
- **Competing quotes** -- the user sees every solver's quote best-rate-first and funds the best; each quote is a distinct swap with its own key, so funding one can never settle another
- **Four-address model** -- separate role addresses per party per chain, so settle and refund target the correct chain in a real cross-family swap
- **Per-leg settlement** -- each leg logged to the contract independently, enabling safe re-execution after partial failure
- **Signed receipts** -- JSON with both tx hashes, amounts, timestamps, signed by the Lit Action's key
- **CID verification** -- recompute CID from template + salt to confirm a swap runs only the audited code (auto-run before the user funds)
- **ERC-20 support** -- token address fields in the contract, direct `transfer()` from the action wallet
- **Excess sweep** -- leftover deposits returned to each side's refund address after execution

## Testing

```bash
# Solidity (53 tests)
cd contracts && forge test

# Lit Action + browser-core logic (85 tests, Node 22+)
node test/engine.test.js          # real runSwap state machine, mock legs (22)
node test/utxo-math.test.js       # coin selection / fee math (14)
node test/evm-evm-action.test.js  # settlement flow (9)
node test/evm-btc-action.test.js  # settlement flow (8)
node test/lib.test.js             # browser shared-core pure helpers (21)
node test/zec-leg.test.js         # ZEC blockbook + tatum provider parsing (11)

# Assemble + syntax-check all 11 action templates
node test/_gen.mjs && for f in /tmp/genactions/*.mjs; do node --check "$f"; done
```

`test/engine.test.js` drives the actual `runSwap` engine from `lib/engine.js` with mock legs and a mock Base writer — it tests the code that ships, not a copy, including the four-address settle/refund mapping and the dest-floor assert. `test/lib.test.js` covers the browser shared core (`app/lib/*`) pure helpers: random salt, template dispatch, deposit picking, order-book paging, quote group/sort, CID compare. `test/utxo-math.test.js` loads the exact coin-selection source embedded into the actions (including the Zcash ZIP-317 fee math). `test/zec-leg.test.js` loads the embedded `zecLegSrc()` and drives its blockbook provider branches (UTXO list, tx confirmations, raw broadcast) with a mock fetch — the parsing layer a live Zcash settle depends on. The EVM and Bitcoin signers are now verified live (EVM↔EVM on Base mainnet, EVM↔BTC on signet); the LTC/DOGE/SOL signers run only in the Lit runtime and still need live verification. Contract tests cover the full intent → fill → per-leg settlement lifecycle.

For a live Zcash settle the public testnet explorer is dead, so the leg takes its provider at runtime via the `legApiConfig` js_param (chainId → api object) — the non-EVM analogue of `legRpcUrls` — keeping the published action CID free of any keyed endpoint. Supported styles: `blockbook` (hosted REST from NOWNodes / GetBlock, free tier + key), `tatum` (the Tatum zcashd-compatible RPC gateway — verified live for broadcast/confirmations/branch-id; it can't list UTXOs, so it delegates UTXO enumeration to an `api.utxoApi` blockbook source), `zcashd` (self-hosted node, `-insightexplorer`), and `insight` (classic Bitcore). Verify a provider before settling with `node .context/zec-verify/verify-live.mjs` (see its header for env vars).

The **Zcash ZIP-243 shim** — the highest-risk hand-rolled crypto — has been verified end-to-end against a local `zcashd` regtest node: the exact shipped `zecLegSrc()` builds and signs a transaction that zcashd's consensus engine accepts and mines (on both a Canopy and a NU6 chain). That harness, the findings, and a one-command reproduction live in `.context/zec-verify/`. Two bugs it surfaced (a stale hardcoded consensus branch id and a sub-ZIP-317 fee) are fixed.

## Setup

**Prerequisites:** [Foundry](https://getfoundry.sh/), a Lit Chipotle account, a web3 wallet (MetaMask)

The web app is static HTML + JS with no build step. No Node.js required to run it.

The contract is currently deployed on **Base mainnet** at `0xC0a9c217e643DbdF1b6195a18C0802a1231507A1` (already wired into `app/lib/contract.js`). To deploy your own:

```bash
# Deploy contract to Base mainnet (the contract is cheap + redeployable; no state migration)
cd contracts
forge install foundry-rs/forge-std
forge test
PRIVATE_KEY=0x... forge script script/Deploy.s.sol --rpc-url https://mainnet.base.org --broadcast

# Run the web app (any static file server works)
cd app && python3 -m http.server 8899
# User app:   http://localhost:8899/index.html
# Solver app: http://localhost:8899/solver.html
# Explorer:   http://localhost:8899/explorer.html   (read-only — every swap's full on-chain record)
```

After deploying, set `CONTRACT_ADDRESS` (and `CONTRACT_DEPLOY_BLOCK`, so the order-book
scan starts at deploy rather than genesis) in `app/lib/contract.js` — the script prints both.

**For running tests only** (optional): Node.js 22+ (ESM auto-detection). The engine and UTXO-math tests use only Node built-ins; the older harness-based tests import `ethers`.

## Security model

This is NOT an atomic swap protocol. It is a TEE-custodied model where immutable IPFS code, pinned by CID and attested by a root of trust, is the trust guarantee.

- Trust assumptions: Lit network liveness + immutable IPFS code
- If Lit goes down mid-swap, funds sit in the action's wallet until the network recovers
- One-sided settlement failure is handled by per-leg logging. Re-execute the action to complete the remaining leg. The contract prevents double-settlement.
- The action's private key is uniquely tied to the IPFS CID and exists only inside the TEE. No node ever holds it in the clear.

## License

MIT
