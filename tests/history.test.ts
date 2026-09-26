import { describe, expect, it } from 'vitest'
import { History, makeDefaultConfig } from '../src/state'

describe('History', () => {
  it('undo / redo round-trips a change', () => {
    const h = new History()
    const before = makeDefaultConfig()
    h.push(before)
    const after = { ...makeDefaultConfig(), title: 'After' }
    const undone = h.undo(after)!
    expect(undone.title).toBe(before.title)
    expect(h.canRedo()).toBe(true)
    expect(h.redo(undone)!.title).toBe('After')
  })

  it('discardLast drops the newest entry without making it redoable', () => {
    // A cancelled gesture (Escape mid-drag, palette drop off the chart)
    // pushed history and then restored its snapshot itself.
    const h = new History()
    h.push({ ...makeDefaultConfig(), title: 'Earlier edit' })
    h.push(makeDefaultConfig())   // the cancelled drag's entry
    h.discardLast()
    expect(h.canRedo()).toBe(false)
    expect(h.undo(makeDefaultConfig())!.title).toBe('Earlier edit')
    expect(h.canUndo()).toBe(false)
  })
})
