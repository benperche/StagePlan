import type { ChartConfig, Row, Chair, HitTarget } from './types'

const CHAIR_SIZE = 30
const CHAIR_HALF = CHAIR_SIZE / 2
const STAND_W = 16
const STAND_H = 10
const STAND_GAP = 6
const ROW_SPACING = 52
const BASE_RADIUS = 130
const STRAIGHT_CHAIR_SPACING = 40
// Approximate vertical extent of the conductor block (podium + stand)
const CONDUCTOR_EXTENT = 56

export interface RenderOptions {
  scale?: number
}

export class Renderer {
  private hitTargets: HitTarget[] = []

  render(canvas: HTMLCanvasElement, config: ChartConfig, opts: RenderOptions = {}): void {
    const scale = opts.scale ?? 1
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.save()
    ctx.scale(scale, scale)

    this.hitTargets = []

    const w = canvas.width / scale
    const h = canvas.height / scale

    if (config.layout === 'semicircle') {
      this.renderSemicircle(ctx, config, w, h)
    } else {
      this.renderStraight(ctx, config, w, h)
    }

    this.drawRowSummary(ctx, config, w, h)

    ctx.restore()
  }

  hitTest(x: number, y: number): HitTarget | null {
    for (const target of this.hitTargets) {
      const dx = x - target.x
      const dy = y - target.y
      if (dx * dx + dy * dy <= target.radius * target.radius) return target
    }
    return null
  }

  // ---------------------------------------------------------------------------
  // Vertical centering helper
  // ---------------------------------------------------------------------------

  // Compute the conductor origin (oy) so the chart is vertically centred.
  // chartHeight = distance from conductor to topmost chair row.
  private computeOy(h: number, numRows: number, flipped: boolean): number {
    const chartHeight = BASE_RADIUS + Math.max(0, numRows - 1) * ROW_SPACING + CHAIR_HALF
    const padding = 16
    if (flipped) {
      // conductor at top; chart extends downward
      return Math.max(padding + CONDUCTOR_EXTENT, (h - chartHeight + CONDUCTOR_EXTENT) / 2)
    } else {
      // conductor at bottom; chart extends upward
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

    this.drawConductor(ctx, ox, oy, yDir, config)

    let seatNumber = 1
    config.rows.forEach((row, rowIndex) => {
      const r = BASE_RADIUS + rowIndex * ROW_SPACING
      // Straight rows count from the back (highest index)
      const isStraight = rowIndex >= numRows - config.straightRows
      if (isStraight) {
        seatNumber = this.renderStraightRowInArc(ctx, row, rowIndex, r, ox, oy, yDir, config, seatNumber)
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
    const enabledChairs = row.chairs.filter(c => c.enabled)
    const total = enabledChairs.length
    if (total === 0) return seatNumber

    const startAngle = Math.PI
    const endAngle = 0
    const angleStep = total > 1 ? (startAngle - endAngle) / (total - 1) : 0

    let enabledIdx = 0
    row.chairs.forEach((chair, chairIndex) => {
      if (!chair.enabled) return

      const angle = startAngle - enabledIdx * angleStep
      const cx = ox + r * Math.cos(angle)
      const cy = oy + yDir * r * Math.sin(angle)

      this.drawChair(ctx, chair, cx, cy, ox, oy, row.fontSize)
      if (chair.hasStand) this.drawStand(ctx, cx, cy, ox, oy)

      if (config.showNumbers) {
        const num = config.numberRestartPerRow ? enabledIdx + 1 : seatNumber
        this.drawSeatNumber(ctx, cx, cy, ox, oy, String(num), row.fontSize)
      }

      this.hitTargets.push({ rowIndex, chairIndex, x: cx, y: cy, radius: CHAIR_HALF * 1.1 })
      enabledIdx++
      seatNumber++
    })

    if (config.showRowLabels) {
      // Fixed x aligned with the outermost row's left edge — gives a straight column
      const outerR = BASE_RADIUS + (config.rows.length - 1) * ROW_SPACING
      const lx = ox - outerR - CHAIR_HALF - 10
      // y at the apex of this row's arc
      const ly = oy + yDir * r
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
  ): number {
    const enabledChairs = row.chairs.filter(c => c.enabled)
    const total = enabledChairs.length
    if (total === 0) return seatNumber

    const rowY = oy + yDir * r
    const rowWidth = (total - 1) * STRAIGHT_CHAIR_SPACING
    const startX = ox - rowWidth / 2

    let enabledIdx = 0
    row.chairs.forEach((chair, chairIndex) => {
      if (!chair.enabled) return

      const cx = startX + enabledIdx * STRAIGHT_CHAIR_SPACING

      this.drawChair(ctx, chair, cx, rowY, cx, oy, row.fontSize)
      if (chair.hasStand) this.drawStand(ctx, cx, rowY, cx, oy)

      if (config.showNumbers) {
        const num = config.numberRestartPerRow ? enabledIdx + 1 : seatNumber
        this.drawSeatNumber(ctx, cx, rowY, cx, oy, String(num), row.fontSize)
      }

      this.hitTargets.push({ rowIndex, chairIndex, x: cx, y: rowY, radius: CHAIR_HALF * 1.1 })
      enabledIdx++
      seatNumber++
    })

    if (config.showRowLabels) {
      const outerR = BASE_RADIUS + (config.rows.length - 1) * ROW_SPACING
      const lx = ox - outerR - CHAIR_HALF - 10
      this.drawRowLabel(ctx, row.label, lx, rowY)
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

    this.drawConductor(ctx, ox, oy, yDir, config)

    let seatNumber = 1

    config.rows.forEach((row, rowIndex) => {
      const enabledChairs = row.chairs.filter(c => c.enabled)
      const total = enabledChairs.length
      if (total === 0) return

      const rowY = oy + yDir * (BASE_RADIUS + rowIndex * ROW_SPACING)
      const rowWidth = (total - 1) * STRAIGHT_CHAIR_SPACING
      const startX = ox - rowWidth / 2

      let enabledIdx = 0
      row.chairs.forEach((chair, chairIndex) => {
        if (!chair.enabled) return

        const cx = startX + enabledIdx * STRAIGHT_CHAIR_SPACING

        this.drawChair(ctx, chair, cx, rowY, cx, oy, row.fontSize)
        if (chair.hasStand) this.drawStand(ctx, cx, rowY, cx, oy)

        if (config.showNumbers) {
          const num = config.numberRestartPerRow ? enabledIdx + 1 : seatNumber
          this.drawSeatNumber(ctx, cx, rowY, cx, oy, String(num), row.fontSize)
        }

        this.hitTargets.push({ rowIndex, chairIndex, x: cx, y: rowY, radius: CHAIR_HALF * 1.1 })
        enabledIdx++
        seatNumber++
      })

      if (config.showRowLabels) this.drawRowLabel(ctx, row.label, startX - CHAIR_HALF - 10, rowY)
    })
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

    // Back rail on the edge away from conductor
    ctx.beginPath()
    ctx.moveTo(-CHAIR_HALF, CHAIR_HALF)
    ctx.lineTo(CHAIR_HALF, CHAIR_HALF)
    ctx.strokeStyle = '#333'
    ctx.lineWidth = 4
    ctx.stroke()

    ctx.restore()

    // Label drawn upright regardless of chair rotation
    if (chair.label) {
      ctx.save()
      ctx.fillStyle = '#222'
      ctx.font = `bold ${Math.max(8, fontSize - 2)}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(chair.label, cx, cy, CHAIR_SIZE - 4)
      ctx.restore()
    }
  }

  private drawStand(
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

    const dist = CHAIR_HALF + STAND_GAP + STAND_H / 2
    const sx = cx + nx * dist
    const sy = cy + ny * dist
    const angle = Math.atan2(ny, nx)

    ctx.save()
    ctx.translate(sx, sy)
    ctx.rotate(angle + Math.PI / 2)
    ctx.fillStyle = '#aaa'
    ctx.fillRect(-STAND_W / 2, -STAND_H / 2, STAND_W, STAND_H)
    ctx.strokeStyle = '#777'
    ctx.lineWidth = 1
    ctx.strokeRect(-STAND_W / 2, -STAND_H / 2, STAND_W, STAND_H)
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
    ctx.textAlign = 'center'
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
    const pw = 52, ph = 36
    ctx.save()
    ctx.fillStyle = '#555'
    ctx.fillRect(ox - pw / 2, oy - ph / 2, pw, ph)
    ctx.strokeStyle = '#333'
    ctx.lineWidth = 2
    ctx.strokeRect(ox - pw / 2, oy - ph / 2, pw, ph)
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 11px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('COND', ox, oy)
    ctx.restore()

    if (config.conductor.hasStand) {
      const sw = 32, sh = 16
      const sy = oy + yDir * (ph / 2 + 4)
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
