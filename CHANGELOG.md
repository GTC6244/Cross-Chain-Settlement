# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
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
- Re-skinned `app/index.html` to the Settled system: theme-aware buttons, inputs,
  tabs, status boxes, badges, and empty states. All swap functionality, element
  IDs, event handlers, and `ActionTemplates` wiring preserved.
- Renamed the app wordmark from "Action Swaps" to "Settled".
- Corrected the custody-model copy in `README.md` and the UI to TEE +
  root-of-trust: each swap's signing key is generated and used only inside a
  Trusted Execution Environment, attested by a root-of-trust system. No one,
  not even Lit, can extract it. (Previously described as threshold / decentralized
  cryptography, which was inaccurate.)
