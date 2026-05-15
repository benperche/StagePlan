import type {
  ChartConfig, Row, Chair, FixedInstrument,
  HitTarget, ConductorHit, InstrumentHit, ConductorOrigin,
} from './types'

const CHAIR_SIZE = 30
const CHAIR_HALF = CHAIR_SIZE / 2
const STAND_GAP = 6
const STAND_SIZE = 7   // half-arm of the ×
const ROW_SPACING = 52
const BASE_RADIUS = 130
const STRAIGHT_CHAIR_SPACING = 40
const CONDUCTOR_EXTENT = 56
const COND_W = 52
const COND_H = 36

export interface RenderOptions {
  scale?: number
}

export class Renderer {
  private hitTargets: HitTarget[] = []
  private instrumentHits: InstrumentHit[] = []
  conductorHit: ConductorHit | null = null
  conductorOrigin: ConductorOrigin = { ox: 0, oy: 0, yDir: -1 }
  selectedInstrumentId: string | null = null

  render(canvas: HTMLCanvasElement, config: ChartConfig, opts: RenderOptions = {}): void {
    const scale = opts.scale ?? 1
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.save()
    ctx.scale(scale, scale)

    this.hitTargets = []
    this.instrumentHits = []
    this.conductorHit = null

    const w = canvas.width / scale
    const h = canvas.height / scale

    this.drawTitle(ctx, config.title, w)
    this.drawNotes(ctx, config.notes, h)

    if (config.layout === 'semicircle') {
      this.renderSemicircle(ctx, config, w, h)
    } else {
      this.renderStraight(ctx, config, w, h)
    }

    // Instruments draw on top so they're always visible & selectable
    this.renderInstruments(ctx, config)

    this.drawRowSummary(ctx, config, w, h)
    ctx.restore()
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

  private computeOy(h: number, numRows: number, flipped: boolean): number {
    const chartHeight = BASE_RADIUS + Math.max(0, numRows - 1) * ROW_SPACING + CHAIR_HALF
    const padding = 16
    if (flipped) {
      return Math.max(padding + CONDUCTOR_EXTENT, (h - chartHeight + CONDUCTOR_EXTENT) / 2)
    } else {
      return Math.min(h - padding - CONDUCTOR_EXTENT, (h + chartHeight - CONDUCTOR_EXTENT) / 2)
    }
  }

  // ---------------------------------------------------------------------------
  // Semicircle layout
  // ---------------------------------------------------------------------------

  private renderSemicircle(ctx: CanvasRenderingContext2D, config: ChartConfig, w: number, h: number) {
    const ox = w / 2
    const numRows = config.rows.length
    const oy = this.computeOy(h, numRows, config.flipped)
    const yDir = config.flipped ? 1 : -1
    this.conductorOrigin = { ox, oy, yDir }

    // Draw arcs first (behind chairs)
    if (config.showArc) {
      config.rows.forEach((_row, rowIndex) => {
        const isStraight = rowIndex >= numRows - config.straightRows
        if (isStraight) return
        const r = BASE_RADIUS + rowIndex * ROW_SPACING
        ctx.save()
        ctx.beginPath()
        ctx.arc(ox, oy, r, Math.PI, 0, yDir > 0)
        ctx.strokeStyle = '#ccc'
        ctx.lineWidth = 1
        ctx.setLineDash([4, 4])
        ctx.stroke()
        ctx.setLineDash([])
        ctx.restore()
      })
    }

    this.drawConductor(ctx, ox, oy, yDir, config)

    // Consistent label x for straight-in-arc rows
    const straightStart = numRows - config.straightRows
    const maxStraightWidth = config.rows.slice(straightStart).reduce((mx, r) =>
      Math.max(mx, (r.chairs.length - 1) * STRAIGHT_CHAIR_SPACING), 0)
    const straightLabelX = ox - maxStraightWidth / 2 - CHAIR_HALF - 18

    let seatNumber = 1
    config.rows.forEach((row, rowIndex) => {
      const r = BASE_RADIUS + rowIndex * ROW_SPACING
      const isStraight = rowIndex >= numRows - config.straightRows
      if (isStraight) {
        seatNumber = this.renderStraightRowInArc(ctx, row, rowIndex, r, ox, oy, yDir, config, seatNumber, straightLabelX)
      } else {
        seatNumber = this.renderArcRow(ctx, row, rowIndex, r, ox, oy, yDir, config, seatNumber)
      }
    })
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
    const total = row.chairs.length   // ALL chairs hold their arc position
    if (total === 0) return seatNumber

    const startAngle = Math.PI
    const endAngle = 0
    const angleStep = total > 1 ? (startAngle - endAngle) / (total - 1) : 0

    const positions: Array<{ cx: number; cy: number }> = []

    row.chairs.forEach((chair, chairIndex) => {
      const angle = startAngle - chairIndex * angleStep
      const cx = ox + r * Math.cos(angle)
      const cy = oy + yDir * r * Math.sin(angle)
      positions.push({ cx, cy })

      if (chair.enabled) {
        this.drawChair(ctx, chair, cx, cy, ox, oy, row.fontSize)
        if (chair.hasStand) this.drawStandX(ctx, cx, cy, ox, oy)
        if (config.showNumbers) {
          const num = config.numberRestartPerRow
            ? row.chairs.slice(0, chairIndex).filter(c => c.enabled).length + 1
            : seatNumber
          this.drawSeatNumber(ctx, cx, cy, ox, oy, String(num), row.fontSize)
        }
        seatNumber++
      } else {
        this.drawGhostChair(ctx, cx, cy, ox, oy)
      }

      // Always store hit target so disabled chairs can be re-enabled
      this.hitTargets.push({ rowIndex, chairIndex, x: cx, y: cy, radius: CHAIR_HALF * 1.1 })
    })

    // Shared stands between adjacent chairs
    row.chairs.forEach((chair, chairIndex) => {
      if (chair.standAfter && chairIndex + 1 < positions.length) {
        const a = positions[chairIndex]
        const b = positions[chairIndex + 1]
        this.drawStandX(ctx, (a.cx + b.cx) / 2, (a.cy + b.cy) / 2, ox, oy)
      }
    })

    if (config.showRowLabels) {
      // Label to the left of the leftmost chair position, pushed past the
      // conductor line so it sits "behind" the row rather than beside it.
      const lx = ox - r - CHAIR_HALF - 6
      const ly = oy - yDir * (CHAIR_HALF + 8)
      this.drawRowLabel(ctx, row.label, lx, ly)
    }

    return seatNumber
  }

  private renderStraightRowInArc(
    ctx: CanvasRenderingContext2D,
    row: Row,
    rowIndex: number,
    r: number,
    ox: number, oy: number, yDir: number,
    config: ChartConfig,
    seatNumber: number,
    labelX: number,
  ): number {
    const total = row.chairs.length
    if (total === 0) return seatNumber

    const rowY = oy + yDir * r
    const rowWidth = (total - 1) * STRAIGHT_CHAIR_SPACING
    const startX = ox - rowWidth / 2

    const positions: Array<{ cx: number; cy: number }> = []

    row.chairs.forEach((chair, chairIndex) => {
      const cx = startX + chairIndex * STRAIGHT_CHAIR_SPACING
      positions.push({ cx, cy: rowY })

      if (chair.enabled) {
        this.drawChair(ctx, chair, cx, rowY, cx, oy, row.fontSize)
        if (chair.hasStand) this.drawStandX(ctx, cx, rowY, cx, oy)
        if (config.showNumbers) {
          const num = config.numberRestartPerRow
            ? row.chairs.slice(0, chairIndex).filter(c => c.enabled).length + 1
            : seatNumber
          this.drawSeatNumber(ctx, cx, rowY, cx, oy, String(num), row.fontSize)
        }
        seatNumber++
      } else {
        this.drawGhostChair(ctx, cx, rowY, cx, oy)
      }

      this.hitTargets.push({ rowIndex, chairIndex, x: cx, y: rowY, radius: CHAIR_HALF * 1.1 })
    })

    // Shared stands
    row.chairs.forEach((chair, chairIndex) => {
      if (chair.standAfter && chairIndex + 1 < positions.length) {
        const a = positions[chairIndex]
        const b = positions[chairIndex + 1]
        this.drawStandX(ctx, (a.cx + b.cx) / 2, (a.cy + b.cy) / 2, a.cx, oy)
      }
    })

    if (config.showRowLabels) {
      this.drawRowLabel(ctx, row.label, labelX, rowY)
    }
    return seatNumber
  }

  // ---------------------------------------------------------------------------
  // Pure straight layout
  // ---------------------------------------------------------------------------

  private renderStraight(ctx: CanvasRenderingContext2D, config: ChartConfig, w: number, h: number) {
    const ox = w / 2
    const numRows = config.rows.length
    const oy = this.computeOy(h, numRows, config.flipped)
    const yDir = config.flipped ? 1 : -1
    this.conductorOrigin = { ox, oy, yDir }

    this.drawConductor(ctx, ox, oy, yDir, config)

    // Consistent label x: align all labels to left edge of widest row
    const maxRowWidth = config.rows.reduce((mx, r) =>
      Math.max(mx, (r.chairs.length - 1) * STRAIGHT_CHAIR_SPACING), 0)
    const labelX = ox - maxRowWidth / 2 - CHAIR_HALF - 18

    let seatNumber = 1

    config.rows.forEach((row, rowIndex) => {
      const total = row.chairs.length
      if (total === 0) return

      const rowY = oy + yDir * (BASE_RADIUS + rowIndex * ROW_SPACING)
      const rowWidth = (total - 1) * STRAIGHT_CHAIR_SPACING
      const startX = ox - rowWidth / 2

      const positions: Array<{ cx: number; cy: number }> = []

      row.chairs.forEach((chair, chairIndex) => {
        const cx = startX + chairIndex * STRAIGHT_CHAIR_SPACING
        positions.push({ cx, cy: rowY })

        if (chair.enabled) {
          this.drawChair(ctx, chair, cx, rowY, cx, oy, row.fontSize)
          if (chair.hasStand) this.drawStandX(ctx, cx, rowY, cx, oy)
          if (config.showNumbers) {
            const num = config.numberRestartPerRow
              ? row.chairs.slice(0, chairIndex).filter(c => c.enabled).length + 1
              : seatNumber
            this.drawSeatNumber(ctx, cx, rowY, cx, oy, String(num), row.fontSize)
          }
          seatNumber++
        } else {
          this.drawGhostChair(ctx, cx, rowY, cx, oy)
        }

        this.hitTargets.push({ rowIndex, chairIndex, x: cx, y: rowY, radius: CHAIR_HALF * 1.1 })
      })

      // Shared stands
      row.chairs.forEach((chair, chairIndex) => {
        if (chair.standAfter && chairIndex + 1 < positions.length) {
          const a = positions[chairIndex]
          const b = positions[chairIndex + 1]
          this.drawStandX(ctx, (a.cx + b.cx) / 2, (a.cy + b.cy) / 2, a.cx, oy)
        }
      })

      if (config.showRowLabels) this.drawRowLabel(ctx, row.label, labelX, rowY)
    })
  }

  // ---------------------------------------------------------------------------
  // Fixed instruments (rhythm section, timpani, mallets, etc.)
  // ---------------------------------------------------------------------------

  private renderInstruments(ctx: CanvasRenderingContext2D, config: ChartConfig) {
    const instruments = config.instruments ?? []
    if (instruments.length === 0) return
    const { ox, oy } = this.conductorOrigin

    instruments.forEach(inst => {
      const cx = ox + inst.distance * Math.cos(inst.angle)
      const cy = oy + inst.distance * Math.sin(inst.angle)
      const isSelected = inst.id === this.selectedInstrumentId

      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(inst.rotation)

      let hw = 0, hh = 0
      switch (inst.type) {
        case 'drumkit':    ({ hw, hh } = this.drawDrumkit(ctx, inst)); break
        case 'piano':      ({ hw, hh } = this.drawPiano(ctx, inst)); break
        case 'guitar-amp': ({ hw, hh } = this.drawAmp(ctx, inst, 'Gtr', 28, 38)); break
        case 'bass-amp':   ({ hw, hh } = this.drawAmp(ctx, inst, 'Bass', 36, 48)); break
        case 'timpani':    ({ hw, hh } = this.drawTimpani(ctx, inst)); break
        case 'mallet':     ({ hw, hh } = this.drawMallet(ctx, inst)); break
      }

      // Selection highlight: dashed rectangle just outside the bounds
      if (isSelected) {
        const pad = 6
        ctx.strokeStyle = '#2563eb'
        ctx.lineWidth = 1.5
        ctx.setLineDash([4, 3])
        ctx.strokeRect(-hw - pad, -hh - pad, (hw + pad) * 2, (hh + pad) * 2)
        ctx.setLineDash([])
      }

      ctx.restore()

      this.instrumentHits.push({
        id: inst.id,
        cx, cy, hw, hh,
        rotation: inst.rotation,
      })
    })
  }

  // Each glyph returns its half-width / half-height for the hit box.
  // Glyphs draw centred at (0,0) in the current (already rotated) frame.

  private drawDrumkit(ctx: CanvasRenderingContext2D, inst: FixedInstrument): { hw: number; hh: number } {
    const r = 26
    // Kick drum
    ctx.fillStyle = '#d4d4d4'
    ctx.strokeStyle = '#444'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(0, 0, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    // Snare (small inner circle, slightly offset toward player)
    ctx.beginPath()
    ctx.arc(0, 8, 8, 0, Math.PI * 2)
    ctx.fillStyle = '#bdbdbd'
    ctx.fill()
    ctx.stroke()
    // Two cymbals at top corners
    ctx.fillStyle = '#e5d28a'
    ctx.strokeStyle = '#9a7e2e'
    ctx.beginPath()
    ctx.arc(-18, -16, 7, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(18, -16, 7, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    // Label below
    this.glyphLabel(ctx, inst.label ?? 'Drums', 0, r + 10)
    return { hw: 26, hh: 28 }
  }

  private drawPiano(ctx: CanvasRenderingContext2D, inst: FixedInstrument): { hw: number; hh: number } {
    // Grand piano top-down: keyboard on the left, curved body on the right.
    // Local frame: keyboard occupies x = -42..-15, body extends x = -15..42.
    ctx.fillStyle = '#1f1f1f'
    ctx.strokeStyle = '#000'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(-42, -25)
    ctx.lineTo(-15, -25)
    // Top curve of body
    ctx.bezierCurveTo(28, -25, 42, -14, 42, 0)
    // Bottom curve of body
    ctx.bezierCurveTo(42, 14, 28, 25, -15, 25)
    ctx.lineTo(-42, 25)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()

    // Keyboard (white) section
    ctx.fillStyle = '#f8f8f8'
    ctx.fillRect(-42, -25, 27, 50)
    ctx.strokeRect(-42, -25, 27, 50)
    // Key separators
    ctx.strokeStyle = '#888'
    ctx.lineWidth = 0.5
    for (let i = 1; i < 7; i++) {
      const ky = -25 + (50 / 7) * i
      ctx.beginPath()
      ctx.moveTo(-42, ky)
      ctx.lineTo(-15, ky)
      ctx.stroke()
    }

    // Label inside the body
    ctx.save()
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 11px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(inst.label ?? 'Piano', 12, 0)
    ctx.restore()

    return { hw: 42, hh: 25 }
  }

  private drawAmp(
    ctx: CanvasRenderingContext2D,
    inst: FixedInstrument,
    defaultLabel: string,
    w: number, h: number,
  ): { hw: number; hh: number } {
    const hw = w / 2, hh = h / 2
    // Cabinet
    ctx.fillStyle = '#2a2a2a'
    ctx.strokeStyle = '#000'
    ctx.lineWidth = 1.5
    this.roundRect(ctx, -hw, -hh, w, h, 3)
    ctx.fill()
    ctx.stroke()
    // Speaker grille
    const sr = Math.min(hw, hh) - 5
    ctx.fillStyle = '#555'
    ctx.beginPath()
    ctx.arc(0, -2, sr * 0.7, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#222'
    ctx.lineWidth = 1
    ctx.stroke()
    // Label below
    this.glyphLabel(ctx, inst.label ?? defaultLabel, 0, hh + 10)
    return { hw, hh }
  }

  private drawTimpani(ctx: CanvasRenderingContext2D, inst: FixedInstrument): { hw: number; hh: number } {
    const count = Math.max(2, Math.min(6, inst.count ?? 4))
    const drumR = 18
    const spacing = drumR * 2 + 6
    const totalW = (count - 1) * spacing
    const startX = -totalW / 2

    ctx.fillStyle = '#c8a96a'   // copper-ish
    ctx.strokeStyle = '#5a4520'
    ctx.lineWidth = 1.5
    for (let i = 0; i < count; i++) {
      const x = startX + i * spacing
      ctx.beginPath()
      ctx.arc(x, 0, drumR, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      // Inner head ring
      ctx.beginPath()
      ctx.arc(x, 0, drumR - 4, 0, Math.PI * 2)
      ctx.strokeStyle = '#8a6a30'
      ctx.lineWidth = 0.8
      ctx.stroke()
      ctx.strokeStyle = '#5a4520'
      ctx.lineWidth = 1.5
    }

    this.glyphLabel(ctx, inst.label ?? `Timpani (${count})`, 0, drumR + 10)
    return { hw: totalW / 2 + drumR, hh: drumR + 4 }
  }

  private drawMallet(ctx: CanvasRenderingContext2D, inst: FixedInstrument): { hw: number; hh: number } {
    // Trapezoid: wider on the left (low end), narrower on the right (high end).
    const w = 120, leftH = 38, rightH = 26
    const hw = w / 2
    ctx.fillStyle = '#c08a55'
    ctx.strokeStyle = '#6b4520'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(-hw, -leftH / 2)
    ctx.lineTo(hw, -rightH / 2)
    ctx.lineTo(hw, rightH / 2)
    ctx.lineTo(-hw, leftH / 2)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    // A few bar separators to suggest keys
    ctx.strokeStyle = '#8c6238'
    ctx.lineWidth = 0.8
    for (let i = 1; i < 5; i++) {
      const t = i / 5
      const x = -hw + t * w
      const yTop = -leftH / 2 + t * (-rightH / 2 - -leftH / 2)
      const yBot = leftH / 2 + t * (rightH / 2 - leftH / 2)
      ctx.beginPath()
      ctx.moveTo(x, yTop)
      ctx.lineTo(x, yBot)
      ctx.stroke()
    }

    ctx.save()
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 11px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'
    ctx.lineWidth = 2.5
    const txt = inst.label ?? 'Mallets'
    ctx.strokeText(txt, 0, 0)
    ctx.fillText(txt, 0, 0)
    ctx.restore()

    return { hw, hh: leftH / 2 }
  }

  private glyphLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number) {
    ctx.save()
    ctx.fillStyle = '#222'
    ctx.font = 'bold 11px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, x, y)
    ctx.restore()
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number, r: number,
  ) {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  }

  // ---------------------------------------------------------------------------
  // Title + Notes — always rendered, WYSIWYG
  // ---------------------------------------------------------------------------

  private drawTitle(ctx: CanvasRenderingContext2D, title: string, w: number) {
    if (!title) return
    ctx.save()
    ctx.fillStyle = '#111'
    ctx.font = 'bold 18px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(title, w / 2, 14)
    ctx.restore()
  }

  private drawNotes(ctx: CanvasRenderingContext2D, notes: string, h: number) {
    if (!notes) return
    const lines = notes.split('\n').filter(l => l.trim())
    if (lines.length === 0) return

    const lineHeight = 14
    const x = 12
    const bottomY = h - 12

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

  // ---------------------------------------------------------------------------
  // Row summary — always rendered in bottom-right corner
  // ---------------------------------------------------------------------------

  private drawRowSummary(ctx: CanvasRenderingContext2D, config: ChartConfig, w: number, h: number) {
    const lines = config.rows.map((row, i) => {
      const count = row.chairs.filter(c => c.enabled).length
      const label = config.showRowLabels ? `Row ${row.label}` : `Row ${i + 1}`
      return `${label}: ${count} chair${count !== 1 ? 's' : ''}`
    })

    // Add legend if any stands are present
    const hasStands = config.rows.some(row =>
      row.chairs.some(c => c.hasStand || c.standAfter)
    )
    if (hasStands) lines.push('× = music stand')

    const lineHeight = 15
    const x = w - 12
    const bottomY = h - 12

    ctx.save()
    ctx.fillStyle = '#888'
    ctx.font = '11px sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'bottom'

    lines.forEach((line, i) => {
      ctx.fillText(line, x, bottomY - (lines.length - 1 - i) * lineHeight)
    })
    ctx.restore()
  }

  // ---------------------------------------------------------------------------
  // Drawing primitives
  // ---------------------------------------------------------------------------

  private drawChair(
    ctx: CanvasRenderingContext2D,
    chair: Chair,
    cx: number, cy: number,
    condX: number, condY: number,
    fontSize: number,
  ) {
    const faceAngle = Math.atan2(condY - cy, condX - cx)

    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(faceAngle + Math.PI / 2)

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
  private drawStandX(
    ctx: CanvasRenderingContext2D,
    cx: number, cy: number,
    condX: number, condY: number,
  ) {
    const dx = condX - cx
    const dy = condY - cy
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len === 0) return
    const nx = dx / len
    const ny = dy / len

    const dist = CHAIR_HALF + STAND_GAP + STAND_SIZE
    const sx = cx + nx * dist
    const sy = cy + ny * dist

    const angle = Math.atan2(ny, nx)

    ctx.save()
    ctx.translate(sx, sy)
    ctx.rotate(angle + Math.PI / 4)
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
      ctx.fillText('COND', ox, oy)
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
    ctx.fillText('COND', ox, oy)
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
