# StagePlan — Developer Reference

Internal notes for working on the codebase. Not user-facing.

## Stack & layout

- **Vite + TypeScript**, no framework — vanilla DOM + a single canvas.
- **HTML5 Canvas** for all chart rendering. No SVG, no drawing library.
- Hosted on **GitHub Pages**. Build: `npm run build`; preview: `npm run dev`.
- Single-page: `index.html` + `src/*.ts` + `src/style.css`.

## File map (what lives where)

| File | Role |
|---|---|
| `src/types.ts` | Pure data shapes — `Chair`, `Row`, `ChartConfig`, `FixedInstrument`, hit-test types. The schema. No logic. |
| `src/state.ts` | Factory functions (`makeChair`, `makeRow`, `makeDefaultConfig`, `makeInstrument`), `cloneConfig`, and the `History` class for undo/redo. Anything that *creates* a domain object. |
| `src/renderer.ts` | The `Renderer` class. Takes a `ChartConfig`, draws it to a `<canvas>`, exposes hit-test methods. Holds the cached background `Image`. **Zero awareness of DOM/sidebar.** |
| `src/instrument-glyphs.ts` | Pure draw functions for each fixed-instrument glyph (drum kit, piano, amp, timpani, mallet, generic rectangle). Each draws at (0, 0) in the current canvas frame and returns its `{ hw, hh, labelInside }` bounding box. No class — just stateless functions. |
| `src/presets.ts` | The preset library, the Boosey & Hawkes notation parser (`parseOrchestraNotation`, `describeComposition`), and the orchestra-row builder (`buildOrchestraRows`). Self-contained: input shorthand → `Row[]`. |
| `src/serializer.ts` | Persistence — JSON save/load, URL-hash encode/decode, PNG export. The hash encoder strips `backgroundImage` (too big for a URL) and reports back. |
| `src/main.ts` | The UI/glue. App state (`config`, history, drag tracking), event handlers, init, render loop trigger. The orchestration that ties everything together. |
| `src/dom.ts` | All `document.getElementById` lookups. One file, organised by sidebar panel, so adding a new control means editing one obvious place. |
| `index.html` | Sidebar markup, modal markup, canvas element. |
| `src/style.css` | All styles. |

## Architectural rules of thumb

- **Renderer is a pure function of `ChartConfig`.** It mutates no state, holds no app state. The only exception: it caches the decoded background image so we don't re-decode every render.
- **`ChartConfig` is the single source of truth.** Saved in JSON, in URL hash, in undo history. Always a single `let config: ChartConfig` in `main.ts`.
- **`main.ts` owns mutation.** Event handlers mutate `config`, then call `renderChart()`.
- **Undo snapshots happen at the start of any user action** that changes state. `history.push(config)` before mutation. The push deep-clones via `cloneConfig`.
- **The conductor is the origin.** All chair positions are computed in polar coords relative to the conductor (semicircle layout) or in row-relative coords (straight layout). Fixed instruments are always polar from the conductor. This is what makes "drag the conductor" translate the whole chart.

## Render pipeline (one render call)

`renderer.render(canvas, config)`:

1. Clear canvas, apply `config.chartScale`
2. Draw background image (if any), per `config.backgroundFit`
3. Draw chart title (top-centre)
4. Draw notes (bottom-left)
5. Draw stage directions if enabled (left/right edges, light grey)
6. Dispatch to `renderSemicircle` or `renderStraight` based on `config.layout`
7. Draw fixed instruments on top (always visible over chairs)
8. Draw row summary (bottom-right)
9. Draw credit (bottom-centre, optional)

Hit tests are populated as a side effect of (6) and (7). `main.ts` calls `renderer.hitTest(x, y)` afterward.

## Chair positioning

### Semicircle (renderArcRow)

- Every chair gets one slot. `naturalStep = arcRange / (N - 1)` between adjacent chairs.
- Each chair's natural angle = `startAngle - i * naturalStep`.
- When two adjacent chairs form a desk pair (`standAfter` on the first, or both disabled placeholders), they shift toward the midpoint of their two natural slots until they sit `DESK_PAIR_SPACING` (56 px) apart — or stay put if their natural separation is already tighter.
- **Other chairs in the row are never affected by a pair toggle.** This was a deliberate fix in commit `e11bb43`: the old code consolidated paired chairs into a single slot, which reshuffled the whole row when you toggled a stand and pushed edge desks behind the conductor.

### Straight (renderStraight / renderStraightRowInArc)

- Chairs evenly spaced by `STRAIGHT_CHAIR_SPACING` (40 px), row centred on the conductor's x.
- Used both for pure straight layouts and for the "straight rows from back" feature in semicircle mode.

### Row spacing

- `config.rowSpacing` (default 70 px). User-configurable in the Advanced modal.
- `effectiveRowSpacing` shrinks it if the chart would overflow the canvas, floored at 40 so it stays legible.
- Sized so the seat number behind one row doesn't collide with the shared stand drawn in front of the row behind (stand reaches ~35 px forward, number ~28 px behind — 65 px floor; 70 gives a small gap).

## Allocate Instruments tool

The fourth chair tool ("Instrument") opens a sidebar panel
(`#instrument-picker-panel`) holding the canonical instrument list
grouped by section (Woodwinds / Saxes / Brass / Strings / Rhythm /
Percussion / Voice). Each instrument is one row with a `[Name]` button
plus three numbered `[1] [2] [3]` part buttons — clicking any of them
sets `selectedLabel` in main.ts to the chosen string (e.g. `"Flute"`,
`"Flute 2"`) and highlights that button.

Then any chair click (while the Instrument tool is still active) writes
`selectedLabel` into `chair.label`. Multiple chairs can be labelled in
quick succession without having to re-pick the instrument. The label
sticks until the user picks a different instrument or switches tools.

The picker is built lazily on first activation and cached; switching
between tools just shows/hides the panel.

### Instrument tally overlay

A 📊 button at the top of the Allocate Instruments panel opens a
floating overlay (`#tally-overlay`, top-right of the window) that
lists every distinct enabled chair label in the chart, grouped into
the same INSTRUMENT_GROUPS sections, with a live count per label.
Sections with no matching labels are hidden; labels that don't match
any canonical instrument (e.g. preset abbreviations like "Tpt 1")
fall through to an "Other" bucket at the bottom.

* Lives in the DOM, not the canvas — never appears on PNG exports.
* `renderTally()` is called from every `renderChart()` but bails out
  early when the overlay is hidden, so there's zero cost while closed.
* Header bar has minimise (collapse to header) and close (hide
  entirely). Clicking the picker's 📊 button again toggles the
  overlay back on.
* Labels are classified by longest-prefix match — "Bass Clarinet 1"
  matches Bass Clarinet, not Bass.

## Music stands

- `Chair.hasStand` = solo stand in front of this chair (× drawn between chair and conductor).
- `Chair.standAfter` = shared stand in the gap between this chair and the next.
- The Music Stand tool cycles: `none → solo → shared-with-next → none`. When going to shared, the next chair's `hasStand` is automatically cleared.
- Stand × is drawn by `drawStandX`. Rotated by the chair→conductor angle so the diagonals stay diagonal (not aligned with the radial — that would look like `+`).
- Default `makeChair()` returns `hasStand: true`.

## Orchestra preset (notation → rows)

`parseOrchestraNotation(string)` accepts Boosey & Hawkes shorthand:

```
Ww − Br [− Perc] − Str
2.2.2.2 - 4.2.3.1 - 1.2 - 12.10.8.8.6
3(III=Bass Clarinet).2.2.2 - 4.3.3.1 - 1.2 - 14.12.10.8.6
```

Each block is dot-separated counts. Doublings in parens (`N(Roman=Label)`) get appended to the chair label.

`buildOrchestraRows(composition)` returns `{ rows, straightRows }`:

- **Strings** sit in semicircle rows (V1 | V2 | Va | Vc→Cb columns, separated by placeholder gaps).
  - Rows 0–3: one desk per active section (a tight principal-led front).
  - Rows 4+: two desks per section (sections spread back faster).
  - The rightmost column is shared between Vc and Cb — cellos fill the front of that column, basses take over behind them, putting them naturally behind the cellos.
  - Exhausted sections get disabled placeholder desks so the column structure stays consistent.
- **Winds, brass, percussion** are straight rows at the back. The wind row splits into Fl/Ob front + Cl/Bn back when totals > 6.
- Returned `straightRows` count tells `applyPreset` how many trailing rows to render as straight lines instead of arcs.

## Presets architecture

Three ways a `Preset` can specify its rows, in priority order:

1. **`notation`** — Boosey & Hawkes shorthand. Used by Chamber Orchestra, Full Symphony.
2. **`customRows`** — explicit per-chair specification (label, colour, stand flags, optional `enabled: false` for placeholders). Used by Big Band, Concert Band.
3. **`sections`** — `[{ name, count, color, standMode }]`, auto-packed into rows of 12 chairs. Used by String Quartet, Jazz Combo.

`buildPreset(preset)` in `presets.ts` does the dispatch and turns a `Preset`
into concrete `{ ok: true, rows, straightRows, instruments }` (or
`{ ok: false, error }` if orchestra notation is malformed). It's a pure
function — no `config` mutation, no DOM. `applyPreset(preset)` in `main.ts`
is then a thin wrapper that calls `buildPreset`, pushes the result into
`config`, and re-renders.

## Fixed instruments

- Stored as polar coords `{ angle, distance }` from the conductor + `rotation` in radians.
- Eight types: drumkit, piano, guitar-amp, bass-amp, timpani (2–6 drums via `count`), mallet, square, rectangle (generic placeholders).
- Each glyph is a `draw*` method returning `{ hw, hh, labelInside }` for the bounding box.
- Drag/rotate handled by `DragState` / `RotateState` in main.ts. Selected instrument shows a green MS-Office-style rotate handle.

## Persistence

- **Save JSON**: full `ChartConfig` including `backgroundImage` as a data URL. Survives anything.
- **Share link**: `encodeToHash` strips `backgroundImage` (URLs can't carry MB-scale data) and returns `{ hash, strippedBackground }`. When stripped, the share-URL display appends a one-line warning telling the user to use Save JSON for full fidelity.
- **PNG export**: just `canvas.toBlob()`.
- **URL hash on load**: decoded by `decodeFromHash`, passed through `migrateConfig` (which merges in any newer default fields the saved config is missing).

## Coordinate conventions

- Canvas y is downward (HTML5 standard).
- "Front of stage" = bottom of canvas = +y direction. Conductor sits there by default.
- "Flipped" layout puts the conductor at the top instead.
- `yDir = -1` (default) means chairs are above the conductor (smaller y). `yDir = 1` (flipped) means below.
- Polar angle convention: 0 = right, π/2 = down, π = left, -π/2 = up.

## Common gotchas

- **`ChartConfig.straightRows`** counts straight rows from the *back*, not the front.
- **Renderer caches `backgroundImage`** by src — if you swap the image data URL but keep the same string, it won't re-decode.
- **Hit targets are stored on the Renderer instance** and reset every render. Don't call hitTest before the first render.
- **`applyPreset` calls `history.push(config)` at the top.** Don't double-push in callers.
- **The advanced modal inputs and `readInputs()` must stay in sync.** Adding a new advanced setting means: update `types.ts`, `state.ts` defaults, `index.html` markup, the DOM ref + `readInputs` + `updateAllInputs` blocks in `main.ts`, and the change-listener loop in `bindEvents`.
- **`config` is module-global in main.ts.** Any wholesale replacement (load JSON, undo, redo, hash-load) goes through `setConfig(newConfig)`, which migrates, clears stale UI state, syncs the sidebar, and re-renders. In-place mutations (most user actions) just call `renderChart()` directly.

## Sidebar ↔ config bindings

Every sidebar/modal input is registered with a paired `bindText` /
`bindBool` / `bindNumber` helper at module top in `main.ts`. Each binding
takes a getter (config → value) and a setter (value → config), including
any clamping and unit conversion. `readInputs()` runs all setters in the
order they were registered; `updateAllInputs()` runs all getters. **Adding
a new sidebar field is one `bind*` call, not three separate edits.**

Special cases (button enabled state, conditional visibility, the row list
rebuild) live in `updateAllInputs` after the binding loop.

## Known cleanup opportunities (deferred)

These were identified in the May 2026 code-quality audit. Items struck
through have since been done.

- ~~`renderStraightRowInArc` and the row-loop inside `renderStraight` are
  ~90% duplicate~~ — done, consolidated into `renderStraightRow`.
- ~~`readInputs()` and `updateAllInputs()` repeat the same ~14 fields
  twice~~ — done, replaced with table-driven `bindText/bindBool/bindNumber`.
- ~~`renderer.ts` is 1200 lines in one class. The 6 instrument-glyph methods
  (~250 lines) have nothing to do with row layout — splitting into
  `src/instrument-glyphs.ts` would clean things up.~~ — done; renderer.ts
  down to ~940 lines, glyphs now in their own module.
- ~~`main.ts` is ~1000 lines and has no internal structure — could split
  into `dom.ts` (refs), `events.ts` (handlers), `row-ui.ts` (row list).~~
  — partially done; `dom.ts` extracted. `events.ts` and `row-ui.ts`
  splits deferred (the row UI is tightly coupled to the shared `config`
  / `history` / `expandedRows` state and would need a heavy props pass).
- ~~`applyPreset` is ~270 lines doing notation/customRows/sections dispatch
  + chair construction + instrument placement. The "build rows from
  preset" part probably belongs in `presets.ts`.~~ — done; the pure build
  is now `buildPreset` in `presets.ts`, `applyPreset` is a 17-line wrapper.
- ~~State management is implicit — a `setConfig(newConfig)` wrapper that
  calls `renderChart` automatically would make data flow more obvious.~~
  — done; all wholesale config replacements go through `setConfig`.
