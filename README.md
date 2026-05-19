# StagePlan

A browser-based seating chart generator for conductors and ensemble directors. Create, customise, and export semicircular or straight-row seating layouts for any ensemble — from a Mozart chamber orchestra to a 70-piece concert band.

**[Live app →](https://benperche.github.io/StagePlan/)**

## Features

### Layouts
- **Semicircle and straight-row layouts** — or mix both by setting "Straight rows from back" in semicircle mode
- **Configurable arc range** — full 180° semicircle or narrower (down to 60°) for tighter stages
- **Configurable row spacing and chart scale** — fit any size of ensemble onto any size of stage diagram

### Presets
- **Big Band** — three straight rows of saxes/trombones/trumpets with rhythm section
- **Chamber Orchestra** — Mozart-sized strings with single winds and 2 horns
- **Full Symphony** — Tchaikovsky-scale 76-piece orchestra
- **Concert Band** — four-row semicircle with percussion section as fixed instruments
- **String Quartet** and **Jazz Combo**
- **Custom Orchestra** — enter any orchestra in Boosey & Hawkes notation (e.g. `2.2.2.2 - 4.2.3.1 - 1.2 - 12.10.8.8.6`), including doublings like `3(III=Bass Clarinet)`

### Per-chair editing
- **Colour chairs** by section with the colour tool
- **Enable/disable individual seats** to mark empty spots without removing structure
- **Music stand cycle** — solo × per chair → shared × between two chairs → none
- **Smart desk handling** — orchestra strings are paired into shared-stand desks automatically; back rows fan out with the rightmost column transitioning from cellos to basses

### Fixed instruments
- Drum kit, grand piano, guitar amp, bass amp, timpani (2–6 drums), mallet instruments (glock/xylo/vibes/marimba), generic square and rectangle for anything else
- Click to select, drag to move, rotate handle to spin

### Stage and view
- **Upload a stage background image** — draw the chart directly on top of any stage plan. Choose contain, cover, or stretch fit.
- **Drag the conductor podium** — the entire chart translates as one unit
- **Conductor's or musicians' view** — flip the chart vertically
- **Stage Left / Stage Right labels** — optional canvas-edge directions from the performer's perspective

### Save & share
- **Undo/redo** with Cmd/Ctrl+Z
- **Save and load** charts as plain JSON files (includes background image)
- **Shareable links** — encode the full chart into a URL, no server required (background image is omitted from share links due to size; use Save JSON to preserve it)
- **PNG export** — high-quality image for printing or programmes

## Built with

- [Vite](https://vitejs.dev/) + TypeScript
- HTML5 Canvas API (no drawing library dependencies)
- Hosted on GitHub Pages

## Development

```sh
npm install
npm run dev      # local dev server on :5200
npm run build    # production build to dist/
```

For architecture notes and the file map, see [`CODEREF.md`](./CODEREF.md).

## Roadmap

- Per-row arc range with drag handles
- Musician names on chairs with drag-to-reorder
- Section colour legend
- Print stylesheet
