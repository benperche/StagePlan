// Promise-based in-app dialogs — a drop-in, better-looking replacement for the
// browser's native alert / confirm / prompt (which can't be styled, print
// awkwardly, and look out of place). Each helper builds a `.modal-overlay`
// card on demand (reusing the app's existing modal styling), returns a Promise
// that settles when the user chooses, then removes itself from the DOM.
//
// Keyboard: Enter triggers the primary button, Escape cancels. Clicking the
// backdrop cancels. Focus lands on the input (prompt) or the primary button.

interface DialogButton {
  label: string
  /** Value passed to the resolver when this button is chosen. */
  value: string
  primary?: boolean
  danger?: boolean
}

interface DialogSpec {
  title?: string
  /** Body text. Rendered as plain text (newlines become <br>), never HTML. */
  message: string
  buttons: DialogButton[]
  /** When set, shows a text input; its value is returned alongside the button. */
  input?: { placeholder?: string; value?: string; suggestions?: string[] }
  /** Button value returned on Escape / backdrop click. Defaults to the last button. */
  cancelValue: string
}

function openDialog(spec: DialogSpec): Promise<{ button: string; text: string }> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay dialog-overlay'

    const card = document.createElement('div')
    card.className = 'modal-card dialog-card'
    overlay.appendChild(card)

    if (spec.title) {
      const h = document.createElement('h2')
      h.textContent = spec.title
      card.appendChild(h)
    }

    const p = document.createElement('p')
    p.className = 'dialog-message'
    // Preserve line breaks without ever injecting markup from the message.
    spec.message.split('\n').forEach((line, i) => {
      if (i > 0) p.appendChild(document.createElement('br'))
      p.appendChild(document.createTextNode(line))
    })
    card.appendChild(p)

    let input: HTMLInputElement | null = null
    if (spec.input) {
      input = document.createElement('input')
      input.type = 'text'
      input.className = 'dialog-input'
      input.value = spec.input.value ?? ''
      if (spec.input.placeholder) input.placeholder = spec.input.placeholder
      if (spec.input.suggestions?.length) {
        const listId = 'dialog-datalist-' + Math.random().toString(36).slice(2)
        const dl = document.createElement('datalist')
        dl.id = listId
        for (const s of spec.input.suggestions) {
          const opt = document.createElement('option')
          opt.value = s
          dl.appendChild(opt)
        }
        card.appendChild(dl)
        input.setAttribute('list', listId)
      }
      card.appendChild(input)
    }

    const actions = document.createElement('div')
    actions.className = 'row-controls modal-actions'
    card.appendChild(actions)

    let settled = false
    const finish = (button: string) => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKey, true)
      overlay.remove()
      resolve({ button, text: input?.value.trim() ?? '' })
    }

    const primaryBtn = spec.buttons.find(b => b.primary)
    for (const b of spec.buttons) {
      const btn = document.createElement('button')
      btn.textContent = b.label
      if (b.primary) btn.classList.add('primary')
      if (b.danger) btn.classList.add('danger')
      btn.addEventListener('click', () => finish(b.value))
      actions.appendChild(btn)
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        finish(spec.cancelValue)
      } else if (e.key === 'Enter' && primaryBtn) {
        e.preventDefault()
        finish(primaryBtn.value)
      }
    }
    document.addEventListener('keydown', onKey, true)
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) finish(spec.cancelValue)
    })

    document.body.appendChild(overlay)
    // Focus the input for prompts, else the primary button, so Enter works
    // and keyboard users land somewhere useful.
    requestAnimationFrame(() => {
      if (input) { input.focus(); input.select() }
      else (actions.querySelector('.primary') as HTMLButtonElement | null)?.focus()
    })
  })
}

/** Informational dialog with a single dismiss button. Replaces `alert`. */
export function showAlert(message: string, opts: { title?: string; okLabel?: string } = {}): Promise<void> {
  return openDialog({
    title: opts.title,
    message,
    buttons: [{ label: opts.okLabel ?? 'OK', value: 'ok', primary: true }],
    cancelValue: 'ok',
  }).then(() => undefined)
}

/** Yes/no dialog. Replaces `confirm`. Resolves true when confirmed. */
export function showConfirm(
  message: string,
  opts: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  return openDialog({
    title: opts.title,
    message,
    buttons: [
      { label: opts.cancelLabel ?? 'Cancel', value: 'cancel' },
      { label: opts.confirmLabel ?? 'OK', value: 'ok', primary: true, danger: opts.danger },
    ],
    cancelValue: 'cancel',
  }).then(r => r.button === 'ok')
}

/** Single-line text entry. Replaces `prompt`. Resolves null when cancelled. */
export function showPrompt(
  message: string,
  defaultValue = '',
  opts: { title?: string; placeholder?: string; okLabel?: string; suggestions?: string[] } = {},
): Promise<string | null> {
  return openDialog({
    title: opts.title,
    message,
    input: { value: defaultValue, placeholder: opts.placeholder, suggestions: opts.suggestions },
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: opts.okLabel ?? 'OK', value: 'ok', primary: true },
    ],
    cancelValue: 'cancel',
  }).then(r => (r.button === 'ok' ? r.text : null))
}
