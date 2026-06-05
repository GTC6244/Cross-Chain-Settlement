# Plan — Two-Sided Market: User (intent) + Solver (quote) interfaces

Branch: `GTC6244/seattle` · `/plan-eng-review` + outside-voice challenge · 2026-06-04

## Goal

Split the single-page app (one wallet funds both legs) into a commercial two-sided market:

1. **User / source interface** — announces an *intent* ("I'll give X on source, I want
   ≥ Y on dest, to these addresses"), then funds the source leg of the swap a solver
   builds for them.
2. **Solver / quoter interface** — browses announced intents, quotes a `destAmount`,
   builds the swap on-chain, injects the dest asset from its own wallet, and settles.

### Architecture chosen (after outside-voice challenge)

The original plan added `Open`/`Claimed` states + a claim/release machine to the audited
contract. The outside voice showed that reopens the settlement state machine for no
reason and creates an **unbonded-claim griefing surface**. We pivoted to a
**smaller-blast-radius** design that leaves the audited settlement machine **untouched**:

- **Signed/announced intent, no escrow up front.** The user announces an intent on-chain
  via a tiny stateless `announceIntent` event emitter. No funds move, no state.
- **The solver builds the swap.** A solver reads `IntentAnnounced` events, picks a
  `destAmount ≥ minDestAmount`, and calls the **existing `createSwap`** with the real
  amount + four role addresses. Settlement (`Created → Executed | Refunded`),
  per-leg idempotency, fee/sweep — **all unchanged**.
- **Real competition, no auction.** Several solvers can each `createSwap` for one intent,
  each with its **own salt → own deposit address → own TEE key**. The user sees the
  competing quotes and **funds the best one**. Funding *is* the commitment; no lock to grief.
- **User funds only after reviewing a concrete on-chain swap** (auto-verifying its CID
  against the audited template), so there is no escrow-before-counterparty risk.

Surviving fixes from the first pass: **F1** four-address model (a real cross-chain bug),
**F2** client-random salt.

---

## What already exists (reused UNCHANGED)

The audited settlement machine is not touched. This is the core win of the pivot.

| Existing | After this change |
|----------|-------------------|
| `engine.js` `runSwap` gate (`state == Created`) | **unchanged** |
| `Created → Executed \| Refunded` state machine | **unchanged** |
| Per-leg idempotency, fee, sweep | **unchanged** |
| 11 action templates + `lib/` leg drivers, derive mode | **unchanged** |
| `createSwap` | params extended (4 addresses + `intentId` + `minDestAmount`) |
| `engine.js` address reads | **fixed** (F1 four-address mapping) |
| Foundry suite (39) / `engine.test.js` / `utxo-math.test.js` | extended |

---

## Two findings that gate the work (carried from the first review)

### F1 (CRITICAL) — the 2-address model is a latent cross-chain bug

`SwapContract.sol` stores only `refundAddressSource` / `refundAddressDest`, but
`engine.js` uses them on **opposite chains** by path:

```
SETTLE cross (engine.js:247-262)        REFUND on expiry (engine.js:207-210)
  source funds  -> refundDest             source funds -> refundSource
  dest   funds  -> refundSource           dest   funds -> refundDest
```

`refundSource` is read as a dest-chain address on settle and a source-chain address on
refund. Works today only because the demo points all four roles at one EVM wallet on
EVM↔EVM (`swap-engine.js:72-73`). A real user + solver on different families ⇒ refund to
the wrong chain ⇒ lost funds. A two-party market needs four role-named addresses:

```
FOUR-ADDRESS MODEL
                     success (settle)         failure (refund)
  source asset ────► solverReceiveSource ───  userRefundSource
  dest   asset ────► userReceiveDest     ───  solverRefundDest

  user provides (in the intent):  userRefundSource (src chain), userReceiveDest (dest chain)
  solver provides (at createSwap): solverReceiveSource (src chain), solverRefundDest (dest chain)
```

### F2 — random salt (kills the swapId-prediction race)

`generateSalt` keys on the predicted next id (`swap-engine.js:163, 226-235`). Move to
`crypto.getRandomValues` (32 bytes). CID verify already takes the salt as input.

---

## Architecture

### Lifecycle (no new on-chain states)

```
USER (index.html)                CONTRACT (Base)                  SOLVER (solver.html)
  announceIntent ───────────────► (event only) ── IntentAnnounced ─► order book
                                                                     pick destAmount>=floor
                                                                     random salt -> derive
                                          Created ◄─ createSwap(──────┘  (own deposit addrs)
  sees competing quotes ◄── SwapCreated(intentId, destAmount, salt) ─┘
  auto-verify CID, pick BEST quote
  fund source -> that swap's depositSource ──►                       polls source funded
                                                                     fund dest -> depositDest
                                                                     execute (Lit Action)
  watch ◄──── markLegSettled x2, markExecuted ◄──── runSwap settles cross (4-addr) ──┘
  receives dest; receipt          Executed                          receives source; receipt
        │ no fill / ghost
        ▼ expiry -> markRefunded -> drains to userRefundSource / solverRefundDest (existing path)
```

**Why competing quotes don't collide:** each solver's swap uses a **distinct salt →
distinct CID → distinct TEE key → distinct deposit addresses**. The user funds exactly
one swap's `depositSource`; only that swap's Lit Action can spend it. Losing quotes stay
unfunded and expire. No cross-settlement, no shared-address hazard.

### Contract changes (`contracts/src/SwapContract.sol`) — small + auditable

1. **F1 four-address fix.** Replace `refundAddressSource`/`refundAddressDest` (struct +
   `createSwap` params + `getSwapAddresses`) with `userRefundSource`, `userReceiveDest`,
   `solverReceiveSource`, `solverRefundDest`.
2. **`announceIntent(...)` — stateless event emitter** (NO storage, NO state machine):
   ```
   function announceIntent(
     bytes32 intentId, string sourceChain, string destChain,
     uint256 sourceAmount, uint256 minDestAmount, uint256 expiration,
     uint16 feeBps, address tokenSource, address tokenDest,
     string userRefundSource, string userReceiveDest
   ) external; // emits IntentAnnounced(intentId, msg.sender, ...all params)
   ```
   `msg.sender` authenticates the user — no separate EIP-712 layer needed (the announce
   tx *is* the signature). Anyone can read the event; the solver fills it.
3. **`createSwap` gains `bytes32 intentId` + `uint256 minDestAmount`** (stored), and
   **emits the `salt`** in `SwapCreated` so the user app can auto-verify the CID. Solver
   is `msg.sender`/`creator` (informational; `onlyLitAction` still guards settlement).
4. **No** new states, claim/release, or gate change. Settlement machine is frozen.

### Engine changes (`app/actions/lib/engine.js`)

- **F1 mapping:** read the four role addresses; settle → `solverReceiveSource` /
  `userReceiveDest`; refund → `userRefundSource` / `solverRefundDest`.
- **Floor assert (trustless defense):** read `minDestAmount`, assert
  `destAmount >= minDestAmount` before settling — so a solver can't build a sub-floor
  swap and settle it against a user who skipped the UI check.
- **ABI:** `getSwapAddresses` return shape changes 2→4 strings; **every positional index
  in `engine.js:193-196` shifts**. Update the in-action ABI here AND the browser ABI; a
  test asserts the role mapping (see C2 — a doc note is not a guardrail).
- **Gate stays `state == Created`.** `destAmount` is always set by `createSwap`, so the
  old `destAmount==0` balance-gate hole never exists.

### UI topology (two entry points, one shared core)

```
app/
  lib/
    contract.js     # ABI + createSwap/announceIntent/getSwap reads  (single browser ABI home)
    derive.js       # random salt + CID + deriveAddresses + action dispatch
    intents.js      # event reader: IntentAnnounced (open book) + SwapCreated (quotes per intent)
    verify.js       # recompute CID from emitted salt -> compare to stored litActionCid
    ui.js           # log/tabs/theme chrome
  index.html        # USER  -> user-app.js   (Announce, Compare quotes, Verify+Fund, Receipt)
  solver.html       # SOLVER -> solver-app.js (Order book, Quote+Create, Fund dest, Execute)
  (swap-engine.js refactored into lib/* + two controllers; NO logic forked — see C1)
```

---

## Phasing & worktree parallelization

| Step | Modules | Depends on |
|------|---------|-----------|
| P1 Contract: 4-addr + announceIntent + intentId/minDestAmount + Foundry tests + audit-the-diff | `contracts/` | — |
| P2 Engine: 4-addr mapping + floor assert + ABI + mapping test | `app/actions/lib/`, `test/` | P1 (ABI frozen) |
| P3 Shared core extraction (`app/lib/*`) + F2 random salt | `app/lib/` | P2 |
| P4a User app | `app/index.html`, `app/lib/user-app.js` | P3 |
| P4b Solver app + order book | `app/solver.html`, `app/lib/solver-app.js`, `app/lib/intents.js` | P3 |

- **Lane A:** P1 → P2 → P3 (sequential; each freezes an interface).
- **Lanes B/C:** P4a ‖ P4b in parallel worktrees after P3.
- **Conflict flag:** both P4 lanes import `app/lib/`; freeze `contract.js` + `intents.js`
  signatures at the end of P3 before forking.
- **Audit sequencing (outside-voice #6):** the contract diff is now small (struct +
  one event emitter + two params, no state machine). Get the contract reviewed
  **inside P1, before the ABI is frozen for P2/P3/P4** — don't defer it past the UI fork.

---

## Test plan (coverage targets)

```
CONTRACT (Foundry — extend SwapContract.t.sol)
  announceIntent
    ├── [GAP] emits IntentAnnounced with msg.sender + all params; writes no storage
  createSwap (extended)
    ├── [GAP] stores intentId + minDestAmount; emits salt in SwapCreated
    ├── [GAP] four address fields round-trip via getSwapAddresses (offsets!)  *** CRITICAL ***
    ├── [★ keep] existing create/settle/refund tests, updated to 4-addr signature  *** REGRESSION ***
  settlement (UNCHANGED machine, re-run against new struct)
    └── [★ keep] markLegSettled / markExecuted / markRefunded all still pass

ENGINE (engine.test.js — real runSwap, mock base)
    ├── [GAP] settle mapping -> solverReceiveSource / userReceiveDest          *** CRITICAL ***
    ├── [GAP] refund mapping -> userRefundSource / solverRefundDest (the F1 bug) *** CRITICAL ***
    ├── [GAP] reject settle when destAmount < minDestAmount (floor assert)
    ├── [GAP] getSwapAddresses 4-tuple positional decode is correct           *** CRITICAL ***
    └── [★ keep] per-leg idempotency / resume / insufficient_funds, updated ABI

INTENTS / ORDER BOOK (new intents.test.js)
    ├── [GAP] IntentAnnounced scan returns open intents (no settled swap yet)
    ├── [GAP] SwapCreated grouped by intentId -> competing quotes list
    ├── [GAP] getLogs range chunking across block windows (RPC cap) — no silent truncation
    └── [GAP] verify.js recomputes CID from emitted salt and flags mismatch

USER FLOW (manual / browse)
    ├── [GAP] announce -> see >=2 competing quotes -> pick best -> CID auto-verifies -> fund
    ├── [GAP] solver ghosts after fund -> expiry refund returns source to userRefundSource
    └── [GAP] funding swap A never lets swap B (losing quote) settle (distinct deposits)

SOLVER FLOW
    ├── [GAP] [→E2E] read intent, quote, createSwap, EVM dest one-click fund, execute
    ├── [GAP] non-EVM dest shows address + exact amount + manual-send instructions
    └── [GAP] two solvers quote same intent -> both swaps valid, user funds one
```

**Regression-by-construction (mandatory):** the F1 four-address mapping (settle *and*
refund) and the 4-tuple positional decode. These change behavior the current suite
assumes; they are the highest-priority tests.

---

## Failure modes (new codepaths)

| Failure | Test? | Handled? | User sees? |
|---------|-------|----------|------------|
| Solver builds sub-floor swap | engine + contract | engine asserts `destAmount>=minDestAmount`; UI shows floor | quote flagged / settle refuses |
| Refund to wrong-chain address (F1) | engine | 4-address fix | n/a once fixed |
| 4-tuple decode offset wrong (outside-voice #7) | engine mapping test | named decode + test, not a doc note | n/a |
| Solver ghosts after user funds source | flow test | expiry → drain to `userRefundSource` | refunded after expiry (use short expiry) |
| User funds a losing quote's deposit | flow test | distinct salt/key per swap → only that swap settles | only chosen quote executes |
| `getLogs` block-range cap on intent/quote scan | intents test | chunk + `fromBlock` floor + cache | spinner, **never a silent empty book** |
| User never funds; solver never funds | contract test | expiry → Refunded (nothing to drain) | harmless |

**Critical-gap rule:** the order-book / quote scan must never *silently* truncate on RPC
range limits — if it can't read all blocks, it must say so, or solvers/users miss orders.

---

## NOT in scope (deferred, with rationale)

- **On-chain / off-chain price auction** — the competing-`createSwap` quotes already give
  price discovery; a formal auction is a later optimization.
- **Solver bonding / slashing** — unnecessary in this model; there is no lock to grief
  (a solver only spends its own gas to quote and its own funds to fill).
- **Partial fills** — one solver fills one swap whole.
- **Automated non-EVM funding** — solver sends BTC/ZEC/etc. manually; UI shows address +
  amount (3A).
- **Backend / indexer** — order book is a client-side `getLogs` scan; no server.
- **EIP-712 off-chain intent signing** — unneeded; on-chain `announceIntent` sender is the
  authenticator.
- **Guided single-card UX redesign** (TODOS.md P2) — separate UX work.
- **Solver auth / allowlist** — anyone can solve.

---

## Code-quality notes

- **C1 (DRY):** refactor `swap-engine.js` into `app/lib/*`; do **not** fork it into two
  copies. The browser ABI gets one home (`lib/contract.js`); the in-action `engine.js` ABI
  stays separate (runs in the Lit sandbox) — but see C2.
- **C2 (the #7 guardrail):** there are now **two** ABIs that must agree on the
  `getSwapAddresses` 4-tuple shape (`engine.js` in-action + `lib/contract.js` browser).
  A doc note is not enough — add an engine test that asserts each address lands in its
  role, so a positional-decode slip can't silently send funds to the wrong place (the F1
  class of bug).
- **Explicit > clever:** name address fields by role (`solverReceiveSource`), never by
  index. Role/chain ambiguity is what caused F1.
- **Inline ASCII diagrams to add:** the four-address model near the struct in
  `SwapContract.sol`; the intent→quote→fund→settle sequence atop `solver-app.js`.

## Performance notes

- Only new cost is the event scan (`IntentAnnounced` + `SwapCreated`). Mitigate with a
  `fromBlock` deploy-block floor, chunked ranges, and caching the last-scanned block.
  It's RPC log paging, not a DB N+1; fine for v1.
```
```

## Open question already disclosed + accepted

- v1 competition is "each solver posts a quote by building a swap; user funds the best."
  That is genuine price discovery, but a solver pays gas to quote even if not chosen
  (the market-maker's cost). Accepted for v1; a gasless-quote channel is a later option.

---

# UI / Design spec (from /plan-design-review — all 7 passes)

Calibrated against DESIGN.md ("Settled"). Key reconciliation: DESIGN.md already
anticipates data — JetBrains Mono is reserved for raw on-chain amounts and General Sans
carries `tabular-nums` for aligned numbers (DESIGN.md typography). A disciplined ledger
is *within* the system. What's banned is a cold trading-terminal grid.

### Design decisions (resolved)
- **D1 — Order book = warm ledger rows.** Warm canvas, gold accent on the single
  actionable row, JetBrains-Mono tabular amounts, denser than the swap card but not a
  data grid. No thick borders, no zebra stripes, no column chrome.
- **D2 — Quote selection = sort-by-rate, pre-highlight best, deliberate "Fund this
  quote" tap.** Never auto-fund. Funding moves real value → it is always a conscious act.
- **D3 — Solver app = same Settled tokens, pro density.** Same gold/fonts/canvas (it must
  read as Settled), wider container (≈960px vs the consumer 520px), ledger density, and a
  "My Quotes / My Fills" workspace. No separate dark terminal skin.

## Pass 1 — Information architecture (3 → 9/10)

**User app (`index.html`) — what they see first → last:**
```
1  Hero: "Move value across chains. No one holds it but math."  (unchanged trust line)
2  ONE action: "Announce an intent"  (From→To, give amount, min receive, my addresses)
3  After announce: "Your intent is live" + the competing-quotes panel (fills in as solvers quote)
4  Fund moment: best quote highlighted, "Fund this quote" CTA
5  Settlement progress: two legs settling one at a time -> "receipt signed" payoff (DESIGN.md)
6  Secondary, behind disclosure: CID/salt/deposit-address technical truth, gas detail
```

**Solver app (`solver.html`) — what they see first → last:**
```
1  Order book (the workspace): warm ledger of open intents, newest/best-margin first
2  Row hierarchy:  PAIR (gold)  >  you-receive amount  >  min-you-send floor  >  expiry countdown
3  Selected order -> Quote panel: enter destAmount (>= floor), your two addresses, "Create swap" 
4  After create: "Waiting for user to fund source" status on that order
5  Fund dest: EVM = "Send X" wallet button; non-EVM = address + exact amount + copy + manual note
6  Execute -> settlement progress -> receipt; row moves to "My Fills"
   Left rail / tabs: Order Book | My Quotes | My Fills
```
ASCII layouts for both go inline atop `user-app.js` / `solver-app.js`.

**Constraint worship:** order-book row shows only 4 things — pair, you-receive,
floor, expiry. Everything else (chains' full names, CID, deposit addr) is on row-expand.

## Pass 2 — Interaction states (2 → 9/10)

The order book is **event-scanned over RPC** — its states are the make-or-break work.

```
SURFACE            | LOADING            | EMPTY                      | ERROR                  | STALE/PARTIAL
-------------------|--------------------|----------------------------|------------------------|------------------------
Order book scan    | skeleton ledger    | "No open intents right     | "Couldn't reach Base   | "Showing orders to block
                   | rows (3-4 shimmer) | now. New intents appear    | RPC. Retry."           | N. Some may be missing —
                   |                    | here as users post them."  | (keep last good list)  | rescanning…" (NEVER a
                   |                    | + warmth, not "0 results"  |                        | silent truncated book)
Competing quotes   | "Waiting for       | "No quotes yet. Solvers    | per-quote: "this swap   | "More quotes may arrive
(user app)         | solvers to quote…" | usually respond within     | failed CID check —     | until your intent
                   | animated dots      | ~N min." + cancel option   | hidden" (auto-verify)  | expires at HH:MM"
Announce intent    | "Publishing…"      | n/a                        | wallet reject / gas:   | n/a
                   | (tx pending)       |                            | inline, re-submittable |
Fund (user/solver) | "Confirm in wallet"| n/a                        | reject/underpay shown  | "Funded, waiting for the
                   | -> "Sent, N confs" |                            | with exact shortfall   | other side" (both-legs)
Execute            | "Settling leg 1 of | n/a                        | insufficient_funds ->  | "Leg 1 settled, retrying
                   | 2…" leg-by-leg     |                            | which side + shortfall | leg 2" (resume path)
Settlement done    | -> receipt reveal  | n/a                        | refund_incomplete ->   | "Refunded after expiry"
                   |                    |                            | "we'll retry the drain"|
```
**The truncated-book state is a design requirement, not just an eng note:** if the scan
can't read all blocks, the book must visibly say "some may be missing — rescanning," never
present a partial list as complete. A solver acting on a stale book loses money.

Empty states get warmth + a primary action (DESIGN.md calm/trustworthy mood), never
"No items found."

## Pass 3 — User journey & emotional arc (3 → 9/10)

```
USER
STEP            | DOES                  | FEELS                  | DESIGN SUPPORTS
----------------|-----------------------|------------------------|---------------------------
announce        | posts intent          | "did that work?"       | instant "intent is live" + shareable id
wait for quotes | watches               | ANXIOUS (core moment)  | live "waiting for solvers ~Nmin", quotes
                |                       |                        | animate in, never a dead screen
pick + fund     | funds best quote      | "am I getting a fair   | best pre-highlighted, effective rate shown
                |                       | rate? is this safe?"   | in plain units, CID auto-verified ✓ badge
settling        | watches legs          | hopeful / impatient    | leg-by-leg progress, slower chain labeled
done            | sees receipt          | RELIEF + trust         | signed-receipt payoff moment (DESIGN.md)
no fill         | intent expires        | disappointed           | "no solver filled — nothing was ever at
                |                       |                        | risk" (true: no escrow until fund)

SOLVER
quote           | builds swap           | "will I win this?"     | clear floor + their margin preview
wait for fund   | watches their order   | uncertain              | "waiting for user to fund source" status
win/lose        | user funds someone    | win: act / lose: meh   | won -> "fund dest now"; lost -> row greys,
                |                       |                        | "user chose another quote" (honest)
fill            | funds + executes      | satisfaction           | receipt + moves to My Fills
```
Time-horizons: 5-sec (does it look trustworthy + alive), 5-min (can I tell if I'm being
filled), 5-year (a market maker trusts the fill/refund accounting).

## Pass 4 — AI-slop guardrails for the new surfaces (5 → 9/10)

The order book is the highest slop-risk surface. Banned, explicitly:
- No 3-column feature-card grid, no icon-in-colored-circle rows.
- No zebra-striped cold data table, no thick borders, no `border-left: 3px accent`.
- No centered-everything; ledger numbers are right-aligned (tabular), labels left.
- No purple/blue gradient; gold accent only on the actionable row + primary CTA.
- Empty/zero states are written copy with warmth, never "No results."
Each order row earns its pixels: pair, amount-in, floor, expiry, one action. That's it.

## Pass 5 — Design-system alignment (4 → 9/10)

- **Density reconciliation:** consumer app stays 520px single-card. Solver app widens to
  ~960px and uses ledger density — both use the same tokens, radius scale, and the
  JetBrains-Mono-for-amounts rule. Document a `--container-pro: 960px` alongside the
  existing widths in the `:root` block (`index.html` CSS vars).
- New components to add to the system vocabulary: `ledger-row`, `quote-row`
  (best-highlighted variant), `countdown` (expiry), `state-banner` (stale/truncated).
  Reuse existing `badge-*`, `status-box`, `form-section`, `trust` panel.
- Mono only for amounts/addresses/CIDs/hashes; Fraunces for the hero only; General Sans
  for all labels/UI (DESIGN.md typography roles).

## Pass 6 — Responsive & accessibility (2 → 9/10)

- **Order book on mobile (<480px):** ledger row collapses to a 2-line stacked card —
  line 1 = pair + you-receive (gold), line 2 = floor + expiry; tap to expand. Not a
  horizontally-scrolling table.
- **Quote comparison on mobile:** vertical list, best pinned top with the highlight; the
  "Fund this quote" CTA is a full-width 52px button (matches existing `.btn`).
- **Keyboard:** order book rows are focusable (`role="row"`, arrow-key move, Enter =
  select); quote selection is a radiogroup (best pre-checked), Space/Enter funds; the
  fund CTA is never reachable without a deliberate focus + activate.
- **Touch targets ≥ 44px** (already the app standard); note the existing TODOS.md item:
  bump inputs from 14px → 16px to stop iOS zoom — fold into this work since both apps add forms.
- **Screen readers:** live region announces "quote received," "intent funded," "leg 1
  settled" so a non-sighted user follows the async arc. ARIA landmarks per app
  (book = `region` "Open intents"; My Fills = `region`).
- **Contrast:** gold CTA uses ink text `#231A08` on gold (DESIGN.md — white-on-gold fails
  contrast); the actionable-row gold tint must keep AA against ink text.

## Pass 7 — Resolved / deferred design decisions

| Decision | Resolution |
|----------|-----------|
| Order-book density | D1 — warm ledger rows |
| Quote pick UX | D2 — sort + pre-highlight + deliberate fund |
| Solver skin | D3 — Settled tokens, pro density, My Quotes/My Fills |
| Truncated-book state | Required visible "some may be missing" banner |
| Mobile order book | Stacked 2-line cards, not scrolling table |
| iOS input zoom (TODOS P3) | Folded in — both apps add forms |

### NOT in scope (design)
- Real-time push/websocket order book — v1 polls on an interval + manual refresh; "live"
  is poll-driven, disclosed in the stale banner.
- Solver analytics / P&L dashboard — My Fills is a list, not a reporting suite.
- Dark-mode bespoke tuning for the ledger — inherits the existing dark tokens; fine-tune later.
- Multi-language / RTL — deferred.

### What already exists (design) — reuse, don't reinvent
DESIGN.md (full system), `badge-*`, `status-box`, `.btn`/`.btn-primary`, `form-section`,
`trust` panel, theme toggle, the leg-by-leg settlement-progress concept (DESIGN.md calls
it "a first-class moment" — build it now, it pays off in both apps' settling state).

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEARED | scope locked; F1 4-address bug + F2 salt found; 3 critical regression tests; pivoted to lower-blast-radius signed-intent model after outside voice |
| Outside Voice | Claude subagent | Independent challenge | 1 | issues_found | 7 findings → forced the architecture pivot (Codex unavailable on this account) |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEARED | 3/10 → 9/10; 9 decisions; D1 ledger rows, D2 deliberate fund, D3 pro density; full state/journey/a11y spec added |

- **CROSS-MODEL:** outside voice (Claude subagent) drove the pivot from in-place state-machine edits to the signed-intent model — strictly smaller blast radius on the audited contract.
- **UNRESOLVED:** 0
- **VERDICT:** ENG + DESIGN CLEARED — ready to implement. Start Lane A (contract: F1 4-address fix + announceIntent + tests + audit-the-diff), then engine, then split the two UIs.

_Note: gstack review-log analytics binaries are not installed in this environment, so the /ship review dashboard won't auto-populate; this report is the source of truth._
