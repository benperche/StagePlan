# StagePlan

A browser-based seating chart generator for conductors and ensemble directors. Create, customise, and export semicircular or straight-row seating layouts for any ensemble — from a Mozart chamber orchestra to a 70-piece concert band — and fine-tune every chair by hand.

Everything runs in the browser. No account, no server, nothing leaves your machine.

**[Live app →](https://benperche.github.io/StagePlan/)**

## At a glance

The app is organised into four tabs, plus a chart library:

| Tab | What it's for |
|---|---|
| **Setup** | Title, presets, stage background, starting rows, notes — and drag the conductor to position the whole chart |
| **Edit** | Add/remove rows, edit chairs (hide, stands, stools, colour, labels, instruments), place fixed instruments |
| **Layout** | Fine-tune exact positions directly on the chart with drag handles |
| **Export** | Print/PDF, PNG, save/load JSON, copy a share link |
| **📁 My charts** | A slide-in library of your saved charts, with folders |

## Features

### Layouts & presets
- **Semicircle and straight-row layouts** — or mix both by making any number of back rows straight while the front stays curved.
- **Per-row straight/arc override** — flip individual rows between curved and straight.
- **Presets** — Big Band, Chamber Orchestra, Full Symphony, Concert Band, String Quartet, Jazz Combo.
- **Custom Orchestra** — enter any orchestra in Boosey & Hawkes notation (e.g. `2.2.2.2 - 4.2.3.1 - 1.2 - 12.10.8.8.6`), including doublings like `3(III=Bass Clarinet)`. Strings are auto-paired into shared-stand desks and fan out by section, with the rightmost column transitioning from cellos to basses.

### Editing chairs
A single **Edit chairs** toolset — pick what a click does, then click chairs on the chart:
- **Hide** — hide a seat without shifting the row (keeps the spacing; click again to show).
- **Stand** — cycle each chair's music stand: solo × → shared × with the next chair → none. Bulk actions set one stand **per chair**, one **per desk**, or **remove all**.
- **Stool** — switch a seat between a chair and a round double-bass stool. Bulk-convert every seat to stools or chairs.
- **Colour** — paint chairs by section with a colour swatch.
- **Label** — click a chair to type a name **right on the chart** (Enter jumps to the next chair). Or paste a whole list, one label per line, per row.
- **Instruments** — pick from the canonical instrument list (grouped Woodwinds / Saxes / Brass / Strings / Rhythm / Percussion / Voice, with part numbers) and click chairs to stamp it.
- **Instrument tally** — a floating live count of every distinct instrument in the chart.
- **Numbers & labels** — toggle seat numbers (optionally restarting per row) and row labels.

### Fixed instruments
Drop in and freely position larger items: **grand piano, harp, guitar amp, bass amp, timpani** (2–6 drums), **mallets** (glock/xylo/vibes/marimba), **drum kit, gong** (on a square stand), **microphone** (on a stand or handheld, wired or wireless), **single chair, music stand, bass stool**, and generic **square / rectangle** placeholders for anything else. Select to drag, rotate, rename, or delete — in both the Edit and Layout tabs.

### Layout fine-tuning
The **Layout** tab turns the chart into a direct-manipulation canvas (arc guides switch on automatically):
- **Move a row in/out** — drag the dot at the row's apex; the rows behind it ride along, keeping the gaps even.
- **Widen / narrow a row** — drag the dots at the row's ends (Shift-drag one end for an uneven spread). Works for curved rows (arc range) and straight rows (chair spacing).
- **Nudge a single chair** — drag any chair sideways along its row; it stops before overlapping a neighbour, and a blue outline marks chairs you've moved.
- **Per-row inspector** — a box per row showing its exact distance and arc/spacing, editable and live-updating as you drag, each with a reset.
- **Reset** any row by double-clicking its handle, or reset all tweaks at once.

### Stage, conductor & view
- **Stage background image** — draw the chart on top of any stage plan (contain, cover, or stretch fit), and set a chart scale to fit it.
- **Conductor** — drag it to move the whole chart (in Setup, while you position against a background, or in Layout); click it in Edit to rename the podium; show/hide it and toggle its stand.
- **Flip layout** — switch between the conductor's and the musicians' view.
- **Stage Left / Stage Right** edge labels (from the performer's perspective), optional.
- **Zoom & pan** — zoom controls, scroll-to-zoom, and drag-to-pan for inspecting the chart. Purely a screen convenience — exports and prints always render the full chart at full resolution.

### Library, save & share
- **My charts** — a browser-only library (IndexedDB) with folders: save, open, duplicate, rename, move, delete, and search your charts.
- **Undo / redo** — Cmd/Ctrl+Z (and Shift to redo).
- **Save / load JSON** — full-fidelity files including the background image.
- **Share links** — encode the whole chart into a URL, no server required (the background image is omitted from links due to size; use Save JSON to keep it).
- **PNG export** and **Print / Save as PDF** — sized for A4 landscape.

> ⚠ Library charts live **in this browser only**. For a permanent backup or to move between devices, use **Save JSON**.

## Built with

- [Vite](https://vitejs.dev/) + TypeScript, no UI framework
- HTML5 Canvas API (no drawing-library dependencies)
- IndexedDB for the chart library
- Hosted on GitHub Pages

## Development

```sh
npm install
npm run dev      # local dev server on :5200
npm run build    # type-check + production build to dist/
```

For architecture notes and the file map, see [`CODEREF.md`](./CODEREF.md).
