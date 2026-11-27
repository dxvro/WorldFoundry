# CLAUDE.md — WorldFoundry Frontend Design Rules

## Stack & architecture
- Frontend package: `packages/frontend` (React 19, TypeScript, Vite 8, Tailwind CSS v4 via `@tailwindcss/vite`, `lucide-react`).
- Styling system: semantic CSS variables (`--wf-*`) mapped to Tailwind v4 `@theme` tokens in `packages/frontend/src/styles.css`, plus component classes in `@layer components`.
- No switch to external UI kits (no MUI, Chakra, AntD). Stay with Tailwind v4 + `src/components/ui.tsx` + `lucide-react`.

## Hard guardrails for design work (do not break)
These rules apply to design work: changes to the look, layout and wording of the interface. Feature work (new games, mod sources, API changes) may change the backend and `src/lib/` as needed; its new interface parts still follow rules 1, 3, 4 and 5.
1. **i18n is mandatory:** Never hardcode visible text in JSX. All labels, hints and error messages go through `useI18n()` (`src/i18n/`).
2. **Leave logic untouched:** In design work, do not change business logic in `packages/backend/`, `src/lib/`, `src/auth/` or `src/console/` (model, history, scroll, session), unless it is strictly needed for pure UI state binding.
3. **Stay true to the tokens:** No raw hex colors in TSX components. Use only the semantic Tailwind utilities (`bg-canvas`, `bg-panel`, `bg-raised`, `bg-hover`, `border-line`, `border-line-strong`, `text-ink`, `text-dim`, `text-faint`, `text-accent`, `text-ok`, `text-warn`, `text-bad`).
4. **Keep both themes:** Every change in `:root` must keep a high-contrast, readable counterpart in `:root[data-theme='light']`.
5. **Keep accessibility:** Do not remove existing `aria-*` attributes, `:focus-visible`, `@media (pointer: coarse)` or `prefers-reduced-motion`.
6. **Design reference:** Read `DESIGN.md` before every UI change and follow all tokens, radii and anti-patterns defined there.

## Required checks after every change
Run in `packages/frontend`:
- `npm run typecheck`
- `npm run test` (especially `App.test.tsx`, `AppShell.test.tsx`, `MemoryRange.test.tsx`, `messageRefs.test.tsx`)
