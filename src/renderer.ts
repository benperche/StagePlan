import type { ChartConfig, Row, Chair, HitTarget } from './types'

const CHAIR_SIZE = 30
const CHAIR_HALF = CHAIR_SIZE / 2
const STAND_W = 16
const STAND_H = 10
const STAND_GAP = 6
const ROW_SPACING = 52
const BASE_RADIUS = 130
const STRAIGHT_CHAIR_SPACING = 40

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
  // Semicircle layout
  // ---------------------------------------------------------------------------

  private renderSemicircle(ctx: CanvasRenderingContext2D, config: ChartConfig, w: number, h: number) {
    const ox = w / 2
    // flipped = conductor at top (musicians' view); normal = conductor at bottom
    const oy = config.flipped ? 40 : h - 40
    // yDir: direction from conductor toward musicians
    //   normal:  -1 (musicians above, lower y)
    //   flipped: +1 (musicians below, higher y)
    const yDir = config.flipped ? 1 : -1

    this.drawConductor(ctx, ox, oy, yDir, config)

    let seatNumber = 1
    config.rows.forEach((row, rowIndex) => {
      const r = BASE_RADIUS + rowIndex * ROW_SPACING
      if (row.straight) {
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

    // Arc spans 180° — left (π) to right (0), chairs curve away from conductor
    const startAngle = Math.PI
    const endAngle = 0
    const angleStep = total > 1 ? (startAngle - endAngle) / (total - 1) : 0

    let enabledIdx = 0
    row.chairs.forEach((chair, chairIndex) => {
      if (!chair.enabled) return

      const angle = startAngle - enabledIdx * angleStep
      const cx = ox + r * Math.cos(angle)
      // yDir controls whether arc opens toward top or bottom
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

    // Row label outside the left end of the arc
    if (config.showRowLabels) {
      const labelAngle = startAngle + 0.18
      const lx = ox + (r + CHAIR_HALF + 6) * Math.cos(labelAngle)
      const ly = oy + yDir * (r + CHAIR_HALF + 6) * Math.sin(labelAngle)
      this.drawRowLabel(ctx, row.label, lx, ly)
    }

    return seatNumber
  }

  // Straight row within a semicircle — positioned at the same depth as its arc
  // equivalent. Chairs face straight toward the conductor (no horizontal tilt).
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

      // Pass cx as the "conductor x" so the facing direction is purely vertical
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
    return seatNumber
  }

  // ---------------------------------------------------------------------------
  // Pure straight layout
  // ---------------------------------------------------------------------------

  private renderStraight(ctx: CanvasRenderingContext2D, config: ChartConfig, w: number, h: number) {
    const ox = w / 2
    const oy = config.flipped ? 40 : h - 40
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

        // cx as conductor x → purely vertical facing (faces forward, not angled)
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

    // Back rail — thick line on the edge away from conductor
    ctx.beginPath()
    ctx.moveTo(-CHAIR_HALF, -CHAIR_HALF)
    ctx.lineTo(CHAIR_HALF, -CHAIR_HALF)
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

  // yDir: -1 = conductor at bottom (normal), +1 = conductor at top (flipped)
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
