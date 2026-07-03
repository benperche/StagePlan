import type {
  ChartConfig, Row, Chair, FixedInstrument,
  HitTarget, ConductorHit, InstrumentHit, RotateHandleHit, ConductorOrigin,
  LayoutHandleHit, RowGeometry,
} from './types'
import {
  drawDrumkit, drawPiano, drawAmp, drawTimpani, drawMallet, drawHarp,
  drawMicrophone, drawGong, drawSuspendedCymbal, drawSnareDrum,
  drawSingleChair, drawSingleStand, drawStool, drawGenericRect,
} from './instrument-glyphs'
import type { GlyphResult } from './instrument-glyphs'
import { BASE_RADIUS, ROW_SPACING_DEFAULT } from './section-layout'

const CHAIR_SIZE = 30
const CHAIR_HALF = CHAIR_SIZE / 2
const STAND_GAP = 6
const STAND_SIZE = 7   // half-arm of the ×
const STRAIGHT_CHAIR_SPACING = 40
// Centre-to-centre distance between the two chairs of a desk pair when the
// renderer compresses them into a single arc slot. Chair size is 30, so 56
// gives a ~26px visual gap — enough that the stand × sits comfortably
// between the chairs instead of looking glued to either one.
const DESK_PAIR_SPACING = 56
const CONDUCTOR_EXTENT = 56
const COND_W = 52
const COND_H = 36

export interface RenderOptions {
  scale?: number
  // When true (the Layout tab is active), arc guides are forced on and the
  // canvas shows the geometry-editing handles.
  layoutMode?: boolean
  // Device-pixel-ratio of the canvas backing store. The backing is sized
  // cssPx * dpr (see resizeCanvas) so the chart stays crisp on retina/phone
  // screens; the renderer draws everything dpr-bigger and exposes the css-space
  // scale separately for DOM positioning / hit-testing.
  dpr?: number
  // Whether to draw the dashed ghost outline for hidden (disabled) chairs.
  // True while editing (so hidden seats remain visible and clickable); false
  // for PNG/print output and the Export-tab preview, where a hidden seat
  // should leave no mark at all. Defaults to true.
  showGhosts?: boolean
}

export class Renderer {
  private hitTargets: HitTarget[] = []
  private standHitTargets: HitTarget[] = []
  private instrumentHits: InstrumentHit[] = []
  conductorHit: ConductorHit | null = null
  titleHit: ConductorHit | null = null
  conductorOrigin: ConductorOrigin = { ox: 0, oy: 0, yDir: -1, flipped: false }
  // The uniform auto-fit scale applied to the whole canvas on the last render
  // (1 when the chart fits at natural size; < 1 on small canvases / phones).
  // main.ts maps pointer coords through this so hit-testing lines up.
  viewScale = 1
  // Touch/pen devices get bigger Layout-handle hit areas (fat-finger slop).
  private coarsePointer = typeof window !== 'undefined'
    && !!window.matchMedia?.('(pointer: coarse)')?.matches
  // Throwaway context for measuring glyph sizes without drawing to the canvas.
  private measureCtx: CanvasRenderingContext2D | null = null
  selectedInstrumentId: string | null = null
  // Softly highlight chairs on hover, to make it obvious which sidebar row maps
  // to which chairs. hoverRowIndex highlights a whole row (set from the sidebar
  // row controls); hoverChair highlights a single chair (set from canvas hover).
  // Drawn as a translucent wash on each chair; never affects export/print.
  hoverRowIndex: number | null = null
  hoverChair: { rowIndex: number; chairIndex: number } | null = null
  rotateHandleHit: RotateHandleHit | null = null
  // Same-shape hit-test target for the red ✕ delete button drawn next to
  // the selected instrument.
  deleteHandleHit: RotateHandleHit | null = null

  // Background image cache + async-load callback so main.ts can trigger
  // a re-render once a newly-uploaded image is decoded.
  private backgroundImage: HTMLImageElement | null = null
  private backgroundImageSrc: string | null = null
  onBackgroundLoaded: (() => void) | null = null

  // Set per-render from RenderOptions.layoutMode. When true the chart shows
  // arc guides + geometry handles regardless of config.showArc.
  private layoutMode = false
  // Set per-render from RenderOptions.showGhosts. When false, hidden chairs
  // draw nothing at all (output / export). Defaults to true (editing views).
  private showGhosts = true
  // Populated each render in layout mode: the draggable handles + the per-row
  // geometry main.ts needs to drive the drags. Empty otherwise.
  private layoutHandles: LayoutHandleHit[] = []
  layoutRows: RowGeometry[] = []
  // One entry per two-chair desk (shared stand, both seats filled), populated
  // while rendering the rows. Drives the Layout-tab "drag the whole desk" dot,
  // drawn behind each desk's midpoint in renderLayoutHandles.
  private deskHandles: Array<{ rowIndex: number; chairIndex: number; cx: number; cy: number }> = []

  render(canvas: HTMLCanvasElement, config: ChartConfig, opts: RenderOptions = {}): void {
    // The backing store is dpr-bigger than the CSS box (see resizeCanvas), so
    // work out the chart's geometry in CSS pixels and let dpr only sharpen the
    // raster. Auto-fit then scales the whole chart down so it fits the canvas at
    // its natural row spacing, instead of cramming rows together (which made
    // music stands overlap the chairs behind them) or running off the edge on a
    // narrow canvas. fit is 1 on a roomy desktop canvas; < 1 on a phone.
    const dpr = opts.dpr ?? 1
    const cssW = canvas.width / dpr
    const cssH = canvas.height / dpr
    const fit = (opts.scale ?? 1) * this.computeFitScale(cssW, cssH, config)
    // viewScale is the CSS-space logical→screen factor (no dpr) that main.ts
    // uses to place the inline label editor and to map pointer coords.
    this.viewScale = fit
    const scale = fit * dpr   // logical → backing pixels
    this.layoutMode = opts.layoutMode ?? false
    this.showGhosts = opts.showGhosts ?? true
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.save()
    ctx.scale(scale, scale)

    this.hitTargets = []
    this.standHitTargets = []
    this.instrumentHits = []
    this.layoutHandles = []
    this.layoutRows = []
    this.deskHandles = []
    this.conductorHit = null
    this.rotateHandleHit = null
    this.deleteHandleHit = null

    const w = canvas.width / scale
    const h = canvas.height / scale

    // Background image (fit to canvas) drawn first, beneath everything.
    this.drawBackground(ctx, config, w, h)

    // Notes / stage-direction labels stay at canvas scale so they don't shrink
    // with chartScale and remain readable.
    this.drawNotes(ctx, config.notes, h, config.showCredit ?? true)
    if (config.showStageDirections) this.drawStageDirections(ctx, w, h)

    // The seating chart itself is wrapped in a uniform scale transform
    // centred on the conductor. Hit targets are stored in chart coords
    // (unscaled) so main.ts must inverse-transform pointer coordinates
    // before calling the hit-test methods.
    const numRows = config.rows.length
    const rowSpacing = this.effectiveRowSpacing(h, numRows, config.rowSpacing ?? ROW_SPACING_DEFAULT)
    const ox = w / 2 + (config.conductor.offsetX ?? 0)
    const oy = this.computeOy(h, config, rowSpacing) + (config.conductor.offsetY ?? 0)
    const chartScale = config.chartScale ?? 1

    // Title hugs the top of the chart (a fixed gap above the back row / the
    // tallest fixed instrument under it, or the conductor when flipped) rather
    // than floating at the canvas top, plus any manual drag offset. Drawn at
    // canvas scale so it stays crisp.
    this.drawTitle(ctx, config.title, w,
      this.contentTopY(config, oy, rowSpacing, chartScale),
      config.titleOffsetX ?? 0, config.titleOffsetY ?? 0, config.titleGap ?? 0)

    const scaling = chartScale !== 1
    if (scaling) {
      ctx.save()
      ctx.translate(ox, oy)
      ctx.scale(chartScale, chartScale)
      ctx.translate(-ox, -oy)
    }

    if (config.layout === 'semicircle') {
      this.renderSemicircle(ctx, config, w, h)
    } else {
      this.renderStraight(ctx, config, w, h)
    }

    // Instruments draw on top so they're always visible & selectable
    this.renderInstruments(ctx, config)

    if (scaling) ctx.restore()

    this.drawRowSummary(ctx, config, w, h)
    if (config.showCredit ?? true) this.drawCredit(ctx, h)
    ctx.restore()
  }

  private drawBackground(ctx: CanvasRenderingContext2D, config: ChartConfig, w: number, h: number) {
    const src = config.backgroundImage ?? null
    if (src !== this.backgroundImageSrc) {
      // New (or removed) source — invalidate cache and start loading.
      this.backgroundImageSrc = src
      this.backgroundImage = null
      if (src) {
        const img = new Image()
        img.onload = () => {
          if (this.backgroundImageSrc === src) {
            this.backgroundImage = img
            if (this.onBackgroundLoaded) this.onBackgroundLoaded()
          }
        }
        img.src = src
      }
    }
    const img = this.backgroundImage
    if (!img) return

    const fit = config.backgroundFit ?? 'contain'
    const imgRatio = img.width / img.height
    const canvasRatio = w / h
    let drawW: number, drawH: number, drawX: number, drawY: number

    if (fit === 'stretch') {
      drawW = w; drawH = h; drawX = 0; drawY = 0
    } else if (fit === 'cover') {
      // Fill the canvas, preserving aspect — overflow is cropped.
      if (imgRatio > canvasRatio) {
        drawH = h
        drawW = h * imgRatio
        drawX = (w - drawW) / 2
        drawY = 0
      } else {
        drawW = w
        drawH = w / imgRatio
        drawX = 0
        drawY = (h - drawH) / 2
      }
    } else {
      // Contain: preserve aspect, letterbox the remainder.
      if (imgRatio > canvasRatio) {
        drawW = w
        drawH = w / imgRatio
        drawX = 0
        drawY = (h - drawH) / 2
      } else {
        drawH = h
        drawW = h * imgRatio
        drawX = (w - drawW) / 2
        drawY = 0
      }
    }
    ctx.drawImage(img, drawX, drawY, drawW, drawH)
  }

  instrumentHitTest(x: number, y: number): InstrumentHit | null {
    // Iterate in reverse so top-drawn instruments win when overlapping
    for (let i = this.instrumentHits.length - 1; i >= 0; i--) {
      const h = this.instrumentHits[i]
      const dx = x - h.cx
      const dy = y - h.cy
      // Rotate point into the instrument's local frame
      const cos = Math.cos(-h.rotation)
      const sin = Math.sin(-h.rotation)
      const lx = dx * cos - dy * sin
      const ly = dx * sin + dy * cos
      if (Math.abs(lx) <= h.hw && Math.abs(ly) <= h.hh) return h
    }
    return null
  }

  rotateHandleHitTest(x: number, y: number): RotateHandleHit | null {
    const h = this.rotateHandleHit
    if (!h) return null
    if (Math.hypot(x - h.cx, y - h.cy) <= h.radius) return h
    return null
  }

  deleteHandleHitTest(x: number, y: number): RotateHandleHit | null {
    const h = this.deleteHandleHit
    if (!h) return null
    if (Math.hypot(x - h.cx, y - h.cy) <= h.radius) return h
    return null
  }

  hitTest(x: number, y: number): HitTarget | null {
    for (const target of this.hitTargets) {
      const dx = x - target.x
      const dy = y - target.y
      if (dx * dx + dy * dy <= target.radius * target.radius) return target
    }
    return null
  }

  conductorHitTest(x: number, y: number): boolean {
    if (!this.conductorHit) return false
    const { x: cx, y: cy, w, h } = this.conductorHit
    return x >= cx && x <= cx + w && y >= cy && y <= cy + h
  }

  // ---------------------------------------------------------------------------
  // Vertical centering
  // ---------------------------------------------------------------------------

  // Use the user's preferred row spacing as the upper bound. If the chart
  // would overflow at that spacing, shrink to whatever fits. Floored at 40
  // so extremely tall charts still render legibly. The user is in charge
  // when their value is feasible; we only step in when it isn't.
  // Worst-case extent of the drawn chart from the conductor, in chart px at
  // chartScale = 1: how far it reaches sideways (halfW), behind the conductor
  // toward the title (back), and in front of it (front). Fixed instruments can
  // sit anywhere (e.g. amps far out), so they widen these too.
  private contentExtents(config: ChartConfig): { halfW: number; back: number; front: number } {
    const rowSpacing = config.rowSpacing ?? ROW_SPACING_DEFAULT
    const radii = this.computeRowRadii(config.rows, rowSpacing)
    const outer = radii.length ? radii[radii.length - 1] : BASE_RADIUS
    const LABEL_PAD = 24

    let halfW: number
    if (config.layout === 'straight') {
      let widest = 0
      for (const r of config.rows) {
        const spacing = r.straightSpacing ?? STRAIGHT_CHAIR_SPACING
        const w = (Math.max(0, r.chairs.length - 1) * spacing) / 2 + Math.abs(r.straightOffset ?? 0)
        if (w > widest) widest = w
      }
      halfW = widest + CHAIR_HALF + LABEL_PAD
    } else {
      // Arc rows reach their widest (≈ the outer radius) near the horizontal.
      halfW = outer + CHAIR_HALF + LABEL_PAD
    }

    let back = outer + CHAIR_HALF   // chairs sit behind the conductor
    let front = CONDUCTOR_EXTENT    // conductor sits in front

    for (const inst of config.instruments ?? []) {
      const dx = Math.abs(inst.distance * Math.cos(inst.angle)) + 46
      const dy = inst.distance * Math.sin(inst.angle)
      halfW = Math.max(halfW, dx)
      // Extend only the side the instrument actually sits on (in the unflipped
      // reference): negative y is behind the conductor with the chairs, positive
      // is in front. Counting both sides used to roughly double the natural
      // height for a back instrument (e.g. orchestral timpani) — shrinking the
      // whole chart and reserving dead space in front of the conductor.
      if (dy < 0) back = Math.max(back, -dy + 46)
      else        front = Math.max(front, dy + 46)
    }
    return { halfW, back, front }
  }

  // Fraction of the canvas the chart fills when auto-sizing. 0.85 keeps the
  // conductor from hugging the bottom edge on narrow/short canvases — 0.93
  // pushed it past 80% down on typical laptop viewports.
  private static readonly FILL = 0.85

  // Uniform outer scale applied to the whole chart. `chartScale` is applied
  // separately (the inner transform in render), so it is NOT folded in here.
  private computeFitScale(canvasW: number, canvasH: number, config: ChartConfig): number {
    if (config.rows.length === 0 && (config.instruments?.length ?? 0) === 0) return 1
    const chartScale = config.chartScale ?? 1
    const { halfW, back, front } = this.contentExtents(config)
    // Title sits above the back row (drawn at canvas scale), plus any extra
    // user-requested title gap so widening it never pushes the title off-canvas.
    const TITLE_PAD = 44 + (config.titleGap ?? 0)
    const FAR_PAD = 22
    const SIDE_PAD = 14
    const naturalWidth = 2 * halfW + 2 * SIDE_PAD
    const naturalHeight = (back + front) + TITLE_PAD + FAR_PAD

    if (config.backgroundImage) {
      // A background photo defines the scale context: the chart should sit at
      // its natural size (× chartScale, via the inner transform) so it can be
      // matched to the stage in the image — only shrink to avoid overflowing.
      return Math.max(0.2, Math.min(1,
        canvasW / (naturalWidth * chartScale),
        canvasH / (naturalHeight * chartScale)))
    }

    // No background: auto-fill a target fraction of the canvas/page regardless
    // of the layout's size (scale small charts up, big charts down so it still
    // fits one page). chartScale then multiplies this as a manual override
    // (100% = a clean auto-fill).
    const fill = Math.min(
      (canvasW * Renderer.FILL) / naturalWidth,
      (canvasH * Renderer.FILL) / naturalHeight)
    return Math.max(0.05, fill)
  }

  private effectiveRowSpacing(_h: number, _numRows: number, userRowSpacing: number): number {
    // The row spacing is always the user's preferred value. Fitting the chart
    // to the canvas is handled uniformly by computeFitScale (which scales the
    // whole chart down), rather than by squeezing the rows together — squeezing
    // pulled music stands up onto the chairs of the row behind. The signature
    // keeps `h`/`numRows` so callers don't all have to change.
    return userRowSpacing
  }

  // Outermost row radius (px from the conductor) — used by main.ts to place
  // newly added fixed instruments just beyond the back row.
  backRowRadius(config: ChartConfig): number {
    const radii = this.computeRowRadii(config.rows, config.rowSpacing ?? ROW_SPACING_DEFAULT)
    return radii.length ? radii[radii.length - 1] : BASE_RADIUS
  }

  // Cumulative per-row radius from the conductor. Base step is the (already
  // fitted) row spacing; each row adds its optional `gapBefore`. Because it's
  // cumulative, bumping one row's gap pushes every row behind it out by the
  // same amount — the "push rows behind" distance behaviour. With all gaps 0
  // this is exactly BASE_RADIUS + i * rowSpacing.
  private computeRowRadii(rows: Row[], rowSpacing: number): number[] {
    const radii: number[] = []
    for (let i = 0; i < rows.length; i++) {
      const base = i === 0 ? BASE_RADIUS : radii[i - 1] + rowSpacing
      radii[i] = base + (rows[i].gapBefore ?? 0)
    }
    return radii
  }

  // A row's arc span as [startAngle, endAngle] in canvas radians. Per-row
  // arcStart/arcEnd win; otherwise derived symmetrically from the global
  // arcRange around the apex (π/2).
  private rowArcAngles(row: Row, config: ChartConfig): [number, number] {
    const range = config.arcRange ?? Math.PI
    const start = row.arcStart ?? (Math.PI / 2 + range / 2)
    const end = row.arcEnd ?? (Math.PI / 2 - range / 2)
    return [start, end]
  }

  private computeOy(h: number, config: ChartConfig, _rowSpacing: number): number {
    // Default conductor position sits in the lower (or upper, when flipped)
    // third of the canvas — the conductor is at the FRONT of the stage, with
    // chairs working backwards from there. Falls back to clamping when the
    // chart is too tall to fit at the preferred position.
    const flipped = config.flipped
    // Distance from the conductor to the far (chairs) edge — including any fixed
    // instruments parked behind the chairs, so a chart with e.g. timpani at the
    // back packs down toward the conductor instead of floating with the
    // instruments clipped or crammed against the title.
    const chartHeight = this.contentExtents(config).back
    // The chart-title side needs extra padding so the title (drawn at y≈14,
    // text ~18px tall) doesn't get tangled with the back-row seat numbers
    // (drawn ~12px above the back chair top). 50px covers both with a
    // small gap. The opposite side just needs a normal margin.
    const titleSidePadding = 50
    const farSidePadding = 30
    if (flipped) {
      // Conductor near the top — title is above the conductor, chairs and
      // their seat numbers extend down toward the bottom of the canvas.
      const target = h / 3
      const minOy = titleSidePadding + CONDUCTOR_EXTENT
      const maxOy = h - farSidePadding - chartHeight
      return Math.max(minOy, Math.min(target, maxOy))
    } else {
      // Conductor near the bottom — chairs and their seat numbers extend
      // up toward the title at the top of the canvas.
      const target = (h * 2) / 3
      const minOy = chartHeight + titleSidePadding
      const maxOy = h - farSidePadding - CONDUCTOR_EXTENT
      return Math.min(maxOy, Math.max(target, minOy))
    }
  }

  // ---------------------------------------------------------------------------
  // Semicircle layout
  // ---------------------------------------------------------------------------

  private renderSemicircle(ctx: CanvasRenderingContext2D, config: ChartConfig, w: number, h: number) {
    const numRows = config.rows.length
    const rowSpacing = this.effectiveRowSpacing(h, numRows, config.rowSpacing ?? ROW_SPACING_DEFAULT)
    const offX = config.conductor.offsetX ?? 0
    const offY = config.conductor.offsetY ?? 0
    const ox = w / 2 + offX
    const oy = this.computeOy(h, config, rowSpacing) + offY
    const yDir = config.flipped ? 1 : -1
    this.conductorOrigin = { ox, oy, yDir, flipped: config.flipped }
    const radii = this.computeRowRadii(config.rows, rowSpacing)

    // Draw arcs first (behind chairs). Each guide spans the row's own arc
    // range so the guide tracks any per-row span override. Always shown in
    // the Layout tab so you can see what you're adjusting against.
    if (config.showArc || this.layoutMode) {
      config.rows.forEach((row, rowIndex) => {
        const isStraight = config.rows[rowIndex].isStraight ?? (rowIndex >= numRows - config.straightRows)
        if (isStraight) return
        const [arcStart, arcEnd] = this.rowArcAngles(row, config)
        const r = radii[rowIndex]
        ctx.save()
        ctx.beginPath()
        ctx.arc(ox, oy, r, arcStart, arcEnd, yDir > 0)
        ctx.strokeStyle = '#ccc'
        ctx.lineWidth = 1
        ctx.setLineDash([4, 4])
        ctx.stroke()
        ctx.setLineDash([])
        ctx.restore()
      })
    }

    this.drawConductor(ctx, ox, oy, yDir, config)

    // Consistent label x for every row that's rendered as straight (whether
    // via the per-row override or the "last N from back" global default).
    const isStraightRow = (rowIndex: number) =>
      config.rows[rowIndex].isStraight ?? (rowIndex >= numRows - config.straightRows)
    const maxStraightWidth = config.rows.reduce((mx, r, i) =>
      isStraightRow(i) ? Math.max(mx, (r.chairs.length - 1) * (r.straightSpacing ?? STRAIGHT_CHAIR_SPACING)) : mx, 0)
    // Mirror the label x with the rest of the chart when flipped (row label
    // sits past the conductor's centre on the chair side).
    const straightLabelX = ox + (config.flipped ? 1 : -1) * (maxStraightWidth / 2 + CHAIR_HALF + 18)

    // Section layout: chairs carrying a `group` tag (set by the orchestra
    // generator / "Tidy sections") are clustered together per section within
    // each row (see renderArcRow's "donut slice" placement). Rows with no
    // grouped chairs are unaffected (existing even-spread behaviour).
    let seatNumber = 1
    config.rows.forEach((row, rowIndex) => {
      const r = radii[rowIndex]
      if (isStraightRow(rowIndex)) {
        seatNumber = this.renderStraightRow(ctx, row, rowIndex, oy + yDir * r, ox, oy, config, seatNumber, straightLabelX)
      } else {
        seatNumber = this.renderArcRow(ctx, row, rowIndex, r, ox, oy, yDir, config, seatNumber)
      }
    })

    if (this.layoutMode) {
      this.renderLayoutHandles(ctx, config, ox, oy, yDir, radii, rowSpacing, isStraightRow)
    }
  }

  private renderArcRow(
    ctx: CanvasRenderingContext2D,
    row: Row,
    rowIndex: number,
    r: number,
    ox: number, oy: number, yDir: number,
    config: ChartConfig,
    seatNumber: number,
  ): number {
    const chairs = row.chairs
    const N = chairs.length
    if (N === 0) return seatNumber

    // Arc span — global default (full semicircle) unless this row carries its
    // own start/end override from the Layout tab.
    const [startAngle, endAngle] = this.rowArcAngles(row, config)
    const totalSpan = startAngle - endAngle

    // Each chair's natural (un-nudged) slot angle. Two modes:
    //  - Grouped ("donut slice"): every chair carries a `group` (set by the
    //    generator / Tidy sections). This row's OWN chairs are laid out at
    //    fixed PHYSICAL spacing — desks tight, a wider gap between sections —
    //    then the whole row is centred within its arc span. Because the
    //    spacing is in pixels (not a shared angular grid), a desk always has
    //    room at any radius, so front rows can sit close to the conductor
    //    without collapsing; sections keep real width at the front and fan
    //    outward as rows gain players.
    //  - Default: every chair gets its own evenly-spread slot across the
    //    row's full arc span (today's behaviour) — used whenever any chair
    //    in the row lacks a `group`.
    const allGrouped = N > 0 && chairs.every(c => !!c.group)
    const naturalAngles: number[] = new Array(N)
    if (allGrouped) {
      // Physical spacing (px, centre-to-centre) between consecutive chairs.
      const DESK_ADV = 56       // the two chairs of one desk
      const BETWEEN_ADV = 74    // adjacent desk-units within a section
      const SECTION_ADV = 40    // extra at a section boundary
      const posPx: number[] = new Array(N)
      posPx[0] = 0
      for (let i = 1; i < N; i++) {
        const prev = chairs[i - 1], cur = chairs[i]
        const deskPair =
          (prev.standAfter && prev.enabled && cur.enabled) ||
          (!prev.enabled && !cur.enabled)
        let adv: number
        if (deskPair) adv = DESK_ADV
        else if (cur.group === prev.group) adv = BETWEEN_ADV
        else adv = BETWEEN_ADV + SECTION_ADV
        posPx[i] = posPx[i - 1] + adv
      }
      const W = posPx[N - 1]
      // Centre on the row's arc midpoint; compress only if the content would
      // overflow the available span (a very dense front row), never expand.
      const maxW = totalSpan * r
      const scale = W > maxW && W > 0 ? maxW / W : 1
      const center = (startAngle + endAngle) / 2
      for (let i = 0; i < N; i++) {
        naturalAngles[i] = center + (W / 2 - posPx[i]) * scale / r
      }
    } else {
      const naturalStep = N > 1 ? totalSpan / (N - 1) : 0
      for (let i = 0; i < N; i++) naturalAngles[i] = startAngle - i * naturalStep
    }

    // Per-chair sideways nudge (px tangential → angle). Positive moves the
    // chair toward the end of the row (decreasing angle). Default 0.
    const place = (angle: number, chair: Chair) => {
      const a = angle - (chair.offset ?? 0) / r
      return { cx: ox + xDir * r * Math.cos(a), cy: oy + yDir * r * Math.sin(a) }
    }
    // When two chairs share a desk (standAfter, or two adjacent disabled
    // placeholders), the pair pulls toward the midpoint of their natural
    // slots until the chairs sit DESK_PAIR_SPACING centre-to-centre apart.
    // If their natural separation is already tighter than that, they stay
    // put — we never push chairs apart.
    const desiredHalfOffset = DESK_PAIR_SPACING / 2 / r
    // When the chart is flipped, mirror chairs left↔right as well as the
    // existing top↔bottom flip — flipping is a 180° rotation around the
    // conductor, not just a vertical reflection. Chair 0 (leftmost in the
    // unflipped view) ends up rightmost so the layout looks identical from
    // the conductor's perspective regardless of which side you're viewing.
    const xDir = -yDir

    const positions: Array<{ cx: number; cy: number }> = new Array(N)
    let i = 0
    while (i < N) {
      const c = chairs[i]
      const next = i + 1 < N ? chairs[i + 1] : null
      // A real desk needs two present players; pairing into a hidden seat is
      // meaningless (and used to draw a stand floating toward a ghost chair).
      const isPair = !!next && (
        (c.standAfter && c.enabled && next.enabled) ||
        (!c.enabled && !next.enabled)
      )
      if (isPair) {
        const a0 = naturalAngles[i]
        const a1 = naturalAngles[i + 1]
        const midpoint = (a0 + a1) / 2
        const localStep = a0 - a1
        const halfSep = Math.min(localStep / 2, desiredHalfOffset)
        const angleA = midpoint + halfSep
        const angleB = midpoint - halfSep
        positions[i]     = place(angleA, c)
        positions[i + 1] = place(angleB, chairs[i + 1]!)
        i += 2
      } else {
        positions[i] = place(naturalAngles[i], c)
        i += 1
      }
    }

    chairs.forEach((chair, chairIndex) => {
      const { cx, cy } = positions[chairIndex]
      if (chair.enabled) {
        this.drawChair(ctx, chair, cx, cy, ox, oy, row.fontSize, this.isNudged(chair), this.isChairHovered(rowIndex, chairIndex))
        if (chair.hasStand) this.drawStandX(ctx, cx, cy, ox, oy, undefined, { rowIndex, chairIndex })
        // Standing players aren't numbered seats — no number drawn, and they
        // don't consume one (so the seated chairs stay sequential).
        if (!chair.noSeat) {
          if (config.showNumbers) {
            const num = config.numberRestartPerRow
              ? chairs.slice(0, chairIndex).filter(c => c.enabled && !c.noSeat).length + 1
              : seatNumber
            this.drawSeatNumber(ctx, cx, cy, ox, oy, String(num), row.fontSize)
          }
          seatNumber++
        }
      } else if (this.showGhosts) {
        this.drawGhostChair(ctx, cx, cy, ox, oy)
      }
      this.hitTargets.push({ rowIndex, chairIndex, x: cx, y: cy, radius: CHAIR_HALF * 1.1 })
    })

    // Shared stand between desk-paired chairs — only when BOTH players are
    // present. Hiding either seat dissolves the desk (no stand to a ghost).
    chairs.forEach((chair, chairIndex) => {
      if (!chair.standAfter || chairIndex + 1 >= positions.length) return
      const next = chairs[chairIndex + 1]
      if (!chair.enabled || !next.enabled) return
      const a = positions[chairIndex]
      const b = positions[chairIndex + 1]
      const mx = (a.cx + b.cx) / 2, my = (a.cy + b.cy) / 2
      this.drawStandX(ctx, mx, my, ox, oy, undefined, { rowIndex, chairIndex })
      // Group-drag handle sits on the arc, in the gap between the desk's two
      // chairs, so it's unambiguously tied to them (and clear of the shared
      // stand ×, which is offset toward the conductor in front of this point).
      this.deskHandles.push({ rowIndex, chairIndex, cx: mx, cy: my })
    })

    if (config.showRowLabels) {
      // Label to the left of the leftmost chair (or right of the rightmost
      // when flipped, since "leftmost" mirrors across), pushed past the
      // conductor line so it sits "behind" the row rather than beside it.
      const lx = ox + xDir * (-r - CHAIR_HALF - 6)
      const ly = oy - yDir * (CHAIR_HALF + 8)
      this.drawRowLabel(ctx, row.label, lx, ly)
    }

    return seatNumber
  }

  /**
   * Draw one row's worth of chairs in a horizontal line at y = rowY,
   * centred on `ox`. Used both by the "straight rows from back" feature in
   * semicircle layouts and by the pure straight layout. Mutates seatNumber
   * via the return value; pushes hit targets as a side effect.
   */
  private renderStraightRow(
    ctx: CanvasRenderingContext2D,
    row: Row,
    rowIndex: number,
    rowY: number,
    ox: number, oy: number,
    config: ChartConfig,
    seatNumber: number,
    labelX: number,
  ): number {
    const total = row.chairs.length
    if (total === 0) return seatNumber

    const spacing = row.straightSpacing ?? STRAIGHT_CHAIR_SPACING
    const centerOffset = row.straightOffset ?? 0
    const rowWidth = (total - 1) * spacing
    // Flip mirrors left↔right around the conductor (the renderer's whole
    // notion of "flipped" is a 180° rotation around the conductor, not just
    // a vertical flip). xDir is the x-axis equivalent of the existing yDir.
    const xDir = config.flipped ? -1 : 1
    const positions: Array<{ cx: number; cy: number }> = []

    row.chairs.forEach((chair, chairIndex) => {
      // Chair distance from ox, with mirror baked in. straightOffset shifts
      // the whole row sideways; chair.offset nudges this one chair along it.
      const cx = ox + xDir * (chairIndex * spacing - rowWidth / 2 + centerOffset + (chair.offset ?? 0))
      positions.push({ cx, cy: rowY })

      if (chair.enabled) {
        this.drawChair(ctx, chair, cx, rowY, cx, oy, row.fontSize, this.isNudged(chair), this.isChairHovered(rowIndex, chairIndex))
        if (chair.hasStand) this.drawStandX(ctx, cx, rowY, cx, oy, undefined, { rowIndex, chairIndex })
        // Standing players aren't numbered seats (see semicircle path).
        if (!chair.noSeat) {
          if (config.showNumbers) {
            const num = config.numberRestartPerRow
              ? row.chairs.slice(0, chairIndex).filter(c => c.enabled && !c.noSeat).length + 1
              : seatNumber
            this.drawSeatNumber(ctx, cx, rowY, cx, oy, String(num), row.fontSize)
          }
          seatNumber++
        }
      } else if (this.showGhosts) {
        this.drawGhostChair(ctx, cx, rowY, cx, oy)
      }

      this.hitTargets.push({ rowIndex, chairIndex, x: cx, y: rowY, radius: CHAIR_HALF * 1.1 })
    })

    // Shared stands between desk-paired chairs — only when both seats are
    // filled, so a hidden neighbour doesn't leave a stand drawn to a ghost.
    row.chairs.forEach((chair, chairIndex) => {
      const next = row.chairs[chairIndex + 1]
      if (chair.standAfter && chair.enabled && next?.enabled && chairIndex + 1 < positions.length) {
        const a = positions[chairIndex]
        const b = positions[chairIndex + 1]
        const mx = (a.cx + b.cx) / 2, my = (a.cy + b.cy) / 2
        this.drawStandX(ctx, mx, my, a.cx, oy, undefined, { rowIndex, chairIndex })
        // Group-drag handle on the row line, between the desk's two chairs.
        this.deskHandles.push({ rowIndex, chairIndex, cx: mx, cy: my })
      }
    })

    if (config.showRowLabels) this.drawRowLabel(ctx, row.label, labelX, rowY)
    return seatNumber
  }

  // ---------------------------------------------------------------------------
  // Pure straight layout
  // ---------------------------------------------------------------------------

  private renderStraight(ctx: CanvasRenderingContext2D, config: ChartConfig, w: number, h: number) {
    const numRows = config.rows.length
    const rowSpacing = this.effectiveRowSpacing(h, numRows, config.rowSpacing ?? ROW_SPACING_DEFAULT)
    const offX = config.conductor.offsetX ?? 0
    const offY = config.conductor.offsetY ?? 0
    const ox = w / 2 + offX
    const oy = this.computeOy(h, config, rowSpacing) + offY
    const yDir = config.flipped ? 1 : -1
    this.conductorOrigin = { ox, oy, yDir, flipped: config.flipped }

    this.drawConductor(ctx, ox, oy, yDir, config)

    // Consistent label x: align all labels to the left edge of the widest
    // row (or right edge when flipped, mirrored around the conductor).
    const maxRowWidth = config.rows.reduce((mx, r) =>
      Math.max(mx, (r.chairs.length - 1) * (r.straightSpacing ?? STRAIGHT_CHAIR_SPACING)), 0)
    const labelX = ox + (config.flipped ? 1 : -1) * (maxRowWidth / 2 + CHAIR_HALF + 18)

    const radii = this.computeRowRadii(config.rows, rowSpacing)
    let seatNumber = 1
    config.rows.forEach((row, rowIndex) => {
      const rowY = oy + yDir * radii[rowIndex]
      seatNumber = this.renderStraightRow(ctx, row, rowIndex, rowY, ox, oy, config, seatNumber, labelX)
    })

    if (this.layoutMode) {
      this.renderLayoutHandles(ctx, config, ox, oy, yDir, radii, rowSpacing, () => true)
    }
  }

  // ---------------------------------------------------------------------------
  // Layout-tab handles
  // ---------------------------------------------------------------------------

  // Draws each row's distance handle (radial diamond at the apex) and span
  // handles (tangential circles at the ends), and records both the hit
  // targets and the per-row geometry main.ts uses to drive the drags.
  private renderLayoutHandles(
    ctx: CanvasRenderingContext2D,
    config: ChartConfig,
    ox: number, oy: number, yDir: number,
    radii: number[],
    rowSpacing: number,
    isStraightRow: (i: number) => boolean,
  ) {
    const xDir = -yDir
    const HANDLE_GAP = 24
    const endPad = CHAIR_HALF + 12

    config.rows.forEach((row, i) => {
      const r = radii[i]
      const base = i === 0 ? BASE_RADIUS : radii[i - 1] + rowSpacing
      const prevR = i === 0 ? 0 : radii[i - 1]
      const N = row.chairs.length
      const straight = isStraightRow(i)
      const geom: RowGeometry = {
        rowIndex: i, isStraight: straight, r, base, prevR,
        arcStart: 0, arcEnd: 0, rowY: 0, spacing: 0, centerOffset: 0,
      }

      let distPt: { x: number; y: number }
      let startPt: { x: number; y: number } | null = null
      let endPt: { x: number; y: number } | null = null

      if (straight) {
        const spacing = row.straightSpacing ?? STRAIGHT_CHAIR_SPACING
        const centerOffset = row.straightOffset ?? 0
        const rowY = oy + yDir * r
        const rowWidth = (N - 1) * spacing
        geom.rowY = rowY; geom.spacing = spacing; geom.centerOffset = centerOffset
        distPt = { x: ox + xDir * centerOffset, y: oy + yDir * (r + HANDLE_GAP) }
        if (N > 1) {
          startPt = { x: ox + xDir * (centerOffset - rowWidth / 2 - endPad), y: rowY }
          endPt   = { x: ox + xDir * (centerOffset + rowWidth / 2 + endPad), y: rowY }
        }
      } else {
        const [arcStart, arcEnd] = this.rowArcAngles(row, config)
        geom.arcStart = arcStart; geom.arcEnd = arcEnd
        distPt = { x: ox, y: oy + yDir * (r + HANDLE_GAP) }   // apex (angle π/2) is vertical
        if (N > 1) {
          const da = endPad / r
          const aS = arcStart + da, aE = arcEnd - da
          startPt = { x: ox + xDir * r * Math.cos(aS), y: oy + yDir * r * Math.sin(aS) }
          endPt   = { x: ox + xDir * r * Math.cos(aE), y: oy + yDir * r * Math.sin(aE) }
        }
      }

      this.layoutRows[i] = geom
      this.drawLayoutDiamond(ctx, distPt.x, distPt.y)
      this.layoutHandles.push({ rowIndex: i, kind: 'distance', cx: distPt.x, cy: distPt.y, radius: 13 })
      if (startPt) {
        this.drawLayoutDot(ctx, startPt.x, startPt.y)
        this.layoutHandles.push({ rowIndex: i, kind: 'span-start', cx: startPt.x, cy: startPt.y, radius: 11 })
      }
      if (endPt) {
        this.drawLayoutDot(ctx, endPt.x, endPt.y)
        this.layoutHandles.push({ rowIndex: i, kind: 'span-end', cx: endPt.x, cy: endPt.y, radius: 11 })
      }
    })

    // Chart-wide DEFAULT arc-range handles: two radial lines from the conductor
    // at the default arc's ends. Dragging them sets config.arcRange, which moves
    // every row that hasn't had its own arc edited. (Semicircle only.)
    if (config.layout === 'semicircle') {
      const range = config.arcRange ?? Math.PI
      const maxR = config.rows.reduce((m, _r, i) => Math.max(m, radii[i] ?? 0), BASE_RADIUS)
      const R = maxR + 46
      const ends: Array<[number, 'arc-range-start' | 'arc-range-end']> = [
        [Math.PI / 2 + range / 2, 'arc-range-start'],
        [Math.PI / 2 - range / 2, 'arc-range-end'],
      ]
      for (const [a, kind] of ends) {
        const ex = ox + xDir * R * Math.cos(a)
        const ey = oy + yDir * R * Math.sin(a)
        const sx = ox + xDir * 30 * Math.cos(a)   // start just outside the podium
        const sy = oy + yDir * 30 * Math.sin(a)
        ctx.save()
        ctx.strokeStyle = '#7c3aed'
        ctx.lineWidth = 1.5
        ctx.setLineDash([5, 4])
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke()
        ctx.setLineDash([])
        ctx.beginPath(); ctx.arc(ex, ey, 6, 0, Math.PI * 2)
        ctx.fillStyle = '#7c3aed'; ctx.fill()
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke()
        ctx.restore()
        this.layoutHandles.push({ rowIndex: -1, kind, cx: ex, cy: ey, radius: 12 })
      }
    }

    // Per-desk group handles: a teal dot behind each two-chair desk. Dragging
    // it slides the pair (and their shared stand) along the row together.
    for (const d of this.deskHandles) {
      this.drawDeskDot(ctx, d.cx, d.cy)
      this.layoutHandles.push({
        rowIndex: d.rowIndex, kind: 'desk', chairIndex: d.chairIndex,
        cx: d.cx, cy: d.cy, radius: 12,
      })
    }
  }

  // Group-move handle for a desk pair: a teal disc with a white ring and centre
  // pip, distinct from the blue per-row dots and the purple arc-range handles.
  private drawDeskDot(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
    ctx.save()
    ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2)
    ctx.fillStyle = '#0d9488'; ctx.fill()
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke()
    ctx.beginPath(); ctx.arc(cx, cy, 2, 0, Math.PI * 2)
    ctx.fillStyle = '#fff'; ctx.fill()
    ctx.restore()
  }

  private drawLayoutDiamond(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
    const s = 7
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(cx, cy - s); ctx.lineTo(cx + s, cy); ctx.lineTo(cx, cy + s); ctx.lineTo(cx - s, cy)
    ctx.closePath()
    ctx.fillStyle = '#2563eb'; ctx.fill()
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke()
    ctx.restore()
  }

  private drawLayoutDot(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
    ctx.save()
    ctx.beginPath(); ctx.arc(cx, cy, 5.5, 0, Math.PI * 2)
    ctx.fillStyle = '#2563eb'; ctx.fill()
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke()
    ctx.restore()
  }

  layoutHandleHitTest(x: number, y: number): LayoutHandleHit | null {
    // On touch/pen, guarantee a finger-sized hit area: handles are stored in
    // logical px, so a constant on-screen radius needs ÷ viewScale (the chart
    // is drawn smaller on a phone, which would otherwise shrink the targets).
    const minScreen = this.coarsePointer ? 22 : 0
    for (let i = this.layoutHandles.length - 1; i >= 0; i--) {
      const h = this.layoutHandles[i]
      const r = Math.max(h.radius, minScreen / (this.viewScale || 1))
      if (Math.hypot(x - h.cx, y - h.cy) <= r) return h
    }
    return null
  }

  // The drawn centre of a specific chair (for clamping a per-chair nudge
  // against its neighbours). Reads this frame's hit targets.
  // Whether a chair should show the hover wash: either its whole row is hovered
  // (sidebar) or it is the single hovered chair (canvas).
  private isChairHovered(rowIndex: number, chairIndex: number): boolean {
    if (this.hoverRowIndex === rowIndex) return true
    const c = this.hoverChair
    return c !== null && c.rowIndex === rowIndex && c.chairIndex === chairIndex
  }

  chairCenter(rowIndex: number, chairIndex: number): { x: number; y: number } | null {
    for (const t of this.hitTargets) {
      if (t.rowIndex === rowIndex && t.chairIndex === chairIndex) return { x: t.x, y: t.y }
    }
    return null
  }

  // Every chair whose drawn centre falls inside the given rect (chart/logical
  // coords). Used by the Edit-tab marquee bulk-apply. The rect corners are
  // normalised so the drag direction doesn't matter.
  chairsInRect(ax: number, ay: number, bx: number, by: number): Array<{ rowIndex: number; chairIndex: number }> {
    const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx)
    const y0 = Math.min(ay, by), y1 = Math.max(ay, by)
    const out: Array<{ rowIndex: number; chairIndex: number }> = []
    for (const t of this.hitTargets) {
      if (t.x >= x0 && t.x <= x1 && t.y >= y0 && t.y <= y1) {
        out.push({ rowIndex: t.rowIndex, chairIndex: t.chairIndex })
      }
    }
    return out
  }

  // ---------------------------------------------------------------------------
  // Fixed instruments (rhythm section, timpani, mallets, etc.)
  // ---------------------------------------------------------------------------

  // Symmetric / orientation-neutral glyphs stay upright in canvas coords when
  // the chart is flipped — rotating them just looks upside-down for no benefit.
  private keepUpright(inst: FixedInstrument): boolean {
    return inst.type === 'drumkit' || inst.type === 'guitar-amp'
      || inst.type === 'bass-amp' || inst.type === 'stand'
      || inst.type === 'stool' || inst.type === 'microphone'
      || inst.type === 'gong' || inst.type === 'cymbal' || inst.type === 'snare'
  }

  // Draws one instrument glyph in the current (already translated/rotated)
  // frame and returns its intrinsic half-size. Shared by the real render and
  // the measure-only pass used for title clearance, so dimensions never drift.
  private drawGlyph(ctx: CanvasRenderingContext2D, inst: FixedInstrument): GlyphResult {
    switch (inst.type) {
      case 'drumkit':    return drawDrumkit(ctx)
      case 'piano':      return drawPiano(ctx)
      case 'guitar-amp': return drawAmp(ctx, 32, 34)
      case 'bass-amp':   return drawAmp(ctx, 40, 42)
      case 'timpani':    return drawTimpani(ctx, inst)
      case 'mallet':     return drawMallet(ctx)
      case 'harp':       return drawHarp(ctx)
      case 'microphone': return drawMicrophone(ctx, inst)
      case 'gong':       return drawGong(ctx)
      case 'cymbal':     return drawSuspendedCymbal(ctx)
      case 'snare':      return drawSnareDrum(ctx)
      case 'chair':      return drawSingleChair(ctx)
      case 'stand':      return drawSingleStand(ctx)
      case 'stool':      return drawStool(ctx)
      case 'square':     return drawGenericRect(ctx, 28, 28)
      case 'rectangle':  return drawGenericRect(ctx, 42, 26)
      default:           return { hw: 0, hh: 0, labelInside: false }
    }
  }

  // Intrinsic half-width/height of an instrument glyph, measured by drawing it
  // to a throwaway off-screen context (so the exact glyph code defines the size
  // — no duplicated dimension tables to keep in sync).
  private glyphDims(inst: FixedInstrument): { hw: number; hh: number } {
    if (!this.measureCtx) this.measureCtx = document.createElement('canvas').getContext('2d')
    const { hw, hh } = this.drawGlyph(this.measureCtx!, inst)
    return { hw, hh }
  }

  private renderInstruments(ctx: CanvasRenderingContext2D, config: ChartConfig) {
    const instruments = config.instruments ?? []
    if (instruments.length === 0) return
    const { ox, oy, flipped } = this.conductorOrigin
    // Flipped chart is a 180° rotation around the conductor. For fixed
    // instruments, both the position (dx, dy from conductor) and the
    // glyph's local rotation rotate by π — except for visually-symmetric
    // hardware (drum kit, amps) where flipping the rotation just makes
    // them look upside-down without communicating anything useful.
    const mirror = flipped ? -1 : 1

    instruments.forEach(inst => {
      const cx = ox + mirror * inst.distance * Math.cos(inst.angle)
      const cy = oy + mirror * inst.distance * Math.sin(inst.angle)
      // Symmetric / orientation-neutral glyphs stay upright in canvas
      // coords when the chart is flipped — rotating them just looks
      // upside-down for no benefit.
      const worldRotation = inst.rotation + (flipped && !this.keepUpright(inst) ? Math.PI : 0)
      const isSelected = inst.id === this.selectedInstrumentId

      // 1) Draw the glyph in the rotated frame (no label!)
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(worldRotation)

      const { hw, hh, labelInside, labelOffset, radius } = this.drawGlyph(ctx, inst)

      // Selection highlight (still in rotated frame so it tracks the glyph)
      if (isSelected) {
        const pad = 6
        ctx.strokeStyle = '#2563eb'
        ctx.lineWidth = 1.5
        ctx.setLineDash([4, 3])
        ctx.strokeRect(-hw - pad, -hh - pad, (hw + pad) * 2, (hh + pad) * 2)
        ctx.setLineDash([])
      }

      ctx.restore()

      // 2) Draw the label OUTSIDE the rotation so it stays horizontal
      const text = this.instrumentLabel(inst)
      if (labelInside) {
        // Centred over the instrument's centre, white on dark fill
        ctx.save()
        ctx.fillStyle = '#fff'
        ctx.font = 'bold 11px sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(text, cx + (labelOffset?.x ?? 0), cy + (labelOffset?.y ?? 0))
        ctx.restore()
      } else {
        // Below the rotated bounding box's lowest point
        const drop = Math.abs(hw * Math.sin(worldRotation)) + Math.abs(hh * Math.cos(worldRotation))
        ctx.save()
        ctx.fillStyle = '#222'
        ctx.font = 'bold 11px sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillText(text, cx, cy + drop + 4)
        ctx.restore()
      }

      // 3) Optional music stand attached to this instrument — drawn
      // between the instrument body and the conductor regardless of
      // the glyph's own rotation. Sized so it sits just outside the glyph in
      // the direction it's drawn — for a box that's the extent of the rotated
      // bounding box toward the conductor (so a square's corner on the diagonal
      // doesn't poke through), and for a circular glyph it's the disc radius.
      if (inst.hasStand) {
        let reach: number
        if (radius != null) {
          reach = radius
        } else {
          const a = Math.atan2(oy - cy, ox - cx) - worldRotation
          reach = hw * Math.abs(Math.cos(a)) + hh * Math.abs(Math.sin(a))
        }
        this.drawStandX(ctx, cx, cy, ox, oy, reach + STAND_GAP + STAND_SIZE)
      }

      // 4) Selection adornments (only on the selected instrument)
      if (isSelected) {
        this.drawRotateHandle(ctx, cx, cy, hh, worldRotation, inst.id)
        this.drawDeleteHandle(ctx, cx, cy, hw, hh, worldRotation, inst.id)
      }

      // 4) Hit target for the body — uses the rendered (post-flip) position
      // and rotation, so click hit-tests match what the user actually sees.
      this.instrumentHits.push({
        id: inst.id,
        cx, cy, hw, hh,
        rotation: worldRotation,
      })
    })
  }

  private instrumentLabel(inst: FixedInstrument): string {
    if (inst.label) return inst.label
    switch (inst.type) {
      case 'drumkit':    return 'Drum Kit'
      case 'piano':      return 'Piano'
      case 'guitar-amp': return 'Gtr'
      case 'bass-amp':   return 'Bass'
      case 'timpani':    return `Timpani (${inst.count ?? 4})`
      case 'mallet':     return 'Mallets'
      case 'harp':       return 'Harp'
      case 'microphone': return 'Mic'
      case 'gong':       return 'Gong'
      case 'cymbal':     return 'Susp. Cym.'
      case 'snare':      return 'Snare'
      // Single chair / single stand default to no label — they're often
      // used as decorations rather than annotated items. Users can still
      // type a label in the inspector if they want one.
      case 'chair':      return ''
      case 'stand':      return ''
      case 'stool':      return ''
      case 'square':     return 'Square'
      case 'rectangle':  return 'Rectangle'
    }
  }

  // MS-Office style rotate handle: a small green disc above the instrument,
  // connected by a thin line to the top of its (rotated) bounding box.
  private drawRotateHandle(
    ctx: CanvasRenderingContext2D,
    cx: number, cy: number,
    hh: number, rotation: number,
    instId: string,
  ) {
    const stem = 22
    const handleR = 6

    // Local "above" point (0, -hh) rotates to:
    const topX = cx + hh * Math.sin(rotation)
    const topY = cy - hh * Math.cos(rotation)
    // Local handle anchor (0, -hh - stem) rotates to:
    const hx = cx + (hh + stem) * Math.sin(rotation)
    const hy = cy - (hh + stem) * Math.cos(rotation)

    ctx.save()
    // Connecting stem
    ctx.strokeStyle = '#34a853'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(topX, topY)
    ctx.lineTo(hx, hy)
    ctx.stroke()
    // Handle disc with white outline so it pops against any background
    ctx.fillStyle = '#34a853'
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(hx, hy, handleR, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.restore()

    this.rotateHandleHit = { id: instId, cx: hx, cy: hy, radius: handleR + 4 }
  }

  // Red ✕ disc sitting at the top-right corner of the selected instrument's
  // rotated bounding box. Click to delete — same as the inspector's Delete
  // button or pressing Backspace, but discoverable straight from the canvas.
  private drawDeleteHandle(
    ctx: CanvasRenderingContext2D,
    cx: number, cy: number,
    hw: number, hh: number, rotation: number,
    instId: string,
  ) {
    const handleR = 9
    const margin = 6
    // Local top-right corner (hw, -hh) rotated into world coords
    const dx = cx + hw * Math.cos(rotation) - (-hh) * Math.sin(rotation)
    const dy = cy + hw * Math.sin(rotation) + (-hh) * Math.cos(rotation)
    // Nudge a little further out along the (hw, -hh) diagonal so the button
    // sits just outside the bounding box rather than overlapping the glyph
    const len = Math.hypot(hw, hh)
    const nx = (hw / len) * Math.cos(rotation) - (-hh / len) * Math.sin(rotation)
    const ny = (hw / len) * Math.sin(rotation) + (-hh / len) * Math.cos(rotation)
    const px = dx + nx * margin
    const py = dy + ny * margin

    ctx.save()
    ctx.fillStyle = '#dc2626'         // red-600
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(px, py, handleR, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    // White × inside the disc
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    const s = handleR * 0.45
    ctx.beginPath()
    ctx.moveTo(px - s, py - s); ctx.lineTo(px + s, py + s)
    ctx.moveTo(px + s, py - s); ctx.lineTo(px - s, py + s)
    ctx.stroke()
    ctx.restore()

    this.deleteHandleHit = { id: instId, cx: px, cy: py, radius: handleR + 3 }
  }

  // Each glyph returns its half-width / half-height for the hit box.
  // Glyphs draw centred at (0,0) in the current (already rotated) frame.

  // All instrument glyphs are drawn in monochrome (black silhouettes with
  // optional white inner detail) so the chart stays a clean black & white
  // diagram.  Chair colours remain user-controlled.

  // ---------------------------------------------------------------------------
  // Title + Notes — always rendered, WYSIWYG
  // ---------------------------------------------------------------------------

  // Topmost y of the drawn chart (post-chartScale), in canvas pixels: the back
  // row's seat numbers when unflipped, the conductor podium when flipped — and
  // any fixed instrument that sits higher (e.g. percussion behind the band), so
  // the title clears them instead of overlapping. Every instrument counts, even
  // ones off to the side the title wouldn't touch — a stable title beats one
  // that jumps up and down while an instrument is dragged across its span.
  private contentTopY(
    config: ChartConfig, oy: number, rowSpacing: number, scale: number,
  ): number {
    const radii = this.computeRowRadii(config.rows, rowSpacing)
    const maxR = radii.length ? Math.max(...radii) : BASE_RADIUS
    const chairTopUnscaled = config.flipped
      ? oy - (COND_H / 2 + 18)              // conductor podium + a little for its stand
      : oy - maxR - CHAIR_HALF - 16         // back row chair top + the seat number above it
    let top = oy + (chairTopUnscaled - oy) * scale  // chartScale grows the chart around (ox, oy)

    const mirror = config.flipped ? -1 : 1
    for (const inst of config.instruments ?? []) {
      const dims = this.glyphDims(inst)
      const rot = inst.rotation + (config.flipped && !this.keepUpright(inst) ? Math.PI : 0)
      // Rotated bounding-box vertical half extent.
      const vExt = Math.abs(dims.hw * Math.sin(rot)) + Math.abs(dims.hh * Math.cos(rot))
      const cyTop = oy + (mirror * inst.distance * Math.sin(inst.angle) - vExt) * scale
      top = Math.min(top, cyTop)
    }
    return top
  }

  private drawTitle(
    ctx: CanvasRenderingContext2D, title: string, w: number, chartTop: number,
    offsetX: number, offsetY: number, extraGap: number,
  ) {
    if (!title) { this.titleHit = null; return }
    const TITLE_HEIGHT = 20   // approx height of the 18px bold line
    const GAP = 26 + extraGap // breathing room between the title and the chart
    const MIN_TOP = 12        // never crowd the canvas top edge
    const baseY = Math.max(MIN_TOP, chartTop - GAP - TITLE_HEIGHT)
    const cx = w / 2 + offsetX
    const y = baseY + offsetY

    ctx.save()
    ctx.font = 'bold 18px sans-serif'
    const tw = ctx.measureText(title).width
    // Hit rect (canvas px — the title is drawn at canvas scale, not chartScale),
    // padded a little so it's easy to grab in layout mode.
    this.titleHit = { x: cx - tw / 2 - 6, y: y - 4, w: tw + 12, h: TITLE_HEIGHT + 8 }
    if (this.layoutMode) {
      ctx.strokeStyle = '#2563eb'
      ctx.lineWidth = 1
      ctx.setLineDash([4, 3])
      ctx.strokeRect(this.titleHit.x, this.titleHit.y, this.titleHit.w, this.titleHit.h)
      ctx.setLineDash([])
    }
    ctx.fillStyle = '#111'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(title, cx, y)
    ctx.restore()
  }

  titleHitTest(x: number, y: number): boolean {
    const t = this.titleHit
    return !!t && x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h
  }

  private drawNotes(ctx: CanvasRenderingContext2D, notes: string, h: number, creditShown: boolean) {
    if (!notes) return
    const lines = notes.split('\n').filter(l => l.trim())
    if (lines.length === 0) return

    const lineHeight = 14
    const x = 12
    // Sit above the "Created with StagePlan" credit when it's drawn, so
    // the two never overlap. Credit line is ~14px tall (10px font + 4px
    // breathing room) and itself anchored at the bottom-text baseline.
    const creditReserve = creditShown ? 16 : 0
    const bottomY = h - 24 - creditReserve

    ctx.save()
    ctx.fillStyle = '#888'
    ctx.font = '11px sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'bottom'
    lines.forEach((line, i) => {
      ctx.fillText(line, x, bottomY - (lines.length - 1 - i) * lineHeight)
    })
    ctx.restore()
  }

  // Light-grey vertical "STAGE RIGHT" / "STAGE LEFT" labels on the canvas
  // edges, from the performer's perspective. Stage right = audience left
  // = canvas left; stage left = canvas right. Both rotated so they read
  // bottom-to-top (the spine-text convention).
  private drawStageDirections(ctx: CanvasRenderingContext2D, w: number, h: number) {
    ctx.save()
    ctx.fillStyle = '#ddd'
    ctx.font = 'bold 26px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    // Left edge — Stage Right
    ctx.save()
    ctx.translate(26, h / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.fillText('STAGE RIGHT', 0, 0)
    ctx.restore()

    // Right edge — Stage Left
    ctx.save()
    ctx.translate(w - 26, h / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.fillText('STAGE LEFT', 0, 0)
    ctx.restore()

    ctx.restore()
  }

  // ---------------------------------------------------------------------------
  // Row summary — always rendered in bottom-right corner
  // ---------------------------------------------------------------------------

  private drawRowSummary(ctx: CanvasRenderingContext2D, config: ChartConfig, w: number, h: number) {
    const lines = config.rows.map((row, i) => {
      const count = row.chairs.filter(c => c.enabled).length
      const label = config.showRowLabels ? `Row ${row.label}` : `Row ${i + 1}`
      return `${label}: ${count} chair${count !== 1 ? 's' : ''}`
    })

    let totalChairs = 0
    let totalStools = 0
    let totalStanding = 0
    let totalStands = 0
    for (const row of config.rows) {
      row.chairs.forEach((chair, i) => {
        if (!chair.enabled) return
        if (chair.noSeat) totalStanding++
        else if (chair.isStool) totalStools++
        else totalChairs++
        if (chair.hasStand) totalStands++
        // Only count a desk stand that's actually drawn (next seat filled).
        if (chair.standAfter && row.chairs[i + 1]?.enabled) totalStands++
      })
    }
    // Timpani players sit on a stool too — include them in the stool total.
    for (const inst of config.instruments ?? []) {
      if (inst.type === 'timpani' && inst.stool) totalStools++
    }
    if (config.rows.length > 1) {
      const plural = (n: number, word: string) => `${n} ${word}${n !== 1 ? 's' : ''}`
      const parts: string[] = []
      // Always show a chair count unless the chart is purely stools/standing.
      if (totalChairs > 0 || (totalStools === 0 && totalStanding === 0)) parts.push(plural(totalChairs, 'chair'))
      if (totalStools > 0) parts.push(plural(totalStools, 'stool'))
      if (totalStanding > 0) parts.push(`${totalStanding} standing`)
      if (totalStands > 0) parts.push(plural(totalStands, 'stand'))
      lines.push(`Total: ${parts.join(' · ')}`)
    }
    if (totalStands > 0) lines.push('× = music stand')

    const lineHeight = 15
    const x = w - 12
    const bottomY = h - 24

    ctx.save()
    ctx.fillStyle = '#222'
    ctx.font = '11px sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'bottom'

    lines.forEach((line, i) => {
      ctx.fillText(line, x, bottomY - (lines.length - 1 - i) * lineHeight)
    })
    ctx.restore()
  }

  private drawCredit(ctx: CanvasRenderingContext2D, h: number) {
    ctx.save()
    ctx.fillStyle = '#222'
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'bottom'
    ctx.fillText('Created with StagePlan  https://benperche.github.io/StagePlan/', 12, h - 12)
    ctx.restore()
  }

  // ---------------------------------------------------------------------------
  // Drawing primitives
  // ---------------------------------------------------------------------------

  // A chair counts as "nudged" (worth the Layout-tab blue outline) only in
  // layout mode and only when it actually carries a non-trivial offset.
  private isNudged(chair: Chair): boolean {
    return this.layoutMode && chair.offset !== undefined && Math.abs(chair.offset) > 0.5
  }

  private drawChair(
    ctx: CanvasRenderingContext2D,
    chair: Chair,
    cx: number, cy: number,
    condX: number, condY: number,
    fontSize: number,
    highlight = false,
    rowHover = false,
  ) {
    const faceAngle = Math.atan2(condY - cy, condX - cx)

    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(faceAngle + Math.PI / 2)

    // Standing player: no chair/stool glyph at all, just the label (drawn
    // below) and whatever stand the caller adds.
    if (chair.noSeat) {
      // nothing to draw here
    } else if (chair.isStool) {
      // Round seat with four small legs poking out at the diagonals —
      // a double-bass stool. Keeps the chair's colour so colour-coding
      // (e.g. principals) still applies.
      const r = CHAIR_HALF - 2
      const legLen = 5
      const legW = 3
      ctx.fillStyle = '#333'
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + i * Math.PI / 2
        const lx = Math.cos(a) * (r - 1)
        const ly = Math.sin(a) * (r - 1)
        ctx.save()
        ctx.translate(lx, ly)
        ctx.rotate(a)
        ctx.fillRect(0, -legW / 2, legLen, legW)
        ctx.restore()
      }
      ctx.beginPath()
      ctx.arc(0, 0, r, 0, Math.PI * 2)
      ctx.fillStyle = chair.color
      ctx.fill()
      ctx.strokeStyle = '#555'
      ctx.lineWidth = 1.5
      ctx.stroke()
    } else {
      ctx.beginPath()
      ctx.rect(-CHAIR_HALF, -CHAIR_HALF, CHAIR_SIZE, CHAIR_SIZE)
      ctx.fillStyle = chair.color
      ctx.fill()
      ctx.strokeStyle = '#555'
      ctx.lineWidth = 1.5
      ctx.stroke()

      // Back rail on the outer edge (away from conductor)
      ctx.beginPath()
      ctx.moveTo(-CHAIR_HALF, CHAIR_HALF)
      ctx.lineTo(CHAIR_HALF, CHAIR_HALF)
      ctx.strokeStyle = '#333'
      ctx.lineWidth = 4
      ctx.stroke()
    }

    // Row-hover highlight: a translucent amber wash matching the seat's shape
    // (square chair / round stool) and orientation, so it never looks out of
    // place against the square chairs. Drawn in the rotated frame.
    if (rowHover) {
      ctx.fillStyle = 'rgba(245, 158, 11, 0.28)'
      ctx.strokeStyle = 'rgba(217, 119, 6, 0.9)'
      ctx.lineWidth = 2
      if (chair.isStool) {
        ctx.beginPath()
        ctx.arc(0, 0, CHAIR_HALF + 2, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      } else {
        // Normal seats and standing slots both get a square so the row's
        // position reads clearly even where a player is standing (no glyph).
        ctx.fillRect(-CHAIR_HALF - 2, -CHAIR_HALF - 2, CHAIR_SIZE + 4, CHAIR_SIZE + 4)
        ctx.strokeRect(-CHAIR_HALF - 2, -CHAIR_HALF - 2, CHAIR_SIZE + 4, CHAIR_SIZE + 4)
      }
    }

    // Layout tab: a nudged chair gets a blue outline so it's obvious which
    // ones have been moved off their default slot.
    if (highlight && !chair.noSeat) {
      ctx.strokeStyle = '#2563eb'
      ctx.lineWidth = 2.5
      if (chair.isStool) {
        ctx.beginPath()
        ctx.arc(0, 0, CHAIR_HALF, 0, Math.PI * 2)
        ctx.stroke()
      } else {
        ctx.strokeRect(-CHAIR_HALF - 1.5, -CHAIR_HALF - 1.5, CHAIR_SIZE + 3, CHAIR_SIZE + 3)
      }
    }

    ctx.restore()

    // Label drawn upright, supports % as a line-break within the label
    if (chair.label) {
      const fs = Math.max(8, fontSize - 2)
      const lh = fs + 3
      const lines = chair.label.split('%')
      const totalH = lines.length * lh
      ctx.save()
      ctx.fillStyle = '#222'
      ctx.font = `bold ${fs}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      lines.forEach((line, i) => {
        const ly = cy - totalH / 2 + i * lh + lh / 2
        ctx.fillText(line, cx, ly, CHAIR_SIZE - 4)
      })
      ctx.restore()
    }
  }

  private drawGhostChair(
    ctx: CanvasRenderingContext2D,
    cx: number, cy: number,
    condX: number, condY: number,
  ) {
    const faceAngle = Math.atan2(condY - cy, condX - cx)
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(faceAngle + Math.PI / 2)
    ctx.beginPath()
    ctx.rect(-CHAIR_HALF, -CHAIR_HALF, CHAIR_SIZE, CHAIR_SIZE)
    ctx.setLineDash([3, 3])
    ctx.strokeStyle = '#ccc'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.setLineDash([])
    ctx.restore()
  }

  /**
   * Draw a music stand as an × symbol, positioned between the chair origin
   * and the conductor.  For shared stands, pass the midpoint of the two chairs
   * as (cx, cy).
   */
  standHitTest(x: number, y: number): HitTarget | null {
    for (const t of this.standHitTargets) {
      const dx = x - t.x, dy = y - t.y
      if (dx * dx + dy * dy <= t.radius * t.radius) return t
    }
    return null
  }

  private drawStandX(
    ctx: CanvasRenderingContext2D,
    cx: number, cy: number,
    condX: number, condY: number,
    distOverride?: number,
    hitOwner?: { rowIndex: number; chairIndex: number },
  ) {
    const dx = condX - cx
    const dy = condY - cy
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len === 0) return
    const nx = dx / len
    const ny = dy / len

    const dist = distOverride ?? (CHAIR_HALF + STAND_GAP + STAND_SIZE)
    const sx = cx + nx * dist
    const sy = cy + ny * dist

    if (hitOwner) {
      this.standHitTargets.push({ ...hitOwner, x: sx, y: sy, radius: STAND_SIZE * 2.5 })
    }

    const angle = Math.atan2(ny, nx)

    ctx.save()
    ctx.translate(sx, sy)
    // Rotate so the diagonals stay as diagonals relative to the chair —
    // the stand reads as × not +. (Adding π/4 here would align an arm
    // with the chair→conductor radial line and make the symbol look
    // like + when the chair sits at the front of an arc.)
    ctx.rotate(angle)
    ctx.strokeStyle = '#555'
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(-STAND_SIZE, -STAND_SIZE)
    ctx.lineTo(STAND_SIZE, STAND_SIZE)
    ctx.moveTo(STAND_SIZE, -STAND_SIZE)
    ctx.lineTo(-STAND_SIZE, STAND_SIZE)
    ctx.stroke()
    ctx.restore()
  }

  private drawSeatNumber(
    ctx: CanvasRenderingContext2D,
    cx: number, cy: number,
    condX: number, condY: number,
    num: string,
    fontSize: number,
  ) {
    const dx = condX - cx
    const dy = condY - cy
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len === 0) return
    const nx = -dx / len
    const ny = -dy / len
    const offset = CHAIR_HALF + 9

    ctx.save()
    ctx.fillStyle = '#444'
    ctx.font = `${Math.max(9, fontSize - 3)}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(num, cx + nx * offset, cy + ny * offset)
    ctx.restore()
  }

  private drawRowLabel(ctx: CanvasRenderingContext2D, label: string, x: number, y: number) {
    ctx.save()
    ctx.fillStyle = '#333'
    ctx.font = 'bold 13px sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, x, y)
    ctx.restore()
  }

  private drawConductor(
    ctx: CanvasRenderingContext2D,
    ox: number, oy: number,
    yDir: number,
    config: ChartConfig,
  ) {
    const rx = ox - COND_W / 2
    const ry = oy - COND_H / 2
    const label = config.conductor.label ?? 'COND'

    // Always store hit rect so clicking works whether shown or not
    this.conductorHit = { x: rx, y: ry, w: COND_W, h: COND_H }

    if (!config.conductor.show) {
      ctx.save()
      ctx.strokeStyle = '#bbb'
      ctx.lineWidth = 1.5
      ctx.setLineDash([3, 3])
      ctx.strokeRect(rx, ry, COND_W, COND_H)
      ctx.fillStyle = '#bbb'
      ctx.font = '9px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, ox, oy, COND_W - 6)
      ctx.setLineDash([])
      ctx.restore()
      return
    }

    ctx.save()
    ctx.fillStyle = '#555'
    ctx.fillRect(rx, ry, COND_W, COND_H)
    ctx.strokeStyle = '#333'
    ctx.lineWidth = 2
    ctx.strokeRect(rx, ry, COND_W, COND_H)
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 11px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, ox, oy, COND_W - 6)
    ctx.restore()

    if (config.conductor.hasStand) {
      const sw = 32, sh = 16
      const sy = oy + yDir * (COND_H / 2 + 4)
      ctx.save()
      ctx.fillStyle = '#aaa'
      ctx.fillRect(ox - sw / 2, sy, sw, yDir * sh)
      ctx.strokeStyle = '#777'
      ctx.lineWidth = 1
      ctx.strokeRect(ox - sw / 2, sy, sw, yDir * sh)
      ctx.restore()
    }
  }
}
