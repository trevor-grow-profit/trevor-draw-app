/**
 * THE PLAYER (YAZ-1820): `excalidraw-app/presentation/PresentationPlayer.tsx` ported — the deck
 * shown full-bleed over the canvas pane, with the web app's camera transitions and its keyboard.
 *
 * 🔒 THE HOSTED-ANIMATION HALF IS NOT PORTED (locked exclusion on YAZ-1775). `PresentationAnimationController`,
 * `animationOrchestrator`, `animationDomAdapter` and the CSP-sandboxed iframe assets are out, and
 * with them the `yaseendraw:presentation-frame` lifecycle event they existed to consume: it had
 * exactly one subscriber and publishing it here would be a beat nothing listens for. What the
 * event's phases DROVE — `isTransitioning`, the transition token that stops a stale landing, and
 * the "an in-flight transition must not land while the deck is zoomed out" rule — is kept, because
 * that is the camera behaving itself, not an animation protocol.
 *
 * ⚡ IT COVERS THE CANVAS PANE, NOT THE WINDOW. The web app owned the whole page, so it portalled
 * to `document.body`, hid the editor chrome with a class on `body`, and measured
 * `window.innerWidth` for the camera reserve. This shell keeps SEVERAL drawing tabs mounted at
 * once, each with its own engine, plus a file sidebar and a tab strip — so the overlay is a child
 * of the surface's own element, the two chrome classes go on THAT element, and the reserve is a
 * fraction of the pane. The same reason `handleKeyboardGlobally` is the parity checklist's one
 * deliberate drop.
 *
 * THE ONE PLACE THAT IS STILL DOCUMENT-WIDE is the key and double-click capture: the canvas has
 * the keyboard while presenting, and it is not inside this overlay. Both handlers therefore stand
 * down unless this overlay is in the VISIBLE tab layer, which is the same test
 * `boardCommand.ts` makes for the menu's canvas items.
 *
 * PRESENTING IS FREE-FORM. The camera is never locked: the presenter can pan and zoom at any
 * time, and ← → / Esc / a double-click re-fit. The hand tool is active while the chrome is
 * hidden so a drag pans; Shift+T brings the chrome back and switches to selection so the
 * presenter can draw. Whatever tool was active before presenting is put back on exit.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { applyFramesVisibility } from '../framesVisibility'
import type { ExcalidrawImperativeApi, ExcalidrawModule } from '../engine'
import { getPresentationViewportOffsets } from './camera'
import { arrowRightIcon, closeIcon, toolsIcon } from './presentationIcons'
import { findSlideIndexAtPoint, getOrderedPresentationFrames } from './slides'
import { isFrontmost } from '../../documents/boardCommand'
import './presentation.css'

/** The web app's own transition length; the status line and the token both key off it. */
export const PRESENTATION_TRANSITION_DURATION = 460

/** Keyed on by `presentation.css` to hide, and then bring back, the editor chrome. */
export const PRESENTATION_ACTIVE_CLASS = 'drawing-surface--presenting'
export const PRESENTATION_TOOLS_CLASS = 'drawing-surface--presentation-tools'

/**
 * The camera reserve is a fraction of the pane, so every resize has to be followed by a re-fit.
 * Resizing fires a burst of events and each re-fit is a full viewport write, so only the trailing
 * one lands.
 */
export const PRESENTATION_RESIZE_DEBOUNCE = 100

/** The engine values the player needs; both on `@excalidraw/excalidraw`'s own index. */
export type PresentationPlayerEngine = Pick<ExcalidrawModule, 'viewportCoordsToSceneCoords'>
/** The slice of the engine's imperative handle the player drives. */
export type PresentationPlayerTarget = Pick<ExcalidrawImperativeApi, 'getAppState' | 'getSceneElements' | 'setViewport' | 'setActiveTool' | 'updateFrameRendering' | 'onChange'>

/**
 * Excalidraw's text editor is a `textarea` and the chrome is full of inputs, so the presentation
 * shortcuts stand down while focus is inside one of them — otherwise pressing an arrow (or
 * Shift+T) would navigate instead of edit. Deliberately wider than the engine's own
 * `isWritableElement`: with the tools shown, focus can land on a colour swatch or a slider, where
 * an arrow belongs to the control and not to the deck.
 */
function isTextEntryTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
}

/** A control's tooltip and its accessible name are always the same string. */
const labelled = (label: string) => ({ title: label, 'aria-label': label })

export interface PresentationPlayerProps {
  engine: PresentationPlayerEngine
  excalidrawAPI: PresentationPlayerTarget
  /** The slide to open on — the panel's selected row, or null for the first. */
  initialFrameId?: string | null
  /** Leave the presentation (the ✕ button, or the deck emptying under the presenter). */
  onExit: () => void
  /**
   * Put the frame outlines back the way the USER's preference has them (🔒 YAZ-1775 D9:
   * `SettingsState.canvas.framesVisible`, where the web app read a localStorage key). Called
   * whether the presenter left on purpose or the component was simply unmounted.
   */
  onRestoreFrames: () => void
}

export function PresentationPlayer({ engine, excalidrawAPI, initialFrameId = null, onExit, onRestoreFrames }: PresentationPlayerProps) {
  const initialSlides = useMemo(() => getOrderedPresentationFrames(excalidrawAPI.getSceneElements()), [excalidrawAPI])
  const initialIndex = Math.max(
    initialSlides.findIndex(({ frame }) => frame.id === initialFrameId),
    0,
  )
  const [slides, setSlides] = useState(initialSlides)
  const [currentIndex, setCurrentIndex] = useState(initialIndex)
  const [isTransitioning, setIsTransitioning] = useState(true)
  const [toolsVisible, setToolsVisible] = useState(false)
  // The scene subscription, the document-level handlers and the transition timer all outlive the
  // render that created them, so the values they read are mirrored into refs.
  const slidesRef = useRef(initialSlides)
  const currentIndexRef = useRef(initialIndex)
  const currentFrameIdRef = useRef<string | null>(null)
  // Presenting is free-form: the canvas pans with the hand tool, so the tool the presenter had
  // before is remembered here and put back on exit.
  const toolBeforePresentingRef = useRef<string | null>(null)
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const transitionTokenRef = useRef(0)
  const didExitRef = useRef(false)
  const overlayRef = useRef<HTMLDivElement>(null)
  const onExitRef = useRef(onExit)
  const onRestoreFramesRef = useRef(onRestoreFrames)
  onExitRef.current = onExit
  onRestoreFramesRef.current = onRestoreFrames

  /** The surface's own element: what the chrome classes go on, and what the reserve is measured from. */
  const host = useCallback(() => overlayRef.current?.closest<HTMLElement>('.drawing-surface') ?? null, [])

  /** This overlay is in the tab that is IN FRONT — `boardCommand.ts`'s one test. */
  const inFront = useCallback(() => isFrontmost(overlayRef.current), [])

  const clearTransition = useCallback(() => {
    transitionTokenRef.current += 1
    if (transitionTimerRef.current !== null) {
      clearTimeout(transitionTimerRef.current)
      transitionTimerRef.current = null
    }
  }, [])

  /**
   * The only way this component moves the camera. Every presentation view is the same call with a
   * different target: fitted, and offset by the camera reserve. Never locked (see the module doc).
   */
  const applyViewport = useCallback(
    (target: unknown, animation: boolean | { duration: number }) =>
      excalidrawAPI.setViewport({
        target: target as never,
        fit: 'contain',
        animation,
        offsets: getPresentationViewportOffsets(host()?.clientWidth ?? 0),
      }),
    [excalidrawAPI, host],
  )

  /**
   * Hand tool while the chrome is hidden so a drag pans; selection while the tools are out so the
   * presenter can pick things up. `setTool(null)` puts back whatever was active before presenting
   * (`custom` / `image` cannot be re-activated blindly, so those fall back to selection).
   */
  const setTool = useCallback(
    (type: 'hand' | 'selection' | null) => {
      const restore = toolBeforePresentingRef.current
      const next = type ?? (restore !== null && restore !== 'custom' && restore !== 'image' ? restore : 'selection')
      excalidrawAPI.setActiveTool({ type: next } as Parameters<PresentationPlayerTarget['setActiveTool']>[0])
    },
    [excalidrawAPI],
  )

  const navigateTo = useCallback(
    (requestedIndex: number) => {
      const currentSlides = slidesRef.current
      if (currentSlides.length === 0 || didExitRef.current) return
      const nextIndex = Math.min(Math.max(requestedIndex, 0), currentSlides.length - 1)
      const next = currentSlides[nextIndex]
      if (next === undefined) return

      clearTransition()
      const token = transitionTokenRef.current
      currentIndexRef.current = nextIndex
      currentFrameIdRef.current = next.frame.id
      setCurrentIndex(nextIndex)
      setIsTransitioning(true)
      applyViewport(next.frame.id, { duration: PRESENTATION_TRANSITION_DURATION })
      transitionTimerRef.current = setTimeout(() => {
        // A newer navigation, an exit, or a deck view has already taken over.
        if (transitionTokenRef.current !== token || didExitRef.current || currentFrameIdRef.current !== next.frame.id) return
        transitionTimerRef.current = null
        setIsTransitioning(false)
      }, PRESENTATION_TRANSITION_DURATION + 16)
    },
    [applyViewport, clearTransition],
  )

  /**
   * Everything that has to be undone whether the presenter left on purpose or the component was
   * simply unmounted: the camera, the tool, the chrome classes, and the frame outlines the user's
   * own preference owns.
   */
  const endSession = useCallback(() => {
    didExitRef.current = true
    clearTransition()
    excalidrawAPI.setViewport(null)
    setTool(null)
    onRestoreFramesRef.current()
  }, [clearTransition, excalidrawAPI, setTool])

  const exit = useCallback(() => {
    if (didExitRef.current) return
    endSession()
    onExitRef.current()
  }, [endSession])

  const step = useCallback((amount: -1 | 1) => navigateTo(currentIndexRef.current + amount), [navigateTo])

  /**
   * Esc: zoom out to the whole deck WITHOUT leaving the presentation. The current slide does not
   * change. From here the presenter pans, double-clicks a slide, or presses ← →. Esc never ends
   * the presentation: restarting a deck by accident is worse than reaching for ✕.
   */
  const showDeck = useCallback(() => {
    if (didExitRef.current || slidesRef.current.length === 0) return
    // Otherwise an in-flight transition would land while the deck is zoomed out.
    clearTransition()
    setIsTransitioning(true)
    applyViewport(
      slidesRef.current.map(({ frame }) => frame.id),
      { duration: PRESENTATION_TRANSITION_DURATION },
    )
  }, [applyViewport, clearTransition])

  /** Re-fits the current slide with freshly measured offsets — after a resize, or a chrome toggle. */
  const refit = useCallback(
    (animated: boolean) => {
      const target = currentFrameIdRef.current
      if (target === null || didExitRef.current) return
      applyViewport(target, animated)
    },
    [applyViewport],
  )

  /**
   * Tools shown means the chrome comes back (via the class) and the selection tool is active so
   * the presenter can draw; hidden puts the hand tool back. The canvas is interactive either way.
   */
  const toggleTools = useCallback(() => {
    const visible = !toolsVisible
    setToolsVisible(visible)
    // Written straight to the DOM instead of from an effect so the chrome-hiding CSS has already
    // resolved when `setViewport` measures the editor UI for the `ui` half of its offsets.
    host()?.classList.toggle(PRESENTATION_TOOLS_CLASS, visible)
    setTool(visible ? 'selection' : 'hand')
    refit(true)
  }, [host, refit, setTool, toolsVisible])

  useEffect(() => {
    didExitRef.current = false
    overlayRef.current?.focus()
    const element = host()
    element?.classList.add(PRESENTATION_ACTIVE_CLASS)
    // Before the first `setViewport`, so the opening slide never flashes a frame outline or a name.
    applyFramesVisibility(excalidrawAPI, false)
    toolBeforePresentingRef.current = (excalidrawAPI.getAppState() as unknown as { activeTool?: { type?: string } }).activeTool?.type ?? null
    setTool('hand')
    navigateTo(initialIndex)

    return () => {
      element?.classList.remove(PRESENTATION_ACTIVE_CLASS, PRESENTATION_TOOLS_CLASS)
      if (!didExitRef.current) endSession()
    }
    // Mount-only by contract: a presentation is started once and ended once.
  }, [])

  // The deck is whatever the scene says it is: frames added, removed or reordered while presenting
  // re-index the deck under the presenter, and the slide they are on survives by ID, not position.
  useEffect(
    () =>
      excalidrawAPI.onChange((nextElements) => {
        const nextSlides = getOrderedPresentationFrames(nextElements as readonly unknown[])
        const oldIndex = currentIndexRef.current
        const currentFrameId = currentFrameIdRef.current
        slidesRef.current = nextSlides
        setSlides(nextSlides)
        if (nextSlides.length === 0) {
          exit()
          return
        }
        const survivingIndex = nextSlides.findIndex(({ frame }) => frame.id === currentFrameId)
        if (survivingIndex >= 0) {
          currentIndexRef.current = survivingIndex
          setCurrentIndex(survivingIndex)
          return
        }
        navigateTo(Math.min(oldIndex, nextSlides.length - 1))
      }),
    [excalidrawAPI, exit, navigateTo],
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // ⌘/⌃ combinations are the app's (⌘→ / ⌘← and friends), never a slide step.
      if (didExitRef.current || event.metaKey || event.ctrlKey || !inFront() || isTextEntryTarget(event.target)) return
      const key = event.key
      let handled = true
      if (
        key === 'ArrowRight' ||
        key === 'PageDown' ||
        // Space pans the canvas and activates whatever the chrome has focused, so it only advances
        // the slide while the tools are hidden.
        ((key === ' ' || key === 'Spacebar') && !toolsVisible)
      ) {
        step(1)
      } else if (key === 'ArrowLeft' || key === 'PageUp') {
        step(-1)
      } else if (key === 'Home') {
        navigateTo(0)
      } else if (key === 'End') {
        navigateTo(slidesRef.current.length - 1)
      } else if (key === 'Escape') {
        showDeck()
      } else if (event.shiftKey && (key === 't' || key === 'T')) {
        // Shift, so plain `t` still reaches the engine's text tool.
        toggleTools()
      } else if (key === 'Tab' && !toolsVisible) {
        // With tools shown the overlay is no longer modal, so the trap would make the toolbar
        // unreachable by keyboard.
        const controls = overlayRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
        if (controls !== undefined && controls.length > 0) {
          const first = controls[0]
          const last = controls[controls.length - 1]
          if (event.shiftKey && document.activeElement === first) last.focus()
          else if (!event.shiftKey && document.activeElement === last) first.focus()
          else handled = false
        } else {
          handled = false
        }
      } else {
        handled = false
      }

      if (handled) {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [inFront, navigateTo, showDeck, step, toggleTools, toolsVisible])

  // Double-click the canvas → present the smallest slide under the pointer. Captured on the
  // document so the engine never sees the dblclick (which would otherwise start a text element or
  // edit a shape).
  useEffect(() => {
    const handleDoubleClick = (event: MouseEvent) => {
      if (didExitRef.current || !inFront() || isTextEntryTarget(event.target)) return
      const index = findSlideIndexAtPoint(engine.viewportCoordsToSceneCoords(event, excalidrawAPI.getAppState() as never), slidesRef.current)
      if (index === null) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      navigateTo(index)
    }
    document.addEventListener('dblclick', handleDoubleClick, true)
    return () => document.removeEventListener('dblclick', handleDoubleClick, true)
  }, [engine, excalidrawAPI, inFront, navigateTo])

  // The reserve is a fraction of the PANE, so the pane changing size — the window resizing, or the
  // shell sidebar opening beside it — has to re-fit. Instantly: a resize is not a navigation.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const handleResize = () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        refit(false)
      }, PRESENTATION_RESIZE_DEBOUNCE)
    }
    window.addEventListener('resize', handleResize)
    const element = host()
    const observer = element !== null && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(handleResize) : null
    if (element !== null) observer?.observe(element)
    return () => {
      if (timer !== null) clearTimeout(timer)
      window.removeEventListener('resize', handleResize)
      observer?.disconnect()
    }
  }, [host, refit])

  const current = slides[currentIndex]
  if (current === undefined) return null
  const name = current.frame.name?.trim() || `Slide ${currentIndex + 1}`

  return (
    <div ref={overlayRef} className="presentation-player" role="dialog" aria-label="Presentation mode" tabIndex={-1}>
      <div className="presentation-player__status" aria-live="polite">
        {`${isTransitioning ? 'Moving to' : 'Showing'} slide ${currentIndex + 1} of ${slides.length} — ${name}`}
      </div>
      <div className="presentation-player__status" aria-live="polite">
        {toolsVisible ? 'Tools shown' : 'Tools hidden'}
      </div>
      <div className="presentation-player__controls">
        <button type="button" className="presentation-player__previous" {...labelled('Previous slide (←)')} disabled={currentIndex === 0} onClick={() => step(-1)}>
          {arrowRightIcon}
        </button>
        <button type="button" {...labelled('Next slide (→)')} disabled={currentIndex === slides.length - 1} onClick={() => step(1)}>
          {arrowRightIcon}
        </button>
        <span className="presentation-player__divider" aria-hidden="true" />
        <button type="button" {...labelled(toolsVisible ? 'Hide tools (⇧T)' : 'Show tools (⇧T)')} aria-pressed={toolsVisible} onClick={toggleTools}>
          {toolsIcon}
        </button>
        <span className="presentation-player__divider" aria-hidden="true" />
        <button type="button" {...labelled('Exit presentation')} onClick={exit}>
          {closeIcon}
        </button>
      </div>
    </div>
  )
}

