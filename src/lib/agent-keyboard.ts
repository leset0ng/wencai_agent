/** Keep the Agent panel anchored while the mobile visual viewport loses keyboard space. */
export function trackAgentKeyboard(shell: HTMLElement): () => void {
  const viewport = window.visualViewport
  if (!viewport) return () => {}
  const mobile = window.matchMedia('(max-width: 519px), (pointer: coarse)')
  let frame = 0
  let keyboard = false
  let width = window.innerWidth
  let bounds = shell.getBoundingClientRect()
  const properties = ['--agent-shell-height', '--agent-shell-width', '--agent-shell-left', '--agent-shell-top', '--agent-keyboard-inset']
  const reset = () => {
    shell.classList.remove('bank-agent-viewport', 'bank-agent-keyboard')
    properties.forEach((name) => shell.style.removeProperty(name))
  }
  const measure = () => {
    frame = 0
    if (!mobile.matches || Math.abs(viewport.scale - 1) > .05) {
      reset()
      keyboard = false
      return
    }
    // A width change is an orientation/window change, not a keyboard opening.
    if (Math.abs(window.innerWidth - width) > 1) {
      reset()
      bounds = shell.getBoundingClientRect()
      width = window.innerWidth
      keyboard = false
    }
    const typing = document.activeElement?.matches('.bank-chat-composer input') ?? false
    const covered = Math.max(0, bounds.bottom - viewport.height)
    keyboard = (typing || keyboard) && covered > 120
    if (!keyboard) {
      // Let normal responsive CSS follow browser chrome, rotation and window resizing.
      reset()
      bounds = shell.getBoundingClientRect()
    }
    shell.style.setProperty('--agent-shell-height', `${bounds.height}px`)
    shell.style.setProperty('--agent-shell-width', `${bounds.width}px`)
    shell.style.setProperty('--agent-shell-left', `${bounds.left}px`)
    // iOS may pan the visual viewport to the focused input; compensate without scrolling the page.
    shell.style.setProperty('--agent-shell-top', `${bounds.top + (keyboard ? viewport.offsetTop : 0)}px`)
    shell.style.setProperty('--agent-keyboard-inset', `${keyboard ? covered : 0}px`)
    shell.classList.add('bank-agent-viewport')
    shell.classList.toggle('bank-agent-keyboard', keyboard)
  }
  const schedule = () => { if (!frame) frame = window.requestAnimationFrame(measure) }
  measure()
  viewport.addEventListener('resize', schedule)
  viewport.addEventListener('scroll', schedule)
  window.addEventListener('resize', schedule)
  mobile.addEventListener('change', schedule)
  shell.addEventListener('focusin', schedule)
  shell.addEventListener('focusout', schedule)
  return () => {
    window.cancelAnimationFrame(frame)
    viewport.removeEventListener('resize', schedule)
    viewport.removeEventListener('scroll', schedule)
    window.removeEventListener('resize', schedule)
    mobile.removeEventListener('change', schedule)
    shell.removeEventListener('focusin', schedule)
    shell.removeEventListener('focusout', schedule)
    reset()
  }
}
