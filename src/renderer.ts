import type { ChartConfig, Row, Chair, HitTarget, ConductorHit } from './types'

const CHAIR_SIZE = 30
const CHAIR_HALF = CHAIR_SIZE / 2
const STAND_GAP = 6
const STAND_SIZE = 7   // half-arm of the X
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
  conductorHit: ConductorHit | null = null

  render(canvas: HTMLCanvasElement, config: ChartConfig, opts: RenderOptions = {}): void {
    const scale = opts.scale ?? 1
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.save()
    ctx.scale(scale, scale)

    this.hitTargets = []
    this.conductorHit = null

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

    let seatNumber = 1
    config.rows.forEach((row, rowIndex) => {
      const r = BASE_RADIUS + rowIndex * ROW_SPACING
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
      // Label near the leftmost chair (angle = π → x = ox - r, y = oy)
      // placed just outside the arc on the conductor side
      const lx = ox - r - CHAIR_HALF - 6
      const ly = oy
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
      this.drawRowLabel(ctx, row.label, startX - CHAIR_HALF - 8, rowY)
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

      if (config.showRowLabels) this.drawRowLabel(ctx, row.label, startX - CHAIR_HALF - 8, rowY)
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

    // Place the × between the chair(s) and the conductor
    const dist = CHAIR_HALF + STAND_GAP + STAND_SIZE
    const sx = cx + nx * dist
    const sy = cy + ny * dist

    // Rotate the × so its arms align along/across the chair-conductor axis
    const angle = Math.atan2(ny, nx)

    ctx.save()
    ctx.translate(sx, sy)
    ctx.rotate(angle + Math.PI / 4)   // 45° gives a symmetric ×
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
    const rx = ox - COND_W / 2
    const ry = oy - COND_H / 2

    // Always store hit rect so clicking works whether shown or not
    this.conductorHit = { x: rx, y: ry, w: COND_W, h: COND_H }

    if (!config.conductor.show) {
      // Draw a faint ghost so conductor is still clickable / discoverable
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
