// A small floating context menu, opened by right-click (desktop) or long-press
// (touch) on a chair or stand. Purely presentational: callers pass a list of
// items and their actions; this handles layout, viewport clamping, and
// dismissal (outside click / Escape / scroll / resize). One menu at a time.

export interface MenuActionItem {
  kind: 'action'
  label: string
  onClick: () => void
  danger?: boolean
}
export interface MenuSeparatorItem { kind: 'separator' }
export interface MenuSegmentItem {
  kind: 'segment'
  label: string
  options: { label: string; active?: boolean; onClick: () => void }[]
}
export interface MenuSwatchItem {
  kind: 'swatches'
  label: string
  colors: string[]
  current?: string
  onPick: (color: string) => void
  onCustom: () => void
}
export type MenuItem = MenuActionItem | MenuSeparatorItem | MenuSegmentItem | MenuSwatchItem

let current: HTMLElement | null = null
let onCleanup: (() => void) | null = null

export function closeContextMenu(): void {
  if (!current) return
  current.remove()
  current = null
  if (onCleanup) { onCleanup(); onCleanup = null }
}

export function contextMenuOpen(): boolean {
  return current !== null
}

export function showContextMenu(clientX: number, clientY: number, title: string, items: MenuItem[]): void {
  closeContextMenu()

  const menu = document.createElement('div')
  menu.className = 'context-menu'

  const heading = document.createElement('div')
  heading.className = 'context-menu-title'
  heading.textContent = title
  menu.appendChild(heading)

  // Run an item's action then dismiss the menu.
  const run = (fn: () => void) => { closeContextMenu(); fn() }

  for (const item of items) {
    if (item.kind === 'separator') {
      const sep = document.createElement('div')
      sep.className = 'context-menu-sep'
      menu.appendChild(sep)
    } else if (item.kind === 'action') {
      const b = document.createElement('button')
      b.className = 'context-menu-item' + (item.danger ? ' danger' : '')
      b.textContent = item.label
      b.addEventListener('click', () => run(item.onClick))
      menu.appendChild(b)
    } else if (item.kind === 'segment') {
      const row = document.createElement('div')
      row.className = 'context-menu-seg-row'
      const lab = document.createElement('span')
      lab.className = 'context-menu-seg-label'
      lab.textContent = item.label
      row.appendChild(lab)
      const seg = document.createElement('div')
      seg.className = 'context-menu-seg'
      for (const opt of item.options) {
        const b = document.createElement('button')
        b.textContent = opt.label
        if (opt.active) b.classList.add('active')
        b.addEventListener('click', () => run(opt.onClick))
        seg.appendChild(b)
      }
      row.appendChild(seg)
      menu.appendChild(row)
    } else {
      const row = document.createElement('div')
      row.className = 'context-menu-seg-row'
      const lab = document.createElement('span')
      lab.className = 'context-menu-seg-label'
      lab.textContent = item.label
      row.appendChild(lab)
      const sw = document.createElement('div')
      sw.className = 'context-menu-swatches'
      for (const c of item.colors) {
        const b = document.createElement('button')
        b.className = 'context-menu-swatch' + (item.current && sameColor(item.current, c) ? ' active' : '')
        b.style.background = c
        b.title = c
        b.addEventListener('click', () => run(() => item.onPick(c)))
        sw.appendChild(b)
      }
      const custom = document.createElement('button')
      custom.className = 'context-menu-swatch context-menu-swatch-custom'
      custom.textContent = '🎨'
      custom.title = 'Custom colour'
      custom.addEventListener('click', () => run(item.onCustom))
      sw.appendChild(custom)
      row.appendChild(sw)
      menu.appendChild(row)
    }
  }

  // Place off-screen first to measure, then clamp into the viewport.
  menu.style.left = '0px'
  menu.style.top = '0px'
  menu.style.visibility = 'hidden'
  document.body.appendChild(menu)
  const { width, height } = menu.getBoundingClientRect()
  const x = Math.min(clientX, window.innerWidth - width - 8)
  const y = Math.min(clientY, window.innerHeight - height - 8)
  menu.style.left = Math.max(8, x) + 'px'
  menu.style.top = Math.max(8, y) + 'px'
  menu.style.visibility = 'visible'
  current = menu

  // Dismiss on any interaction outside the menu.
  const onDown = (e: Event) => { if (!menu.contains(e.target as Node)) closeContextMenu() }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeContextMenu() }
  // Defer so the opening event itself doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', closeContextMenu, true)
    window.addEventListener('resize', closeContextMenu)
  }, 0)
  onCleanup = () => {
    document.removeEventListener('pointerdown', onDown, true)
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('scroll', closeContextMenu, true)
    window.removeEventListener('resize', closeContextMenu)
  }
}

function sameColor(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}
