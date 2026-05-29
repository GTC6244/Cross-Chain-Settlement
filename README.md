# Cross-Chain Settlement

Trustless cross-chain swaps using [Lit Protocol](https://developer.litprotocol.com/) Lit Actions as a decentralized custodian. No bridges, no wrapped tokens, no HTLC complexity.

## How it works

1. A Solidity contract on Base records swap intent (chains, amounts, fees, expiration)
2. A unique Lit Action is generated per swap (salt injection gives a unique IPFS CID, which gives a unique private key, which gives unique deposit addresses)
3. Both parties deposit to their respective chain's deposit address
4. Anyone triggers the Lit Action, which reads the contract, verifies balances, and settles both legs
5. Each leg is logged to the contract as it completes. If execution fails mid-swap, re-running the action picks up where it left off.
6. Once both legs are settled, the action signs a cryptographic receipt and marks the swap executed

The Lit Action's private key exists only inside the Lit network's threshold cryptography system. No single party ever holds it.

## Chain pairs

Eleven pairs across EVM, Bitcoin, Litecoin, Dogecoin, Zcash (transparent), and Solana. All share one chain-agnostic settlement engine (`app/actions/lib/engine.js`) and per-chain leg drivers.

| Pair | Signing | Verification status | Action file |
|------|---------|---------------------|-------------|
| EVM <> EVM | micro-eth-signer | settlement logic tested | `app/actions/evm-evm-action.js` |
| EVM <> Bitcoin | micro-eth-signer + @scure/btc-signer | needs testnet | `app/actions/evm-btc-action.js` |
| EVM <> Zcash | micro-eth-signer + ZIP-243 shim | **ZEC unverified** | `app/actions/evm-zec-action.js` |
| Bitcoin <> Zcash | @scure/btc-signer + ZIP-243 shim | **ZEC unverified** | `app/actions/btc-zec-action.js` |
| Bitcoin <> Litecoin | @scure/btc-signer | needs testnet | `app/actions/btc-ltc-action.js` |
| Bitcoin <> Dogecoin | @scure/btc-signer (legacy P2PKH) | needs testnet + DOGE API | `app/actions/btc-doge-action.js` |
| EVM <> Solana | micro-eth-signer + micro-sol-signer | needs devnet | `app/actions/evm-sol-action.js` |
| Bitcoin <> Solana | @scure/btc-signer + micro-sol-signer | needs testnet/devnet | `app/actions/btc-sol-action.js` |
| Zcash <> Solana | ZIP-243 shim + micro-sol-signer | **ZEC unverified** | `app/actions/zec-sol-action.js` |
| Zcash <> Litecoin | ZIP-243 shim + @scure/btc-signer | **ZEC unverified** | `app/actions/zec-ltc-action.js` |
| Zcash <> Dogecoin | ZIP-243 shim + @scure/btc-signer | **ZEC unverified** | `app/actions/zec-doge-action.js` |

The chain-agnostic settlement state machine (`runSwap`) is exercised by `test/engine.test.js`. The in-sandbox signing/broadcast for each chain runs only in the Lit runtime and requires live-testnet verification before production use.

## Architecture

```
User (browser)
  |
  +-- Create swap --> SwapContract.sol (Base)
  |                      |
  |                      +-- Stores: chains, amounts, fees,
  |                      |   expiration, deposit addresses,
  |                      |   Lit Action CID, ERC-20 tokens,
  |                      |   per-leg settlement status
  |                      |
  +-- Fund -----------> Deposit addresses (derived from Lit Action key)
  |
  +-- Execute --------> Lit Chipotle REST API
                            |
                            +-- Lit Action runs:
                                1. Read swap params + leg status from contract
                                2. Skip already-settled legs
                                3. Check balances for unsettled legs
                                4. Settle slower chain first
                                5. Log each leg to contract (markLegSettled)
                                6. Send fees to contract owner
                                7. Sweep excess to refund address
                                8. Mark executed (requires both legs)
                                9. Sign receipt
```

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

**Crash hardening:** every EVM transaction (the Base contract writes and EVM value transfers) is awaited to inclusion (`waitForTransaction`) and throws on revert, so the state machine never advances on an unmined tx. The fee is logged on-chain (`markFeeSettled`) independently of the legs, so a crash between a leg settling and the fee being paid is recovered on re-execution. If an expiry refund's drains hard-fail (e.g. RPC down), the swap is left `Created` (status `refund_incomplete`) rather than finalized, so funds are never stranded in a terminal `Refunded` state.

The contract stores the tx hash for each leg, making every settlement step auditable.

## Web app

Static HTML + vanilla JS. No build step. No framework. No backend.

```
app/
  index.html        # UI with 5 tabs
  swap-engine.js    # All swap logic
  actions/          # audited action templates + lib/ (loaded as ES modules)
```

Tabs: **Create** | **Status** | **Execute** | **Gas Preview** | **Verify CID**

A small `<script type="module">` in `index.html` imports the action-template generators and exposes them on `window.ActionTemplates`; the classic `swap-engine.js` dispatches to them by pair. (Loading those modules does not fetch jsDelivr — the jsDelivr imports live only inside the generated action strings.)

The browser talks directly to Base RPC, Lit Chipotle API, and the user's wallet (MetaMask).

## Smart contract

```
contracts/
  src/SwapContract.sol    # Swap state machine on Base
  test/SwapContract.t.sol # 39 Foundry tests
```

State machine: `Created -> Executed | Refunded`

Key functions:
- `createSwap(...)` records swap intent with all parameters
- `markLegSettled(swapId, isSourceLeg, txHash)` logs each leg's completion
- `markFeeSettled(swapId, txHash)` logs fee payment separately, so a crash between a leg settling and the fee being paid is recoverable (the action re-sends the fee only if this flag is unset)
- `markExecuted(swapId)` finalizes (requires both legs settled)
- `markRefunded(swapId)` handles expired swaps (allowed even after partial settlement)
- `getSwapLegs(swapId)` / `getFeeStatus(swapId)` return per-leg and fee settlement status + tx hashes

Supports native tokens and ERC-20 (token address fields, `address(0)` = native).

## Lit Actions

Each action is assembled (per swap, with salt injection → unique CID → unique key → unique deposit addresses) from a set of shared snippet generators, then deployed to IPFS and run inside Lit's Deno sandbox.

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

All actions have two modes: `mode: "derive"` returns deposit addresses; `mode: "execute"` runs the full lifecycle with per-leg idempotency.

**Security:** actions read ALL params from the on-chain contract. Only `swapId`, `baseRpcUrl`, and `contractAddress` are passed via `js_params`.

**Settlement order:** slower/riskier chain settles first. After each leg, the action logs to the contract before proceeding; on re-execution, settled legs are skipped.

**Chain-specific details:**

| Chain | Address | API | Dust | Notes |
|-------|---------|-----|------|-------|
| Bitcoin (signet) | P2WPKH SegWit | mempool.space esplora | 546 sat | |
| Litecoin (testnet) | P2WPKH SegWit | litecoinspace.org esplora | 546 lit | |
| Dogecoin (testnet) | legacy P2PKH | blockchair | ~0.01 DOGE | testnet API base is a placeholder — confirm before use |
| Zcash (testnet) | transparent t-addr | Insight + Blockchair | 5460 zat | **ZIP-243 v4 shim — unverified; branch id must match active upgrade** |
| Solana (devnet) | Ed25519 | Solana JSON-RPC | — | seed = same 32-byte action key |

## Features

- **Per-leg settlement** -- each leg logged to contract independently, enabling safe re-execution after partial failure
- **Signed receipts** -- JSON with both tx hashes, amounts, timestamps, signed by the Lit Action's key
- **Webhooks** -- optional callback URL, POST on state changes
- **Gas preview** -- estimate total costs across all chains before committing
- **CID verification** -- recompute CID from template + salt to verify action code matches contract
- **ERC-20 support** -- token address fields in contract, direct `transfer()` from action wallet
- **Excess sweep** -- leftover deposits returned to refund address after execution

## Testing

```bash
# Solidity (39 tests)
cd contracts && forge test

# Lit Action logic (43 tests, Node 22+)
node test/engine.test.js          # real runSwap state machine, mock legs (18)
node test/utxo-math.test.js       # coin selection / fee math (8)
node test/evm-evm-action.test.js  # settlement flow (9)
node test/evm-btc-action.test.js  # settlement flow (8)

# Assemble + syntax-check all 11 action templates
node test/_gen.mjs && for f in /tmp/genactions/*.mjs; do node --check "$f"; done
```

`test/engine.test.js` drives the actual `runSwap` engine from `lib/engine.js` with mock legs and a mock Base writer — it tests the code that ships, not a copy. `test/utxo-math.test.js` loads the exact coin-selection source embedded into the actions. The in-sandbox crypto (the signers and the ZIP-243 shim) runs only in the Lit runtime and is **not** covered by these tests — it needs live-testnet verification. Contract tests cover the full per-leg settlement lifecycle.

## Setup

**Prerequisites:** [Foundry](https://getfoundry.sh/), a Lit Chipotle account, a web3 wallet (MetaMask)

The web app is static HTML + JS with no build step. No Node.js required to run it.

```bash
# Deploy contract to Base Sepolia
cd contracts
forge install foundry-rs/forge-std
forge test
# forge script script/Deploy.s.sol --rpc-url https://sepolia.base.org --broadcast

# Run the web app (any static file server works)
cd app && python3 -m http.server 8899
# Open http://localhost:8899
```

Update `CONTRACT_ADDRESS` in `app/swap-engine.js` after deployment.

**For running tests only** (optional): Node.js 22+ (ESM auto-detection). The engine and UTXO-math tests use only Node built-ins; the older harness-based tests import `ethers`.

## Security model

This is NOT an atomic swap protocol. It is a decentralized custodian model where immutable IPFS code is the trust guarantee.

- Trust assumptions: Lit network liveness + immutable IPFS code
- If Lit goes down mid-swap, funds sit in the action's wallet until the network recovers
- One-sided settlement failure is handled by per-leg logging. Re-execute the action to complete the remaining leg. The contract prevents double-settlement.
- The action's private key is derived from the IPFS CID via Lit's threshold cryptography. No single node holds the full key.

## License

MIT
