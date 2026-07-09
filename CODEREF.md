# StagePlan — Developer Reference

Internal notes for working on the codebase. Not user-facing.

## Stack & layout

- **Vite + TypeScript**, no framework — vanilla DOM + a single canvas.
- **HTML5 Canvas** for all chart rendering. No SVG, no drawing library.
- Hosted on **GitHub Pages**. Build: `npm run build`; preview: `npm run dev`.
- Single-page: `index.html` + `src/*.ts` + `src/style.css`.
- **Layout**: desktop is a flex row — fixed-width `#sidebar` + flexible
  `#canvas-area`. Below **640px** (`@media` in `style.css`) it stacks into a
  column: the chart preview pins to the top (`order: -1`, ~42vh), the tabbed
  controls scroll underneath, and `.tab-bar` becomes `position: sticky` so the
  tabs stay reachable. The canvas backing always matches its display box 1:1
  (`resizeCanvas`) — never a fixed floor — so the chart is never squished; the
  auto-fit scale shrinks it to fit instead.

## File map (what lives where)

| File | Role |
|---|---|
| `src/types.ts` | Pure data shapes — `Chair`, `Row`, `ChartConfig`, `FixedInstrument`, hit-test types. The schema. No logic. |
| `src/state.ts` | Factory functions (`makeChair`, `makeRow`, `makeDefaultConfig`, `makeInstrument`), `cloneConfig`, and the `History` class for undo/redo. Anything that *creates* a domain object. |
| `src/renderer.ts` | The `Renderer` class. Takes a `ChartConfig`, draws it to a `<canvas>`, exposes hit-test methods. Holds the cached background `Image`. **Zero awareness of DOM/sidebar.** |
| `src/instrument-glyphs.ts` | Pure draw functions for each fixed-instrument glyph (drum kit, piano, amp, timpani, mallet, generic rectangle). Each draws at (0, 0) in the current canvas frame and returns its `{ hw, hh, labelInside }` bounding box. No class — just stateless functions. |
| `src/presets.ts` | The preset library, the Boosey & Hawkes notation parser (`parseOrchestraNotation`, `describeComposition`), and the orchestra-row builder (`buildOrchestraRows`). Self-contained: input shorthand → `Row[]`. |
| `src/serializer.ts` | Persistence — JSON save/load, URL-hash encode/decode, PNG export. The hash encoder strips `backgroundImage` (too big for a URL) and reports back. |
| `src/library.ts` | Browser-only chart library backed by IndexedDB (DB `stageplan`, stores `charts` and `folders`). Exposes CRUD: `listCharts/loadChart/saveChart/deleteChart/duplicateChart/renameChart/moveChart` and `listFolders/createFolder/deleteFolder`. Pure storage — no UI. |
| `src/main.ts` | The UI/glue. App state (`config`, history, drag tracking), event handlers, init, render loop trigger. The orchestration that ties everything together. |
| `src/dom.ts` | All `document.getElementById` lookups. One file, organised by sidebar panel, so adding a new control means editing one obvious place. |
| `index.html` | Sidebar markup (organised into three tabs — Setup / Edit / Export), modal markup, canvas element + undo/redo overlay. |
| `src/style.css` | All styles. |

## Sidebar tabs

The sidebar is organised into four tabs (single-button switch, no
nested state):

| Tab | Contains |
|---|---|
| **Setup** | Chart (title, layout, rows, flip/show-conductor/conductor-stand, **stage directions**, **show credit**), Preset Arrangements, Stage Background (incl. **Chart scale %**), Notes |
| **Edit** | Rows, Edit chairs (Hide / Stand / Stool / Colour / Label / Instruments, each with its own contextual sub-panel), Numbers & labels (display toggles), Large / Fixed Instruments |
| **Layout** | Per-row distance/span/nudge fine-tuning on the chart, default arc-range handles, Defaults (row spacing, arc range), reset buttons |
| **Export** | Save JSON, Load JSON, Export PNG, Print/PDF, Copy share link |

The chart-scale / stage-directions / credit controls used to live in a
separate "Advanced Layout" modal — that's gone; they're plain Setup controls
now. (There is no Advanced modal anymore.)

Each panel is wrapped in a `<div class="tab-content" data-tab-content="…">`
container. Clicking a tab toggles `active` on its button and on the
matching content wrapper; `.tab-content` defaults to `display: none`
and `.tab-content.active` flips to flex.

Undo and Redo live as **floating overlay buttons** in the top-left of
the canvas area, not in any tab — they're always accessible.

### Library drawer

My Charts is **not** a tab — it's a left slide-in drawer (`#library-drawer`)
opened by the "📁 My charts" button at the top of the sidebar, because the
library sits *above* the individual chart (it's how you pick/manage which
chart you're editing). It's a browser-only IndexedDB store with folders +
per-chart actions (open / duplicate / rename / move / delete). Opening a
chart or starting a new blank one closes the drawer; ✕, the backdrop, and
Escape all close it. `openLibrary/closeLibrary` in `main.ts` toggle the
`.open` class + backdrop. (Planned IA work: a "Labels" section in Edit will
absorb the instrument labelling + seat-number/row-label toggles, and a new
"Layout" tab will host per-row/per-chair geometry handles.)

## View zoom/pan (screen-only)

Floating `−  NNN%  +` controls in the bottom-right of the canvas zoom the
chart for on-screen inspection. This is a pure **CSS transform** on the
`<canvas>` element (`translate(panX,panY) scale(zoom)`, `transform-origin:
0 0`) — it never touches `config`, undo history, PNG export or print, which
always render the full chart at full resolution (print CSS forces
`transform: none`). State lives in `viewZoom/viewPanX/viewPanY` in `main.ts`.

- Buttons step by 1.25×; ctrl/cmd + wheel (= trackpad pinch) zooms toward the
  cursor; clamp `[1, 6]`.
- **Touch pinch**: the canvas has `touch-action: none`, so two simultaneous
  touch pointers are tracked in `touchPoints`/`pinchState` (main.ts, after the
  pointerup handler) — the view scales about the finger midpoint via the same
  `setZoom` maths and follows the midpoint as a two-finger pan while zoomed.
  The second finger landing aborts any in-progress single-finger gesture.
- Pan by dragging empty space while zoomed (`panState`); a non-moving press
  still falls through to the chair `click` handler, and a moved pan sets
  `suppressClickAfterPan` so it doesn't toggle a chair.
- Because the zoom is a CSS transform, `getBoundingClientRect()` already
  reflects it, so `pointerCanvasCoords` divides by `rect.width/height` to get
  backing pixels and **all hit-testing keeps working at any zoom** with no
  per-feature changes.

## Auto-fit scale (`renderer.viewScale`)

The chart is drawn at fixed pixel sizes (a chair is 30px, `BASE_RADIUS` 130,
etc.). To make it fit any canvas — a wide desktop, a short window, a phone —
`render()` computes a single uniform `computeFitScale()` and applies it as the
outermost `ctx.scale()`. It **auto-fills** a target fraction of the canvas
(`Renderer.FILL`, 0.93): small layouts scale *up*, big ones scale *down* so the
chart always fills the page-ish area without ever overflowing. This is **not**
the same as `config.chartScale` (see below); auto-fit wraps everything (title,
notes, chart) so the whole drawing fits.

- `config.chartScale` is the user's manual **override**, applied as the inner
  transform around the conductor. 100% = a clean auto-fill; >100% grows the
  seating past the fill (may clip), <100% shrinks it. So it multiplies the
  auto-fill rather than being an absolute size.
- **Exception — a background photo** (`config.backgroundImage`) switches off
  auto-fill: the chart sits at its natural size (× chartScale) so you can match
  it to the stage in the image, only shrinking to avoid overflow.
- It replaced the old `effectiveRowSpacing` height-squeeze, which pulled rows
  together to fit — that made music stands overlap the chairs of the row
  behind. Scaling the whole chart down keeps spacing proportional. (The
  function still exists but is now a pass-through returning the user's spacing.)
- `computeFitScale` estimates the chart's natural extent (`contentExtents`:
  arc/straight chair span + far-out fixed instruments) vs the canvas.
  `contentExtents` returns `back`/`front` (the up/down extents from the
  conductor); an instrument extends **only the side it actually sits on**
  (negative `dy` = behind, with the chairs). Counting both sides used to roughly
  double the natural height for a back instrument (e.g. orchestral timpani),
  shrinking the chart and reserving dead space in front of the conductor.
- `computeOy` (the conductor's vertical placement) uses `contentExtents.back` —
  i.e. the chairs **plus any instruments parked behind them** — as the
  chart's far-edge depth, so an instrument-heavy back (timpani, percussion)
  packs the chart down toward the conductor instead of floating with empty space
  below it. Both the auto-fit scale and the conductor position then agree.
- Hit targets are stored in **logical (CSS-space)** coords, so
  `pointerCanvasCoords` divides the incoming pointer by `viewScale * renderDpr`,
  and `chairScreenPos` multiplies by `viewScale` (CSS, no dpr) when placing the
  inline label editor. Everything else (angle/distance math, `canvasToChart`)
  stays in logical space.

### HiDPI / dpr

The canvas **backing store is `cssPx * devicePixelRatio`** (capped at 3×; see
`resizeCanvas`, which measures the canvas's *own* box so the mobile top-padding
strip is respected). So chairs/labels stay crisp on retina + phones, and PNG
export is dpr-sharp too. The renderer separates the two scales: `fit` (CSS) for
layout/`viewScale`, and `fit * dpr` for the actual `ctx.scale()`. `renderDpr`
(module global in `main.ts`) is the single source of truth — set in
`resizeCanvas`, passed to `render({ dpr })`, and re-used by `pointerCanvasCoords`.

### Touch hit areas

`layoutHandleHitTest` enlarges its target to a constant ~22px **on-screen**
radius when `(pointer: coarse)` matches (÷ viewScale so it doesn't shrink with
the auto-fit). The drawn handles stay the same size; only the catch area grows.

### `#canvas-area` offset

The inline label editor is positioned relative to `#canvas-area`, so
`chairScreenPos` adds `canvas.offsetLeft/offsetTop` — 0 on desktop, but ~44px
top on mobile where `#canvas-area` has a `padding-top` strip that drops the
chart below the floating undo/zoom buttons.

## Architectural rules of thumb

- **Renderer is a pure function of `ChartConfig`.** It mutates no state, holds no app state. The only exception: it caches the decoded background image so we don't re-decode every render.
- **`ChartConfig` is the single source of truth.** Saved in JSON, in URL hash, in undo history. Always a single `let config: ChartConfig` in `main.ts`.
- **`main.ts` owns mutation.** Event handlers mutate `config`, then call `renderChart()`.
- **Undo snapshots happen at the start of any user action** that changes state. `history.push(config)` before mutation. The push deep-clones via `cloneConfig`.
- **The conductor is the origin.** All chair positions are computed in polar coords relative to the conductor (semicircle layout) or in row-relative coords (straight layout). Fixed instruments are always polar from the conductor. This is what makes "drag the conductor" translate the whole chart.
- **Conductor interaction is tab-split** (`activeTab` + `conductorMovable()`). It's draggable to move the whole chart (`conductorDragState`, offset in `conductor.offsetX/Y`) in the *positioning* tabs — **Setup** (place against a background) and **Layout** ("Reset conductor position" lives there). In **Edit** it isn't draggable; clicking it renames the podium **in place** (`openConductorLabelEditor`) by reusing the same floating `#chair-label-input` as chair labels — not a `window.prompt`. `editingConductor` flags which target the shared input is bound to (mutually exclusive with `editingChair`); commit/close/advance/key-handling all branch on it. Blank reverts to the default ("COND" via `conductor.label ?? 'COND'`, stored as `undefined`). Show/hide is the "Show conductor" checkbox in Setup (`conductor.show`).

## Render pipeline (one render call)

`renderer.render(canvas, config)`:

1. Clear canvas, apply `config.chartScale`
2. Draw background image (if any), per `config.backgroundFit`
3. Draw chart title — sits a fixed gap above the chart top (`contentTopY`, post-chartScale) plus the user's optional `config.titleGap` ("Title gap (px)" in Setup, also folded into `computeFitScale`'s TITLE_PAD so a big gap never pushes the title off-canvas), not pinned to the canvas top, plus an optional manual `titleOffsetX/Y`. Drawn at canvas scale; `titleHit` (raw canvas px) lets the Layout tab drag it (double-click to reset). `contentTopY` clears the back chair row, the conductor (when flipped), **and any fixed instrument that sits higher** (e.g. percussion behind a concert band) — *every* instrument counts, even ones off to the side the centred title wouldn't touch, so the title stays put instead of jumping while an instrument is dragged across its span. Instrument sizes come from `glyphDims`, which measures the real glyph code on a throwaway off-screen context so there's no duplicated size table.
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

- `config.rowSpacing` (default 70 px). User-configurable in the **Layout** tab ("Defaults → Row spacing").
- Fitting the chart to the canvas is handled by the auto-fit scale (see above), **not** by squeezing row spacing — `effectiveRowSpacing` is now a pass-through that always returns the user's value.
- Sized so the seat number behind one row doesn't collide with the shared stand drawn in front of the row behind (stand reaches ~35 px forward, number ~28 px behind — 65 px floor; 70 gives a small gap).

### Layout-tab drag handles (`renderLayoutHandles`)

Drawn only in layout mode; recorded in `layoutHandles` (hit-tested by
`layoutHandleHitTest`) with this-frame geometry in `layoutRows`:

- **distance** (blue diamond, per row) → `row.gapBefore`; **span-start/end**
  (blue dots) → `row.arcStart/arcEnd` (arc) or `straightSpacing/straightOffset`
  (straight); **arc-range-start/end** (purple, chart-wide) → `config.arcRange`.
- Dragging a **chair** body sets that one chair's `chair.offset` (tangential
  nudge), clamped to `LAYOUT_MIN_SPACING` from its neighbours (`applyChairDrag`).
- **desk** (teal dot, one per two-chair desk) → drags the whole desk: both
  chairs of the pair get the *same* tangential `offset` delta, so the pair and
  its shared stand slide along the row as a unit (`applyDeskDrag`), clamped so
  neither outer chair overlaps the chair beyond it. The dot sits **on the row
  line, in the gap between the desk's two chairs** (the exact pair midpoint), so
  it's unambiguously tied to them — it's clear of the shared stand ×, which
  `drawStandX` offsets toward the conductor in front of that point. (An earlier
  version pushed the dot radially out behind the desk, which put it near the row
  behind and made it easy to grab the wrong desk.) Desk midpoints are captured
  into `deskHandles` while the rows render, then drawn/registered in
  `renderLayoutHandles`. Double-clicking the dot clears both chairs' offsets.

## Chair tools & labelling

The **Edit chairs** panel is the one workspace for "what a chair click does".
`setChairTool(tool)` is the single source of truth: it sets `activeTool`,
toggles the tool-button highlights, shows exactly one contextual sub-panel,
clears any armed instrument selection, closes the inline label editor, and
refreshes the canvas tool pill (below).

**`activeTool` is nullable — null (the default) is "select mode"**: no tool
armed, and clicking a chair/stand opens the same context menu as a right-click
(`openChairContextMenu`), so single-chair edits are noun-first and need no mode
at all. A tool arms via its button and **disarms** via a second click on the
same button, Escape, or the pill's ✕ — every way into a mode is a way out.
Marquee drags don't start in select mode (nothing to bulk-apply).

**The tool pill** (`#tool-pill`, `updateToolPill()`): while a tool is armed, a
pill floats at the top of the canvas (right of the undo + zoom clusters;
second row ≤640px) naming the tool and its payload — armed instrument label,
stand/seat mode, colour swatch — plus a ✕ to put it down. Re-rendered on tool
change, payload change (sub-panel mode buttons, colour input, instrument
picker) and tab switch; shown on Edit *and* Setup (armed tools apply to chair
clicks there too), hidden on Layout/Export and in print. This is the answer to
"what will my next click do" without glancing at the sidebar.

**Hover preview** (`HoverPreview` in renderer.ts, `currentHoverPreview()` in
main.ts): with a tool armed in the Edit tab, the single chair under the
pointer (`renderer.hoverChair`) draws the click's outcome as a ghost — Hide
dims it toward white with a dashed outline, Colour washes the armed swatch on
at half strength, an armed Label ghosts its text in at 50% alpha in place of
the current label. Only tools with one deterministic outcome preview
(stand/stool cycle on repeat clicks; free-type Label opens an editor).
`main.ts` sets `renderer.hoverPreview` before every render; tool/payload
changes call `rerenderCanvasOnly()` so a chair already under the pointer
previews the *new* tool (the `setHoverChair` same-chair short-circuit would
otherwise leave a stale ghost).

The five tools (`ChairTool`) and their sub-panels:

- **Hide** (`toggle`) — toggles `chair.enabled`, then `repackLabelsAfterToggle`
  re-flows the row's labels so none strand on the hidden seat: the toggled chair
  and every still-enabled chair after it rotate labels by one (hide = rotate
  right, so the hidden seat parks the trailing label and the later chairs pack
  up; show = rotate left, the exact inverse, so un-hiding the same chair
  restores the original order). Pre-existing hidden chairs (preset spacers) are
  skipped so their blanks never flow into a visible seat.
- **Stand** — `#stand-bulk` is an **armed-mode selector** (Solo / In desks /
  Remove → `standMode`); the armed mode is what both a single click
  (`applyStandToChair`) and a marquee drag apply.
- **Stool** — `#stool-bulk` is an armed-mode selector (Chair / Stool / Standing
  → `stoolMode`, via `applyStoolToChair`), same click + marquee model.
- **Colour** — paints `chair.color`; reveals the `#color-picker` swatch.
- **Label** — reveals `#label-panel`. Clicking a chair floats
  `#chair-label-input` on it (`openChairLabelEditor`, positioned through the
  chartScale + view-zoom transforms via `chairScreenPos`); type, **Enter**
  commits + hops to the next chair (`advanceChairLabel`), Esc/blur closes. The
  panel also has the "paste a list" `<details open>` (`#label-list`, one
  textarea per row, rebuilt by `renderLabelList()` alongside `renderRowList()`
  and again whenever the Label tool is (re)entered). The list shows **only
  enabled chairs** — hidden seats and preset spacers are skipped, so a row with
  a hidden middle chair reads as two consecutive labels (no blank line to keep
  aligned). The `input` handler walks an independent line cursor over the
  enabled chairs, and Tab/Shift-Tab step through the rendered textareas directly
  so they skip any all-hidden rows that were omitted.
- **Instruments** — reveals `#instrument-panel` with the canonical picker
  (`#instrument-picker-list`, built once at init) + tally button. Clicking a
  picker button arms `selectedLabel`; subsequent chair clicks stamp it. Buttons
  show the full instrument name but stamp the **abbreviated** form
  (`INSTRUMENT_ABBREV`, e.g. Flute → `Fl`, numbered → `Fl 1`) so it fits the
  chair box and matches the preset charts. Where a preset uses a short form
  the abbreviation matches it verbatim; the rest use standard score
  abbreviations (every instrument has one except names already short enough —
  Tuba, Bass, Alto, Solo…). The tally's matcher list includes both full and
  abbreviated forms so preset/abbreviated labels classify into their section
  instead of "Other".

A one-line `#edit-chairs-hint` (`TOOL_HINTS[tool]`, or `NEUTRAL_HINT` in
select mode) explains the active tool.
The seat-number / restart-per-row / row-label *display* toggles live in a
separate slim **Numbers & labels** panel (they're chart-display options, not
chair-click actions).

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
- The Stand tool applies the armed `standMode` (Solo / In desks / Remove) — `applyStandToChair` mutates one chair (In desks shares a stand with the next enabled neighbour and dissolves any desk that paired *into* this chair). The sub-panel buttons just set the mode; "apply to all" is now "marquee the whole chart".
- **Clicking the right-hand chair of a desk splits it.** If the chair to the left has `standAfter` (i.e. you clicked the second player of a desk), the desk is dissolved and *both* players get their own solo stand back — instead of stacking a second stand in front of the right chair on top of the shared one.
- **A desk needs two present players.** A `standAfter` desk is only active when *both* the chair and its next neighbour are `enabled` — the tool refuses to form one into a hidden/absent seat (`canPairNext`), and the renderer (arc + straight positioning, stand drawing) and the summary count all skip a desk whose neighbour is hidden, so you never get a stand drawn toward a ghost chair. Hiding one half of an existing desk dissolves it cleanly; re-showing the seat brings it back.
- Stand × is drawn by `drawStandX`. Rotated by the chair→conductor angle so the diagonals stay diagonal (not aligned with the radial — that would look like `+`).
- Default `makeChair()` returns `hasStand: true`.
- **Seat type is three-way.** The Stool tool applies the armed `stoolMode` (Chair / Stool / Standing) via `applyStoolToChair`. `isStool` = round double-bass stool; `noSeat` = a **standing player** (no chair/stool glyph at all, just the stand + label, and it's not given a seat number / doesn't consume one). Big-band trumpets standing in a row are the motivating case. The row summary breaks the totals into chairs · stools · standing · stands.

### Marquee bulk-apply (Edit tab)

A **mouse/pen** drag over the canvas in the **Edit tab at 100% view-zoom** is a rubber-band selection (`marqueeState`; a screen-space `#marquee-box` overlay; gated to 100% so the untransformed canvas maps 1:1 — when zoomed in, a drag still pans). **Touch never marquees** (`e.pointerType !== 'touch'` in `pointerdown`) — a finger needs to pan, and a box-select needs precision. On release `renderer.chairsInRect()` returns the boxed chairs and `applyBulkTool()` applies the active tool to the **enabled** ones in **one undo step** (Hide hides them; the trailing click is swallowed via `suppressClickAfterPan`). Set-semantics, not the per-click cycle: Colour→`activeColor`; Stand/Stool→the armed mode (`applyStandModeToTargets` pairs *consecutive adjacent* selected chairs for In-desks); Label/Instruments→the armed `selectedLabel` (or a one-shot bulk `#chair-label-input` via `bulkLabelTargets` + `openBulkLabelEditor`, mirroring the `editingConductor` branch in `commitChairLabel`). Labelling **fills only blank chairs** unless the floating **`#drag-overwrite`** toggle button is on (boolean `overwriteLabels`; an accent-filled pill under the zoom row, shown only for Label/Instruments — `syncDragControls`). All marquee UI — the toggle and the "drag a box" hint (`.marquee-hint`) — is hidden where there's no fine pointer: `hasFinePointer` (`matchMedia('(any-pointer: fine)')`) drives `syncDragControls` and the `body.marquee-capable` class. So phones/bare tablets see none of it; a tablet with a mouse gets the lot.
- The Colour tool reveals the swatch (`#color-picker-label`) plus a **Reset all colours** bulk button (`#color-bulk` → `DEFAULT_CHAIR_COLOR`); it doesn't auto-open the native picker — the user clicks the swatch when they want to change the colour.

## Orchestra preset (notation → rows)

`parseOrchestraNotation(string)` accepts Boosey & Hawkes shorthand:

```
Ww − Br [− Perc] − Str
2.2.2.2 - 4.2.3.1 - 1.2 - 12.10.8.8.6
3(III=Bass Clarinet).2.2.2 - 4.3.3.1 - 1.2 - 14.12.10.8.6
```

Each block is dot-separated counts. Doublings in parens (`N(Roman=Label)`) get appended to the chair label. Canonical section labels are the readable abbreviations `Fl Ob Cl Bsn` / `Hn Tpt Tbn Tuba` / `Vln 1 Vln 2 Va Vc Cb` (`WW_NAMES` etc.; `describeComposition`'s `longNames` map is keyed on these, so keep the two in step).

`buildOrchestraRows(composition)` returns `{ rows, straightRows }`:

- **Strings** sit in semicircle rows (V1 | V2 | Va | Vc→Cb columns, separated by placeholder gaps).
  - Rows 0–3: one desk per active section (a tight principal-led front).
  - Rows 4+: two desks per section (sections spread back faster).
  - The rightmost column is shared between Vc and Cb — cellos fill the front of that column, basses take over behind them, putting them naturally behind the cellos. Bass desks are flagged `isStool` (double basses are played standing/perched) via `oneDesk(slot, idx, asStool)`; this applies to every orchestra-notation chart, including the custom-orchestra modal.
  - Exhausted sections get disabled placeholder desks so the column structure stays consistent.
- **Winds, brass, percussion** are straight rows at the back. The wind row splits into Fl/Ob front + Cl/Bn back when totals > 6.
- **Wind/brass numbering** (`numberSections`, applied via the `numbered` flag on `pushSectionRow`): each section of ≥2 players is numbered so the **1st sits innermost** (toward the row centre / conductor) and higher numbers fan to the edges — e.g. `Fl 3 Fl 2 Fl 1 | Ob 1 Ob 2 Ob 3`, `Hn 4 Hn 3 Hn 2 Hn 1 | Tp 3 Tp 2 Tp 1 | …`. Soloists (a lone Tuba) and doubled chairs (different labels) are left unnumbered. Strings are never numbered (they're desks).
- Returned `straightRows` count tells `applyPreset` how many trailing rows to render as straight lines instead of arcs.

The **Symphony Orchestra** preset drops the percussion block from its notation (so it isn't a row of chairs) and instead places a real **timpani glyph** at the right-hand end of the back (brass) row as a fixed `instrument` — `buildPreset` reads `preset.instruments` regardless of how the rows were specified, so a notation preset can still carry fixed instruments.

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
`config`, re-renders, and shows a transient toast ("X applied — press Cmd+Z
to undo") via `showToast()` — a lazily-created `#canvas-toast` div near the
bottom of the canvas, non-blocking, auto-hides after ~3s. Reuse `showToast`
for any other silent-but-big action that deserves an undo reminder.

## Fixed instruments

- Stored as polar coords `{ angle, distance }` from the conductor + `rotation` in radians.
- Types: drumkit, piano, guitar-amp, bass-amp, timpani (2–6 drums via `count`), mallet, harp, microphone, gong, chair, stand, stool, square, rectangle (generic placeholders).
- **Microphone** is a slim vocal-mic silhouette (handle + slight grille bulge, not a ball mic). Carries two extra booleans: `micStand` (default true — drawn on a pole + base; false = handheld) and `wireless` (default false = wired, drawn with a trailing cable; true = radio-wave arcs above the head, no cable). Both are toggled from the instrument inspector and only shown for the microphone type, mirroring how the timpani drum-count field is gated.
- **Gong** is a square stand frame holding a flattened disc (white rim ring + central boss). Drawn wide-and-short on purpose so it stays compact vertically in the top-down chart.
- **Grand piano** is a long top-down silhouette traced from a reference outline (straight left spine, rounded lid, a straight upper-right edge that eases through a 40px fillet into the bentside bulge, a short outer edge, and a white+black keyboard along the bottom). It's drawn in a 314×405 design space then scaled/centred into the glyph via `ctx.scale`/`translate`. Canonical orientation is keyboard-at-bottom; the Big Band preset + `INSERT_DEFAULTS` rotate it ~`π/2` so the keys face the band. Its bbox centre lands low on the rotated body, so it returns a `labelOffset` to lift the "Piano" label off the bulge edge (see below).
- Each glyph is a pure `draw*` function in `instrument-glyphs.ts` returning `{ hw, hh, labelInside }` (plus an optional `labelOffset` — a screen-px nudge for a `labelInside` label, used by the off-centre grand piano so its label clears the edges) for the bounding box.
- **Smart insert position**: `makeInstrument` (state.ts) places new instruments
  where ensembles actually put them via the `INSERT_DEFAULTS` table — a
  per-type `{ angle, pad }` where `pad` is px beyond the back row
  (`renderer.backRowRadius(config)`, passed in by main.ts), so the defaults
  scale with the chart. Tuned from the Concert Band / Big Band presets:
  timpani back-right, mallets back-left, kit/gong/aux back-centre, piano +
  amps + harp on the left flank. Small props (mic, stand, chair, stool) keep
  the old "in front of the conductor" fallback. Positions are stored polar, so
  the renderer's flip mirroring keeps them behind the band when flipped.
- Drag/rotate handled by `DragState` / `RotateState` in main.ts. Selected instrument shows a green MS-Office-style rotate handle.
- Keyboard on the selected instrument: **Delete/Backspace** removes it; **arrow keys nudge it** 2px (Shift = 10px). The nudge converts the screen-space delta into the stored polar frame (mirror-scaled when flipped) and pushes history once per burst (`lastArrowNudge`: same instrument, <1s apart = one undo step), mirroring the one-push-per-drag rule.
- A fixed instrument can carry its own music stand (`hasStand`). With the **Stand** chair-tool active (Edit/Setup, not Layout), pressing an instrument always arms a drag (`DragState.toggleStandOnClick`); a press that never crosses `DRAG_THRESHOLD` toggles the stand on `pointerup`, while an actual drag just repositions it. So instruments stay draggable in stand mode instead of every press toggling the stand.

## Persistence

- **Save JSON**: full `ChartConfig` including `backgroundImage` as a data URL. Survives anything.
- **Share link**: `encodeToHash` strips `backgroundImage` (URLs can't carry MB-scale data) and returns `{ hash, strippedBackground }`. When stripped, the share-URL display appends a one-line warning telling the user to use Save JSON for full fidelity.
- **PNG export / Print**: rendered to **A4-landscape proportions** (`EXPORT_W`×`EXPORT_H`, 2100×1485 ≈ √2), not the screen-shaped on-screen canvas, so the chart auto-fills the page. PNG renders to a throwaway off-screen canvas; print re-renders the live canvas at that size in a `beforeprint` handler (and restores it in `afterprint`). Both suppress the instrument selection box **and pass `showGhosts: false`** so hidden/disabled seats leave no mark at all (the dashed ghost outline is an editing affordance only). The on-screen render passes `showGhosts: activeTab !== 'export'`, so the Export-tab preview is a faithful WYSIWYG of the output, while Setup/Edit/Layout keep ghosts visible and clickable. The print `@media` CSS then `object-fit: contain`s the now-A4 canvas onto the A4 page with no letterboxing.
- **URL hash on load**: decoded by `decodeFromHash`, passed through `migrateConfig` (which merges in any newer default fields the saved config is missing).
- **Malformed input is rejected, not absorbed.** `serializer.migrate()` throws unless the data is an object with a `rows` array, so a stray JSON file or a corrupt share link fails cleanly (the file loader shows "Could not load chart file."; `decodeFromHash` returns null → the default chart) instead of `migrateConfig` spreading garbage over the defaults.
- **Working-chart autosave** (`stageplan_working_chart` in `localStorage`): a safety net distinct from the library. `scheduleAutosave()` (debounced 500ms, called from `renderChart`) mirrors `{ config, currentChartId }`; `restoreWorkingChart()` re-loads it at startup (priority: **URL hash > autosave > default**). On a quota error (big `backgroundImage`) it retries without the image so at least the layout survives. So a refresh / closed tab / slept laptop resumes where the user left off.
- **Unsaved-changes guard**: `markSaved()` snapshots `JSON.stringify(config)` at every explicit Save / Load / New / library-open (NOT undo/redo — those are edits). A `beforeunload` handler flushes the autosave synchronously, then prompts only if the live config differs from that snapshot. Autosave is the real protection; this is the belt to its braces.

## About / intro modal

The ⓘ button opens `#about-modal` — branding/support links **plus a short
how-it-works guide** (`.about-guide`: a tab-by-tab overview and a "worth
knowing" list, aimed at non-technical first-time users). `maybeShowIntro()`
(called at the end of `init`) pops it **automatically on the first visit only**,
gated by a `localStorage` flag (`stageplan_intro_seen`); thereafter it's
ⓘ-only. Skipped when the URL has a hash (a shared-chart link — that visitor
wants the chart, not a tour) and wrapped in try/catch for storage-blocked
browsers. The guide is hand-written HTML in `index.html`; keep it in step with
the actual tab/feature layout.

## Coordinate conventions

- Canvas y is downward (HTML5 standard).
- "Front of stage" = bottom of canvas = +y direction. Conductor sits there by default.
- "Flipped" layout puts the conductor at the top instead.
- `yDir = -1` (default) means chairs are above the conductor (smaller y). `yDir = 1` (flipped) means below.
- Polar angle convention: 0 = right, π/2 = down, π = left, -π/2 = up.

## Common gotchas

- **Canvas editing uses POINTER events** (`pointerdown/move/up` on canvas+window) so touch/pen work, not mouse events. Non-primary pointers are dropped (`if (!e.isPrimary) return`) and the canvas has `touch-action: none`. The hover-cursor listener is the one exception — still `mousemove`, since hover is mouse-only. `click`/`dblclick` stay as-is (they fire for taps too). Dispatching a synthetic `MouseEvent('mousedown')` will NOT trigger the handlers — use `PointerEvent`.
- **`ChartConfig.straightRows`** counts straight rows from the *back*, not the front.
- **Renderer caches `backgroundImage`** by src — if you swap the image data URL but keep the same string, it won't re-decode.
- **Hit targets are stored on the Renderer instance** and reset every render. Don't call hitTest before the first render.
- **`applyPreset` calls `history.push(config)` at the top.** Don't double-push in callers. The **Clear to blank rows** button (`#clear-preset-btn`) is the inverse: it resets `rows`/`instruments`/`layout`/`straightRows`/`arcRange`/`rowSpacing`/`flipped` to `makeDefaultConfig()` values (plain rows, no colours/labels/instruments) while leaving title, notes, background and conductor placement alone.
- **The advanced modal inputs and `readInputs()` must stay in sync.** Adding a new advanced setting means: update `types.ts`, `state.ts` defaults, `index.html` markup, the DOM ref + `readInputs` + `updateAllInputs` blocks in `main.ts`, and the change-listener loop in `bindEvents`.
- **`tsconfig.json` sets `noEmit: true`.** Vite/esbuild does the actual transpile; the `tsc` in `npm run build` is a type-check only. Without `noEmit`, `tsc` dumps compiled `.js` next to every `.ts` in `src/`, and the dev server then serves those stale `.js` instead of transforming the live `.ts` — silently running old code. The `.js` files are gitignored (`src/*.js`); if you ever see them, delete them.
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
  / `history` state and would need a heavy props pass).
- ~~`applyPreset` is ~270 lines doing notation/customRows/sections dispatch
  + chair construction + instrument placement. The "build rows from
  preset" part probably belongs in `presets.ts`.~~ — done; the pure build
  is now `buildPreset` in `presets.ts`, `applyPreset` is a 17-line wrapper.
- ~~State management is implicit — a `setConfig(newConfig)` wrapper that
  calls `renderChart` automatically would make data flow more obvious.~~
  — done; all wholesale config replacements go through `setConfig`.
