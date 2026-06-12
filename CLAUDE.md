# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start the Vite dev server (live preview during development).
- `npm run build` — type-check (`tsc`) **and** produce the production bundle (`vite build`).
- `npm run preview` — serve the built bundle locally.

There is no test suite and no linter configured. "Verification" means running
the dev server and checking behaviour in the browser. The app is deployed to
GitHub Pages (https://benperche.github.io/StagePlan/).

### tsc noEmit footgun (important)

`tsconfig.json` sets `noEmit: true` on purpose. The `tsc` in `npm run build`
is a **type-check only** — Vite/esbuild does the real transpile. Without
`noEmit`, `tsc` dumps compiled `.js` next to every `.ts` in `src/`, and the
dev server then serves those **stale `.js` instead of the live `.ts`** —
silently running old code. The stray `.js` files are gitignored
(`src/*.js`); if you ever see them in `src/`, delete them.

## Architecture

Vanilla TypeScript + Vite, **no framework**. A single `<canvas>` renders the
entire chart; the DOM is only the sidebar/controls. See **`CODEREF.md`** for
the authoritative, detailed developer reference — read it before non-trivial
work. The big picture:

- **`src/types.ts`** — pure data shapes (`Chair`, `Row`, `ChartConfig`,
  `FixedInstrument`). The schema; no logic.
- **`src/state.ts`** — factories (`makeChair`, `makeRow`, `makeDefaultConfig`,
  `makeInstrument`), `cloneConfig`, and the `History` class for undo/redo.
- **`src/renderer.ts`** — the `Renderer` class. Pure function of a
  `ChartConfig` → pixels on a canvas, plus hit-test methods. **Zero awareness
  of the DOM/sidebar.** Holds the cached background `Image`.
- **`src/instrument-glyphs.ts`** — stateless draw functions for each fixed
  instrument glyph; each draws at (0,0) and returns its bounding box.
- **`src/presets.ts`** — preset library + Boosey & Hawkes notation parser
  (`parseOrchestraNotation`) + row builder (`buildPreset`/`buildOrchestraRows`).
- **`src/serializer.ts`** — JSON save/load, URL-hash encode/decode, PNG export.
- **`src/library.ts`** — IndexedDB chart library (DB `stageplan`); pure storage,
  no UI.
- **`src/main.ts`** — the UI glue: app state, event handlers, init, render loop.
- **`src/dom.ts`** — every `document.getElementById` lookup in one place. Adding
  a control to `index.html` means registering it here too.

### Central data flow

- `config` is a **module-global in `main.ts`** — the single source of truth.
- **Wholesale replacement** (load JSON, undo, redo, hash-load) goes through
  `setConfig(newConfig)`, which migrates, clears stale UI state, syncs the
  sidebar, and re-renders.
- **In-place mutation** (most user actions) mutates `config` directly, then
  calls `renderChart()`. Push onto `history` *before* mutating.
- **Sidebar ↔ config bindings** are table-driven: every input is registered
  with a `bindText` / `bindBool` / `bindNumber` helper (getter + setter) at the
  top of `main.ts`. `readInputs()` runs all setters, `updateAllInputs()` runs
  all getters. **Adding a sidebar field is one `bind*` call**, not three edits.

### Rendering & coordinates

- The renderer draws at **fixed logical pixel sizes** and applies one uniform
  **auto-fit scale** (`computeFitScale` → `renderer.viewScale`) as the
  outermost `ctx.scale()`, so the chart fills the canvas without overflowing.
  `config.chartScale` is a separate **manual override** applied as an inner
  transform around the conductor. A background photo disables auto-fill.
- **HiDPI**: canvas backing = `cssPx * devicePixelRatio` (capped 3×). The
  renderer separates `fit` (CSS = viewScale) from `fit * dpr` (the real
  ctx.scale). `renderDpr` in `main.ts` is the single source of truth.
- Hit targets are stored in **logical (CSS-space)** coords. `pointerCanvasCoords`
  divides the incoming pointer by `viewScale * renderDpr`; `chairScreenPos`
  multiplies by `viewScale` (CSS, no dpr) and adds `canvas.offsetLeft/offsetTop`.
- **View zoom/pan** is a pure CSS transform on the `<canvas>` element — it never
  touches `config`, history, PNG export, or print (those always render the full
  chart at full resolution).

### UI structure

Four sidebar tabs (Setup / Edit / Layout / Export) plus a slide-in **library
drawer** ("📁 My charts"). Undo/redo and zoom are floating overlay buttons on
the canvas, not in any tab. Below 640px the layout stacks into a column (chart
pinned to top, controls scroll underneath, sticky `.tab-bar`).

## Conventions

- Commit messages must end with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Commit and push after every change**, once verified. This is the default expected workflow — do not wait to be asked.
- Keep `CODEREF.md` updated when architecture changes — it's the detailed
  reference future work depends on.
