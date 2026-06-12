import type { FixedInstrument } from './types'

/**
 * Each glyph is drawn centred at (0, 0) in the canvas's current (already
 * translated and possibly rotated) frame, and returns its half-width /
 * half-height for the renderer's hit-box plus a `labelInside` flag:
 *
 *   - labelInside: true  → renderer draws the white instrument label
 *                          centred on top of the glyph
 *   - labelInside: false → renderer drops the label below the glyph's
 *                          rotated bounding box
 *
 * All glyphs are monochrome (black silhouettes with optional white inner
 * detail) so the chart stays a clean black-and-white diagram; chair
 * colours remain the only user-controlled hue.
 */
export interface GlyphResult {
  hw: number
  hh: number
  labelInside: boolean
}

// ---------------------------------------------------------------------------
// Drum kit — bass drum (large circle), two angled tom tops above it, and
// short vertical hardware bars connecting them.
// ---------------------------------------------------------------------------
export function drawDrumkit(ctx: CanvasRenderingContext2D): GlyphResult {
  const bassR = 19

  ctx.fillStyle = '#1a1a1a'
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 1

  // Hardware first so the drums sit on top of it
  ctx.fillRect(-13, -14, 4, 22)
  ctx.fillRect(9, -14, 4, 22)

  // Bass drum
  ctx.beginPath()
  ctx.arc(0, 7, bassR, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()

  // Two angled tom tops (smaller filled ellipses, tilted toward the centre)
  const drawTom = (tx: number, ty: number, tilt: number) => {
    ctx.save()
    ctx.translate(tx, ty)
    ctx.rotate(tilt)
    ctx.beginPath()
    ctx.ellipse(0, 0, 10, 6, 0, 0, Math.PI * 2)
    ctx.fillStyle = '#1a1a1a'
    ctx.fill()
    ctx.strokeStyle = '#fff'
    ctx.stroke()
    ctx.restore()
  }
  drawTom(-12, -13, -0.28)
  drawTom(12, -13, 0.28)

  return { hw: 22, hh: bassR + 7, labelInside: false }
}

// ---------------------------------------------------------------------------
// Grand piano — top-down silhouette: keyboard along the bottom, a wide rounded
// bass dome over the top, and the curved bentside down the right with a concave
// waist pinching in before a small lobe near the keyboard.
// ---------------------------------------------------------------------------
export function drawPiano(ctx: CanvasRenderingContext2D): GlyphResult {
  // Top-down grand piano. Keyboard runs along the bottom; the body above it is
  // the classic grand outline: a straight "spine" down the left, a wide rounded
  // bass dome across the top, and the curved "bentside" down the right that
  // pinches inward (concave waist) before swelling back out to a small lobe
  // near the keyboard.
  const hw = 38
  const hh = 44

  ctx.fillStyle = '#1a1a1a'
  ctx.beginPath()
  // Bottom-left corner of the keyboard.
  ctx.moveTo(-hw, hh)
  // Straight spine up the left edge.
  ctx.lineTo(-hw, -hh * 0.5)
  // Bass dome: sweep up and over the top, left → apex (slightly left of centre)
  // → out to the dome's widest point on the right.
  ctx.bezierCurveTo(-hw, -hh,  -hw * 0.4, -hh,  hw * 0.05, -hh)
  ctx.bezierCurveTo(hw * 0.68, -hh,  hw, -hh * 0.66,  hw, -hh * 0.28)
  // Bentside concave waist: ease inward toward the centre (control points sit
  // well left of the dome's right extent so the edge caves in).
  ctx.bezierCurveTo(hw, -hh * 0.02,  hw * 0.56, -hh * 0.04,  hw * 0.56, hh * 0.16)
  // Lower lobe: swell gently back out, then drop to the keyboard's right end.
  ctx.bezierCurveTo(hw * 0.56, hh * 0.4,  hw * 0.86, hh * 0.38,  hw * 0.74, hh)
  // closePath draws the straight keyboard-front edge back to the start.
  ctx.closePath()
  ctx.fill()

  // Keyboard: a white keybed inset inside a thin black frame, with black key
  // separations stopping short of the front so a solid white lip remains.
  const kbTop = hh * 0.58
  const kbBot = hh - 5
  const kbLeft = -hw + 5
  const kbRight = hw * 0.52
  ctx.fillStyle = '#fff'
  ctx.fillRect(kbLeft, kbTop, kbRight - kbLeft, kbBot - kbTop)
  ctx.strokeStyle = '#1a1a1a'
  ctx.lineWidth = 1.3
  const keys = 12
  for (let i = 1; i < keys; i++) {
    const x = kbLeft + (i / keys) * (kbRight - kbLeft)
    ctx.beginPath()
    ctx.moveTo(x, kbTop)
    ctx.lineTo(x, kbBot - 4)
    ctx.stroke()
  }

  return { hw, hh, labelInside: true }
}

// ---------------------------------------------------------------------------
// Amp cabinet — black box with a white control strip and a row of knobs.
// Used for both guitar amp (32×34) and bass amp (40×42).
// ---------------------------------------------------------------------------
export function drawAmp(ctx: CanvasRenderingContext2D, w: number, h: number): GlyphResult {
  const hw = w / 2, hh = h / 2

  ctx.fillStyle = '#1a1a1a'
  roundRect(ctx, -hw, -hh, w, h, 2)
  ctx.fill()

  // Control panel strip near the top
  const stripPad = 3
  const stripH = 5
  const stripY = -hh + stripPad
  ctx.fillStyle = '#fff'
  ctx.fillRect(-hw + stripPad, stripY, w - stripPad * 2, stripH)

  // Tiny black knobs along the strip
  ctx.fillStyle = '#1a1a1a'
  const knobs = 4
  const knobY = stripY + stripH / 2
  const usableW = w - stripPad * 2 - 4
  for (let i = 0; i < knobs; i++) {
    const t = (i + 0.5) / knobs
    const knobX = -hw + stripPad + 2 + t * usableW
    ctx.beginPath()
    ctx.arc(knobX, knobY, 1, 0, Math.PI * 2)
    ctx.fill()
  }

  return { hw, hh, labelInside: false }
}

// ---------------------------------------------------------------------------
// Timpani cluster — N drums (2–6) arranged on an upward-curving arc, as if
// the player stands above. Uses a fixed total arc angle (108°) so the
// curvature stays visible at any count; the radius scales with N.
// ---------------------------------------------------------------------------
export function drawTimpani(ctx: CanvasRenderingContext2D, inst: FixedInstrument): GlyphResult {
  const count = Math.max(2, Math.min(6, inst.count ?? 4))
  const drumR = 18
  const chord = drumR * 2 + 1                      // touching with a 1px hair of gap
  const totalAngle = (3 * Math.PI) / 5             // 108°
  const angleStep = count > 1 ? totalAngle / (count - 1) : 0
  const arcR = count > 1 ? chord / (2 * Math.sin(angleStep / 2)) : drumR
  const startAngle = Math.PI / 2 - totalAngle / 2

  // Arc centre at (0, -arcR) — above the drums, so the cluster smiles upward.
  const positions: Array<{ x: number; y: number }> = []
  for (let i = 0; i < count; i++) {
    const a = startAngle + i * angleStep
    positions.push({
      x: arcR * Math.cos(a),
      y: -arcR + arcR * Math.sin(a),
    })
  }

  // Re-centre vertically so the cluster sits around y=0
  const minY = Math.min(...positions.map(p => p.y))
  const maxY = Math.max(...positions.map(p => p.y))
  const offsetY = -(minY + maxY) / 2
  positions.forEach(p => { p.y += offsetY })

  ctx.fillStyle = '#1a1a1a'
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 1
  positions.forEach(p => {
    ctx.beginPath()
    ctx.arc(p.x, p.y, drumR, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    // Inner head ring (thin white) — gives the drum some depth detail
    ctx.beginPath()
    ctx.arc(p.x, p.y, drumR - 4, 0, Math.PI * 2)
    ctx.stroke()
  })

  const minX = Math.min(...positions.map(p => p.x))
  const maxX = Math.max(...positions.map(p => p.x))
  const hw = Math.max(-(minX - drumR), maxX + drumR)
  const hh = (maxY - minY) / 2 + drumR

  return { hw, hh, labelInside: false }
}

// ---------------------------------------------------------------------------
// Mallet instrument (glock/xylo/vibes/marimba) — shorter trapezoid with the
// wider low end on the LEFT and the narrower high end on the RIGHT, plus
// thin white separators suggesting the bars/keys.
// ---------------------------------------------------------------------------
export function drawMallet(ctx: CanvasRenderingContext2D): GlyphResult {
  // Wider (taller) end = the low notes. Default orientation puts the low end
  // on the RIGHT, matching how a marimba/xylophone faces the player.
  const w = 90, leftH = 24, rightH = 36
  const hw = w / 2

  ctx.fillStyle = '#1a1a1a'
  ctx.beginPath()
  ctx.moveTo(-hw, -leftH / 2)
  ctx.lineTo(hw, -rightH / 2)
  ctx.lineTo(hw, rightH / 2)
  ctx.lineTo(-hw, leftH / 2)
  ctx.closePath()
  ctx.fill()

  // Thin white bar separators to suggest keys
  ctx.strokeStyle = '#fff'
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

  return { hw, hh: Math.max(leftH, rightH) / 2, labelInside: false }
}

// ---------------------------------------------------------------------------
// Harp — stylised side-on profile. Pillar on the left, arched neck across
// the top, diagonal soundboard sloping down to the bottom-left. Vertical
// white string lines fill the body cavity.
// ---------------------------------------------------------------------------
export function drawHarp(ctx: CanvasRenderingContext2D): GlyphResult {
  const hw = 22, hh = 28

  ctx.fillStyle = '#1a1a1a'
  ctx.beginPath()
  // Pillar on the left, going up
  ctx.moveTo(-hw, hh)
  ctx.lineTo(-hw, -hh + 6)
  // Neck arching across the top to the right
  ctx.quadraticCurveTo(-hw, -hh, -hw + 10, -hh)
  ctx.lineTo(hw, -hh + 6)
  // Soundboard sloping down-left toward the base
  ctx.lineTo(-hw + 6, hh)
  ctx.closePath()
  ctx.fill()

  // Strings — vertical white lines from neck down to the soundboard.
  // Strings on the left are LONGEST (bass end), right are shortest
  // (treble), all roughly parallel — the actual physics of a harp.
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 0.7
  const n = 7
  const xStart = -hw + 6     // leftmost string sits just inside the pillar
  const xEnd = hw - 4        // rightmost string sits just inside the neck
  const yTop = -hh + 8       // string anchor on the neck (just below the curve)
  // Soundboard line: from (xEnd, -hh + 6) at the top-right corner down
  // to (-hw + 6, hh) at the bottom-left corner. y as a function of x:
  //   slope = (hh - (-hh + 6)) / ((-hw + 6) - xEnd) = (2hh - 6) / (-2hw + 10)
  //   y = (-hh + 6) + slope * (x - xEnd)
  const slope = (hh - (-hh + 6)) / ((-hw + 6) - xEnd)
  for (let i = 0; i < n; i++) {
    const x = xStart + (i / (n - 1)) * (xEnd - xStart)
    const yBot = (-hh + 6) + slope * (x - xEnd) - 1   // -1 to sit just above the soundboard line
    ctx.beginPath()
    ctx.moveTo(x, yTop)
    ctx.lineTo(x, yBot)
    ctx.stroke()
  }

  return { hw, hh, labelInside: false }
}

// ---------------------------------------------------------------------------
// Microphone — a basic vocal-mic silhouette: a slim handle topped by a
// slightly wider, rounded grille head (the bulge), rather than a fat
// podcast-style ball. On a stand it gets a thin pole down to a flat round
// base; handheld it's just the mic body. Wired mics trail a short cable;
// wireless mics show small radio-wave arcs above the head instead.
// ---------------------------------------------------------------------------
export function drawMicrophone(ctx: CanvasRenderingContext2D, inst: FixedInstrument): GlyphResult {
  const onStand = inst.micStand !== false   // default: on a stand
  const wireless = inst.wireless === true    // default: wired

  ctx.lineCap = 'round'

  // Vocal-mic proportions: a long handle with a marginally fatter head.
  const headCy = -13
  const headRx = 6, headRy = 7.5    // the slight bulge
  const handleHw = 4.5
  const handleBot = 12

  // Stand (pole + flat round base) or nothing — drawn first so the mic
  // body sits on top of it.
  let bottomY: number
  if (onStand) {
    ctx.fillStyle = '#1a1a1a'
    ctx.fillRect(-1.5, handleBot - 2, 3, 12)          // pole
    ctx.beginPath()
    ctx.ellipse(0, 22, 11, 3.5, 0, 0, Math.PI * 2)    // base
    ctx.fill()
    bottomY = 25.5
  } else {
    bottomY = handleBot
  }

  // Wired cable trailing from the bottom (handle end, or off the base).
  if (!wireless) {
    ctx.strokeStyle = '#1a1a1a'
    ctx.lineWidth = 2
    const sy = onStand ? 24 : handleBot
    ctx.beginPath()
    ctx.moveTo(0, sy)
    ctx.bezierCurveTo(6, sy + 5, -6, sy + 9, 4, sy + 13)
    ctx.stroke()
    bottomY = Math.max(bottomY, sy + 13)
  }

  // Mic body — long handle plus the slightly wider rounded head.
  ctx.fillStyle = '#1a1a1a'
  roundRect(ctx, -handleHw, headCy, handleHw * 2, handleBot - headCy, handleHw)
  ctx.fill()
  ctx.beginPath()
  ctx.ellipse(0, headCy, headRx, headRy, 0, 0, Math.PI * 2)
  ctx.fill()

  // Grille lines across the head.
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 0.8
  for (let y = headCy - 4; y <= headCy + 3; y += 2.5) {
    const t = (y - headCy) / headRy
    const dx = headRx * Math.sqrt(Math.max(0, 1 - t * t)) - 1
    if (dx <= 0) continue
    ctx.beginPath()
    ctx.moveTo(-dx, y)
    ctx.lineTo(dx, y)
    ctx.stroke()
  }

  // Wireless radio-wave arcs above the head.
  let topY = headCy - headRy
  if (wireless) {
    ctx.strokeStyle = '#1a1a1a'
    ctx.lineWidth = 1.4
    const ay = headCy - headRy - 1
    for (let k = 1; k <= 2; k++) {
      ctx.beginPath()
      ctx.arc(0, ay, k * 3.5, Math.PI * 1.18, Math.PI * 1.82)
      ctx.stroke()
    }
    topY = ay - 9
  }

  const hh = Math.max(Math.abs(topY), bottomY)
  return { hw: onStand ? 11 : 8, hh, labelInside: false }
}

// ---------------------------------------------------------------------------
// Gong on a square stand — a top-ish view kept deliberately wide and short so
// it doesn't eat vertical space on the chart. A square stand frame holds a
// large disc (flattened a touch) with a white rim ring and a central boss,
// the two details that read as "gong" rather than "cymbal" or "drum".
// ---------------------------------------------------------------------------
export function drawGong(ctx: CanvasRenderingContext2D): GlyphResult {
  const fw = 42, fh = 32          // square-ish stand frame, slightly squashed
  const hw = fw / 2, hh = fh / 2

  // Square stand frame (outline) — the legs/base footprint.
  ctx.strokeStyle = '#1a1a1a'
  ctx.lineWidth = 2.5
  ctx.lineJoin = 'round'
  ctx.strokeRect(-hw, -hh, fw, fh)

  // Gong disc, flattened so the whole glyph stays short.
  const dRx = hw - 6, dRy = hh - 4
  ctx.fillStyle = '#1a1a1a'
  ctx.beginPath()
  ctx.ellipse(0, 0, dRx, dRy, 0, 0, Math.PI * 2)
  ctx.fill()

  // White rim ring + central boss — the gong tells.
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.ellipse(0, 0, dRx - 3, dRy - 3, 0, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.ellipse(0, 0, 4, 3, 0, 0, Math.PI * 2)
  ctx.stroke()

  return { hw, hh, labelInside: false }
}

// ---------------------------------------------------------------------------
// Single chair — same look as in-row chairs (grey square with a darker
// back rail). Used as a backup for stragglers who don't fit a row
// (extra player, off-row chair, etc.). At rotation 0 the back rail is
// at the top of the local frame, matching the back-away-from-conductor
// convention of in-row chairs in the unflipped layout.
// ---------------------------------------------------------------------------
export function drawSingleChair(ctx: CanvasRenderingContext2D): GlyphResult {
  const size = 30
  const hw = size / 2
  ctx.fillStyle = '#e8e8e8'
  ctx.fillRect(-hw, -hw, size, size)
  ctx.strokeStyle = '#555'
  ctx.lineWidth = 1.5
  ctx.strokeRect(-hw, -hw, size, size)
  // Back rail along the top edge
  ctx.beginPath()
  ctx.moveTo(-hw, -hw)
  ctx.lineTo(hw, -hw)
  ctx.strokeStyle = '#333'
  ctx.lineWidth = 4
  ctx.stroke()
  return { hw, hh: hw, labelInside: false }
}

// ---------------------------------------------------------------------------
// Single stand — just the × symbol, sized to match the row stands. Hit
// box is slightly larger than the visual × so the user can grab it
// without having to click pixel-perfectly on a line.
// ---------------------------------------------------------------------------
export function drawSingleStand(ctx: CanvasRenderingContext2D): GlyphResult {
  const armLen = 8
  ctx.strokeStyle = '#555'
  ctx.lineWidth = 2.5
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(-armLen, -armLen); ctx.lineTo(armLen, armLen)
  ctx.moveTo(armLen, -armLen); ctx.lineTo(-armLen, armLen)
  ctx.stroke()
  return { hw: 12, hh: 12, labelInside: false }
}

// ---------------------------------------------------------------------------
// Double bass stool — round seat with four small legs poking out at the
// diagonals. Rotationally symmetric, so flipping the chart leaves it
// unchanged. Used by bassists (and anyone else playing tall instruments
// who prefers perching to sitting).
// ---------------------------------------------------------------------------
export function drawStool(ctx: CanvasRenderingContext2D): GlyphResult {
  const r = 13                  // seat radius
  const legLen = 5              // how far each leg sticks past the seat
  const legW = 3                // leg thickness

  // Legs first so the seat sits on top of them
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

  // Round seat
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.fillStyle = '#e8e8e8'
  ctx.fill()
  ctx.strokeStyle = '#555'
  ctx.lineWidth = 1.5
  ctx.stroke()

  const halfBound = r + legLen
  return { hw: halfBound, hh: halfBound, labelInside: false }
}

// ---------------------------------------------------------------------------
// Generic square / rectangle — slightly lighter grey fill, used as a
// labelled placeholder for anything the chart doesn't have a dedicated
// glyph for (sound desk, monitor, riser, etc.).
// ---------------------------------------------------------------------------
export function drawGenericRect(ctx: CanvasRenderingContext2D, hw: number, hh: number): GlyphResult {
  ctx.fillStyle = '#3a3a3a'
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.rect(-hw, -hh, hw * 2, hh * 2)
  ctx.fill()
  ctx.stroke()
  return { hw, hh, labelInside: false }
}

// ---------------------------------------------------------------------------
// Local helper — Path2D-style rounded-rectangle path. Caller is responsible
// for the fill/stroke after this builds the path.
// ---------------------------------------------------------------------------
function roundRect(
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
