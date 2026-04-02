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

| Pair | Status | Action file |
|------|--------|-------------|
| EVM <> EVM | Working | `app/actions/evm-evm-action.js` |
| EVM <> Bitcoin | Template ready | `app/actions/evm-btc-action.js` |
| EVM <> Zcash | Template ready | `app/actions/evm-zec-action.js` |
| Bitcoin <> Zcash | Template ready | `app/actions/btc-zec-action.js` |

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
- Can't mark executed without both legs (`"source leg not settled"`)
- Can't settle legs on an already-executed swap (`"invalid state"`)
- Only the Lit Action's address can call any settlement function (`"not lit action"`)

The contract stores the tx hash for each leg, making every settlement step auditable.

## Web app

Static HTML + vanilla JS. No build step. No framework. No backend.

```
app/
  index.html        # UI with 5 tabs
  swap-engine.js    # All swap logic (33KB)
```

Tabs: **Create** | **Status** | **Execute** | **Gas Preview** | **Verify CID**

The browser talks directly to Base RPC, Lit Chipotle API, and the user's wallet (MetaMask).

## Smart contract

```
contracts/
  src/SwapContract.sol    # Swap state machine on Base
  test/SwapContract.t.sol # 35 Foundry tests
```

State machine: `Created -> Executed | Refunded`

Key functions:
- `createSwap(...)` records swap intent with all parameters
- `markLegSettled(swapId, isSourceLeg, txHash)` logs each leg's completion
- `markExecuted(swapId)` finalizes (requires both legs settled)
- `markRefunded(swapId)` handles expired swaps (allowed even after partial settlement)
- `getSwapLegs(swapId)` returns per-leg settlement status and tx hashes

Supports native tokens and ERC-20 (token address fields, `address(0)` = native).

## Lit Actions

Four action templates, one per swap type. Each is a standalone JavaScript file that runs inside Lit's Deno sandbox. Per-swap uniqueness via salt injection before IPFS upload (unique CID = unique key = unique deposit addresses).

```
app/actions/
  evm-evm-action.js   # EVM <> EVM    — ethers v5 on both sides
  evm-btc-action.js   # EVM <> BTC    — ethers + Mempool.space API
  evm-zec-action.js   # EVM <> Zcash  — ethers + Insight/Blockchair API
  btc-zec-action.js   # BTC <> Zcash  — both UTXO, no EVM leg
```

All actions have two modes:
- `mode: "derive"` returns deposit addresses (used during swap creation)
- `mode: "execute"` runs the full swap lifecycle with per-leg idempotency

**Security:** actions read ALL params from the on-chain contract. Only `swapId`, `baseRpcUrl`, and `contractAddress` are passed via `js_params`.

**Settlement order:** slower/riskier chain always settles first. After each leg, the action logs to the contract before proceeding. On re-execution, settled legs are skipped.

**Chain-specific details:**

| Action | Settlement order | Fee collection | UTXO API | Dust limit |
|--------|-----------------|----------------|----------|------------|
| EVM<>EVM | Either (both fast) | Source EVM side | N/A | N/A |
| EVM<>BTC | BTC first | EVM side | Mempool.space | 546 sats |
| EVM<>ZEC | ZEC first | EVM side | Insight + Blockchair fallback | 5460 zats |
| BTC<>ZEC | BTC first | ZEC side (no EVM leg) | Both APIs | 546 sats / 5460 zats |

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
# Solidity (35 tests)
cd contracts && forge test

# Lit Action logic (9 tests)
node test/evm-evm-action.test.js

# Key primitive validation
node spike/btc-key-validation.js
```

The test harness (`test/lit-harness.js`) mocks the Lit runtime so action code can be unit-tested without hitting the live network. Contract tests cover the full per-leg settlement lifecycle including partial settlement, double-settle prevention, and re-execution scenarios.

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

**For running tests only** (optional): Node.js 22+ and `npm install` are needed for the test harness and key validation spike.

## Security model

This is NOT an atomic swap protocol. It is a decentralized custodian model where immutable IPFS code is the trust guarantee.

- Trust assumptions: Lit network liveness + immutable IPFS code
- If Lit goes down mid-swap, funds sit in the action's wallet until the network recovers
- One-sided settlement failure is handled by per-leg logging. Re-execute the action to complete the remaining leg. The contract prevents double-settlement.
- The action's private key is derived from the IPFS CID via Lit's threshold cryptography. No single node holds the full key.

## License

MIT
