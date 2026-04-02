# Cross-Chain Settlement

Trustless cross-chain swaps using [Lit Protocol](https://developer.litprotocol.com/) Lit Actions as a decentralized custodian. No bridges, no wrapped tokens, no HTLC complexity.

## How it works

1. A Solidity contract on Base records swap intent (chains, amounts, fees, expiration)
2. A unique Lit Action is generated per swap (salt injection gives a unique IPFS CID, which gives a unique private key, which gives unique deposit addresses)
3. Both parties deposit to their respective chain's deposit address
4. Anyone triggers the Lit Action, which reads the contract, verifies balances, and settles both legs
5. The action signs a cryptographic receipt and updates the contract state

The Lit Action's private key exists only inside the Lit network's threshold cryptography system. No single party ever holds it.

## Chain pairs

| Pair | Status |
|------|--------|
| EVM <> EVM | Working (Base, Ethereum, Arbitrum, Optimism testnets) |
| EVM <> Bitcoin | Template ready (Mempool API for UTXO) |
| EVM <> Zcash | Planned (transparent addresses only) |
| Bitcoin <> Zcash | Planned |

## Architecture

```
User (browser)
  |
  +-- Create swap --> SwapContract.sol (Base)
  |                      |
  |                      +-- Stores: chains, amounts, fees,
  |                      |   expiration, deposit addresses,
  |                      |   Lit Action CID, ERC-20 tokens
  |                      |
  +-- Fund -----------> Deposit addresses (derived from Lit Action key)
  |
  +-- Execute --------> Lit Chipotle REST API
                            |
                            +-- Lit Action runs:
                                1. Read swap params from contract
                                2. Check balances on both chains
                                3. Settle slower chain first
                                4. Send fees to contract owner
                                5. Sweep excess to refund address
                                6. Sign receipt
                                7. Mark executed on contract
```

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
  test/SwapContract.t.sol # 21 Foundry tests
```

State machine: `Created -> Executed | Refunded`

Supports native tokens and ERC-20 (token address fields, `address(0)` = native).

## Lit Actions

Each swap type has its own action template. Per-swap uniqueness via salt injection before IPFS upload.

```
app/swap-engine.js          # EVM<>EVM action (inline)
app/actions/evm-btc-action.js  # EVM<>Bitcoin action
```

Actions have two modes:
- `mode: "derive"` returns deposit addresses
- `mode: "execute"` runs the full swap

Security: the action reads ALL params from the on-chain contract. Only `swapId`, `baseRpcUrl`, and `contractAddress` are passed via `js_params`.

## Features

- **Signed receipts** -- JSON with both tx hashes, amounts, timestamps, signed by the Lit Action's key
- **Webhooks** -- optional callback URL, POST on state changes
- **Gas preview** -- estimate total costs across all chains before committing
- **CID verification** -- recompute CID from template + salt to verify action code matches contract
- **ERC-20 support** -- token address fields in contract, direct `transfer()` from action wallet
- **Excess sweep** -- leftover deposits returned to refund address after execution

## Testing

```bash
# Solidity (21 tests)
cd contracts && forge test

# Lit Action logic (9 tests)
node test/evm-evm-action.test.js

# Key primitive validation
node spike/btc-key-validation.js
```

The test harness (`test/lit-harness.js`) mocks the Lit runtime so action code can be unit-tested without hitting the live network.

## Setup

**Prerequisites:** Node.js 22+, [Foundry](https://getfoundry.sh/), a Lit Chipotle account

```bash
npm install

# Deploy contract to Base Sepolia
cd contracts
forge install foundry-rs/forge-std
forge test
# forge script script/Deploy.s.sol --rpc-url https://sepolia.base.org --broadcast

# Run the web app
cd app && python3 -m http.server 8899
# Open http://localhost:8899
```

Update `CONTRACT_ADDRESS` in `app/swap-engine.js` after deployment.

## Security model

This is NOT an atomic swap protocol. It is a decentralized custodian model where immutable IPFS code is the trust guarantee.

- Trust assumptions: Lit network liveness + immutable IPFS code
- If Lit goes down mid-swap, funds sit in the action's wallet until the network recovers
- One-sided settlement failure is possible (mitigated by settling slower chain first + idempotent re-execution)
- The action's private key is derived from the IPFS CID via Lit's threshold cryptography. No single node holds the full key.

## License

MIT
