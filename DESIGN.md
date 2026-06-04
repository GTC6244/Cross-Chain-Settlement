# Design System — Settled (Cross-Chain Settlement)

> Read this before any visual or UI decision. All fonts, colors, spacing, and
> aesthetic direction are defined here. Do not deviate without explicit user approval.

## Product Context
- **What this is:** Trustless cross-chain swaps. A Lit Protocol Lit Action custodies
  each swap; its signing key is generated and used only inside a Trusted Execution
  Environment (TEE), attested by a complete root-of-trust system. Unique key per swap.
  No bridge, no wrapped tokens, and no one — not even Lit — can extract the key.
  (Note: keys live in a TEE, NOT a threshold/decentralized network. Do not write
  "threshold cryptography" or "decentralized custodian" in user-facing copy.)
- **Who it's for:** Consumer-facing. Approachable for non-developers; the crypto
  plumbing (chains, deposit addresses, IPFS CIDs, per-chain drivers) is hidden behind
  progressive disclosure. The *trust mechanism* is surfaced, not the plumbing.
- **Space/industry:** Cross-chain swap / bridge. Peers: Jumper (LI.FI), Across,
  Relay, NEAR Intents, Synapse, THORSwap.
- **Project type:** Single-page web dApp (`app/index.html`).

## Design Thesis
Bank-grade calm with none of the bank coldness. Light, warm, spacious. The swap is one
confident card; the trust mechanism is stated in plain language. The product's real
differentiator — *no one holds your money, the key lives only inside a TEE* — is the
hero, because no competitor can honestly say it. Hide the plumbing, reveal the trust.

## Aesthetic Direction
- **Direction:** Approachable-refined (warm minimal).
- **Decoration level:** Intentional — warm paper canvas, soft shadows. Zero terminal grain.
- **Mood:** Calm, trustworthy, human. It should feel like the swap already worked
  before you hit go.
- **Reference sites:** Jumper (jumper.exchange), Across (across.to), Relay, NEAR Intents.
- **Deliberate departures from category norms (the risks we took):**
  1. **Honey-gold accent instead of crypto-blue/purple.** Value + warmth; unmistakable.
  2. **Light-first, not dark.** "Nothing to hide" — ties to the trustless thesis. Dark
     mode is the alternate, not the default.
  3. **A soft serif (Fraunces) for display** in a category that is 100% sans/mono.

## Typography
Three voices, clear roles. Sans says "for you," mono says "this is the exact value."
- **Display/Hero:** `Fraunces` (optical serif) — warmth, trust, differentiation.
  Weights 400/500/600/700, italic used for emphasis. Headlines only — do not use for
  body or UI labels.
- **Body/UI/Labels:** `General Sans` (Fontshare) — weights 400/500/600/700.
- **Data/Tables:** `General Sans` with `font-variant-numeric: tabular-nums` for aligned
  numbers, OR `JetBrains Mono` for raw on-chain amounts.
- **Mono / technical truth:** `JetBrains Mono` (weights 400/500/600) — reserved for
  addresses, IPFS CIDs, tx hashes, and raw token amounts. Never for prose.
- **Loading:**
  - Fraunces + JetBrains Mono: Google Fonts.
  - General Sans: Fontshare CDN (`https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600,700&display=swap`).
  - **CSP note:** if font sources are locked down, self-host General Sans rather than
    drop it. Do not substitute Inter/Roboto.
- **Scale (rem, 16px base):** xs 0.8125 (13px) · sm 0.875 (14px) · base 1 (16px) ·
  lg 1.1875 (19px) · xl 1.5 (24px) · 2xl 2 (32px) · display clamp(2.5rem, 6vw, 4.25rem).
- **Tracking:** display/headlines `-0.03em`; body normal.

## Color
- **Approach:** Restrained — one accent + warm neutrals. Color is meaningful, not decorative.
- **Accent (primary):** `#E0922F` honey-gold — value, settlement, warmth. Primary CTAs
  use gold background with **ink text `#231A08`** (white-on-gold fails contrast).
- **Accent deep:** `#B8731F` — accent text on light, hover states.
- **Accent soft:** `#FBEFD9` — accent-tinted fills (quote box, badges, receipt).
- **Canvas:** `#FAF8F4` (warm paper) · **Surface:** `#FFFFFF` · **Surface-2:** `#F4F0E9`.
- **Ink (primary text):** `#1A1714` · **Muted text:** `#7A726A` · **Border:** `#ECE7DF`.
- **Semantic** (kept clearly distinct from gold so status never reads as brand):
  success `#2E9E6B` · error `#D2452F` · warning `#E0922F` · info `#3A7BD5`.
- **Dark mode** (alternate, `[data-theme="dark"]`): canvas `#14110D` · surface `#1E1A15`
  · surface-2 `#262019` · border `#322B22` · ink `#F2EDE4` · muted `#A99F92` ·
  accent `#F0A845` · accent-deep `#E0922F` · accent-soft `#2A2114` · success `#3FBF84`
  · error `#E8654F`. Reduce saturation ~10–20% vs. light.

## Spacing
- **Base unit:** 8px.
- **Density:** Comfortable (consumer, not data-dense). Card padding 28–32px.
- **Scale:** 2xs(2) xs(4) sm(8) md(16) lg(24) xl(32) 2xl(48) 3xl(64).

## Layout
- **Approach:** Hybrid — grid-disciplined inside the swap card, generous editorial air around it.
- **Hero pattern:** Single centered swap card (~520px max). The 5 tabs (Create / Status /
  Execute / Gas Preview / Verify CID) collapse into one flow; chains become a From→To
  selector; deposit addresses, CID, and gas details live behind a "Details" disclosure.
- **Settlement progress is a first-class moment:** show the two legs settling one at a
  time, ending in a "receipt signed" payoff. Do not bury it in a status box.
- **Max content width:** 1080px (page), 520px (swap card).
- **Border radius:** sm 8px (inputs, small buttons) · md 12px (cards, alerts) ·
  lg 18px (hero card) · full 999px (pills, chain selectors, status badges, wallet button).

## Motion
- **Approach:** Intentional. Transitions that aid comprehension + the settlement choreography.
- **Easing:** enter `ease-out` · exit `ease-in` · move `ease-in-out`.
- **Duration:** micro 50–100ms · short 150–250ms · medium 250–400ms · long 400–700ms.
- **Signature:** leg-by-leg settlement animation; active step pulses; theme switch ~400ms.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-06-04 | Initial design system created | /design-consultation. Consumer-facing direction confirmed by user; competitive research (Jumper, Across, Relay, NEAR Intents) + 2026 fintech trends. |
| 2026-06-04 | Honey-gold accent, not crypto-blue | Differentiation + "value/settlement" connotation. User chose this risk. |
| 2026-06-04 | Light-first (dark = alternate) | "Nothing to hide" reinforces the trustless thesis. User chose this risk. |
| 2026-06-04 | Fraunces serif for display | Warmth + memorability in a sans/mono-only category. |
| 2026-06-04 | Mono reserved for technical truth only | Sans = human-facing; mono = exact machine values (addresses, CIDs, hashes). |
