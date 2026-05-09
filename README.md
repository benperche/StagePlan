# StagePlan

A browser-based seating chart generator for conductors. Create, customise, and export semicircular or straight-row seating layouts for any ensemble.

**[Live app →](https://benperche.github.io/StagePlan/)**

## Features

- **Semicircle and straight-row layouts** — or mix both within the same chart by toggling individual rows
- **Preset arrangements** for common ensembles (Big Band, Symphony Orchestra, Concert Band, String Quartet, Jazz Combo) — apply a standard layout as a starting point, then edit freely
- **Per-chair editing** — colour chairs by section, enable/disable individual seats, toggle music stands
- **Conductor's or musicians' view** — flip the chart vertically to see it from either perspective
- **Undo/redo** — full history with Cmd/Ctrl+Z
- **Save and load** — charts saved as plain JSON files
- **PNG export** — high-quality image for printing or sharing
- **Shareable links** — encode the full chart state into a URL, no server required

## Built with

- [Vite](https://vitejs.dev/) + TypeScript
- HTML5 Canvas API (no drawing library dependencies)
- Hosted on GitHub Pages

## Roadmap

- Better music stand handling
- Preset customisation — enter custom instrument counts before applying a layout
- Upload custom background image (eg stage map), and customise location and size of rendered seat map
- Musician names on chairs with drag-to-reorder
- Section colour legend
- Print stylesheet

