# DESIGN.md — WorldFoundry Visual System

## Guiding idea
A calm, precise desktop power tool for self-hosting and managing servers of many games. High information density without visual noise, and a clear hierarchy between navigation, live status and actions.

## Color tokens (dark default in `styles.css`)
The variable names are the ones in the code. `--wf-green` and `--wf-green-deep` are historical names: they hold the accent, whatever its hue.
- `--wf-ground` (`bg-canvas`): `#0B0C10` — main background
- `--wf-surface` (`bg-panel`): `#131820` — primary panels & cards
- `--wf-raised` (`bg-raised`): `#1F2833` — raised surfaces, inputs, secondary buttons, popovers
- `--wf-hover` (`bg-hover`): `#283342` — hover state on surfaces & table rows
- `--wf-grey` (`border-line`): `#25303D` — subtle dividers & panel borders
- `--wf-grey-light` (`border-line-strong`): `#364659` — interactive borders (inputs, controls)
- `--wf-text` (`text-ink`): `#F1F5F9` — primary text & headings
- `--wf-text-dim` (`text-dim`): `#C5C6C7` — secondary text, labels
- `--wf-text-faint` (`text-faint`): `#8896A6` — hints, metadata, timestamps
- `--wf-green` (`text-accent` / `bg-accent`): `#66FCF1` — primary CTAs, active focus, selected state
- `--wf-green-deep` (`border-accent-strong`): `#45A29E` — secondary accents, subtle borders, hover tints
- `--color-on-accent`: `#0B0C10` — high-contrast text on `#66FCF1`

## Semantic status colors (deliberately separate from the accent!)
- `--wf-ok` (`--color-ok`, online / success): `#34D399`
- `--wf-warn` (`--color-warn` / `--color-busy`, starting / stopping / warning): `#FBBF24`
- `--wf-bad` (`--color-bad`, crash / error / destructive): `#F87171`
- `--wf-bad-strong` (`--color-bad-strong`): `#DC2626`
- `--wf-idle` (`--color-idle`, offline / stopped): `#64748B`

## Light theme (`:root[data-theme='light']`)
- Ground `#F4F6F8`, surface `#FFFFFF`, raised `#EBEEF2`, border `#D5DCE4`, ink `#0F172A`, dim `#475569`.
- Darken the accent on the light ground (`#0F766E` / `#115E59`) with `--color-on-accent: #FFFFFF`, so WCAG AA contrast holds.

## Typography
- UI sans: `Inter Variable` (replaces `Nunito Variable`, via `@fontsource-variable/inter`) — neutral, sharp, easy to scan.
- Monospace: `JetBrains Mono Variable` — required for the console (`.console-body`), ports, IPs, RAM values, version numbers, mod hashes and `.num` (`tabular-nums`).
- Headings: `font-weight: 600–700`, tight tracking (`-0.015em`), no oversized sizes.

## Geometry, spacing & motion
- **Radii:**
  - Panels / modals (`.panel`): `0.75rem` (12px)
  - Buttons, inputs, selects, tabs: `0.5rem` (8px) — no `999px` pills for standard buttons or nav tabs
  - Chips / status badges (`.chip`) & switches: `999px` (stay round to set them apart from buttons)
- **Depth:** Separate surfaces with clear 1px borders (`border-line`) and fine steps of brightness (`canvas` → `panel` → `raised`) instead of heavy drop shadows.
- **Motion:**
  - No global fade-in animations on `.panel` (no `animate-rise` on every tab change).
  - No vertical bouncing (`translateY`) on buttons or server cards; use calm border and background transitions instead (`120–150ms ease`).
  - Reduce `.backdrop` and `body::before` strongly or remove them completely (at most a very subtle static gradient in the header area).

## Game identity (`src/games/look.ts` & `GameTile.tsx`)
- Every game keeps its icon and a subtle accent color as a 2–3px side stripe, icon tint or compact badge.
- No full-surface, loud colorful game cards that break the dark overall look.

## Anti-patterns (forbidden)
- No nested `.panel`-in-`.panel` boxes (separate inner groups with `border-t border-line` or `bg-raised/50`).
- No neon glow spam (`box-shadow` with bright cyan on every card).
- No restless hover jumping in tables or server lists.
