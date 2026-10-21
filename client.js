/**
 * Client half of the screenshot bundle.
 *
 * Entry point: a "Screenshot" row in the composer's "+" command menu. The row
 * opens a two-choice sheet (park this window first, or keep it), and the host
 * half answers with one frozen full-desktop PNG plus the desktop origin it was
 * taken from.
 *
 * Cropping, annotation and the toolbar all happen here, over that frozen frame.
 * The selection stays editable after it is drawn - eight handles resize it, and
 * dragging just inside its border (or anywhere with Ctrl held) moves it.
 *
 * The finished crop is handed to the composer as a synthetic file drop, which is
 * the same path a real drag-and-drop takes: it uploads and previews like any
 * dropped image, and nothing is sent until the user submits.
 */
window.__ModuleLoader__.load({
  id: 'dsh-screenshot',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-screenshot'
    const ROW_NAME = 'shot'
    const ENDPOINT = '/dsh-shot/shot'
    const MODE_KEY = 'dsh-screenshot.mode'
    const MODES = ['hide', 'keep']

    /** The shell closes its command sheet only after onSelect resolves; poll for it. */
    const SHEET_CLOSE_TIMEOUT_MS = 1500
    const SHEET_PAINT_MS = 120

    /** Smallest selection a click-drag may leave behind, in image pixels. */
    const MIN_SIDE = 6
    /** Handle square, in screen pixels (converted to image pixels per frame). */
    const HANDLE_PX = 8
    /** How far past the border a press still counts as grabbing an edge. */
    const GRAB_PX = 5

    const zh = {
      command: '截图',
      commandHint: '框选屏幕任意区域，可标注，把图片放进输入框',
      failed: '截图失败',
      restoreFailed: '窗口没能自动恢复，请点一下任务栏里的 DSH',
      hideLabel: '隐藏本窗口后截图',
      hideDetail: '截到后台的其它窗口',
      keepLabel: '保持窗口可见',
      keepDetail: '只截 DSH 自己',
      searchPlaceholder: '选择截图方式',
      empty: '没有可选方式',
      noResults: '没有匹配的方式',
      shooting: '正在隐藏窗口并截图…',
      hint: '拖一个框 · 框内拖动可标注 · 边框抓手改大小 · Ctrl+拖动整块平移 · Esc 取消',
      undo: '撤销',
      confirm: '确认',
      cancel: '取消',
    }

    const en = {
      command: 'Screenshot',
      commandHint: 'Crop any part of the screen, annotate it, and put the image in the composer',
      failed: 'Screenshot failed',
      restoreFailed: 'The window did not come back; click DSH on the taskbar.',
      hideLabel: 'Hide this window, then capture',
      hideDetail: 'Captures whatever is behind DSH',
      keepLabel: 'Keep this window visible',
      keepDetail: 'Only crops DSH itself',
      searchPlaceholder: 'Pick a capture mode',
      empty: 'No capture modes',
      noResults: 'No matching mode',
      shooting: 'Hiding the window and capturing…',
      hint: 'Drag a box · drag inside it to annotate · handles resize · Ctrl+drag moves · Esc cancels',
      undo: 'Undo',
      confirm: 'Confirm',
      cancel: 'Cancel',
    }

    let t = (key) => key
    let busy = false
    let pending = false

    /** One remembered mode across restarts. */
    let mode = 'hide'
    try {
      const stored = window.localStorage.getItem(MODE_KEY)
      if (MODES.indexOf(stored) !== -1) mode = stored
    } catch (error) {
      // Storage can be blocked; the default still works.
    }

    // ---------------------------------------------------------------- store

    const watchers = new Set()
    let view = { phase: 'idle', frame: null, error: '' }

    function publish(patch) {
      view = Object.assign({}, view, patch)
      watchers.forEach((fn) => {
        try {
          fn()
        } catch (error) {
          // a broken listener must not block the others
        }
      })
    }

    function subscribe(fn) {
      watchers.add(fn)
      return () => {
        watchers.delete(fn)
      }
    }

    function snapshot() {
      return view
    }

    // --------------------------------------------------------------- helpers

    function sleep(ms) {
      return new Promise((done) => setTimeout(done, ms))
    }

    function nextFrame() {
      return new Promise((done) => {
        if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(() => done())
        else setTimeout(done, 16)
      })
    }

    /** True while the shell's option sheet is still mounted. */
    function sheetOpen() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return false
      const wanted = t('searchPlaceholder')
      const fields = document.querySelectorAll('input[placeholder]')
      for (let index = 0; index < fields.length; index += 1) {
        const node = fields[index]
        if (node && typeof node.getAttribute === 'function' && node.getAttribute('placeholder') === wanted) return true
      }
      return false
    }

    /**
     * Let the sheet leave the DOM before the shutter fires. The panel lives in
     * the page, so a "keep this window" shot taken too early freezes the panel
     * into the frame the user is about to crop.
     */
    async function waitForSheetGone() {
      const deadline = Date.now() + SHEET_CLOSE_TIMEOUT_MS
      await nextFrame()
      await nextFrame()
      while (sheetOpen() && Date.now() < deadline) await sleep(50)
      await nextFrame()
      await sleep(SHEET_PAINT_MS)
    }

    function stamp() {
      const now = new Date()
      const two = (value) => (value < 10 ? '0' + value : String(value))
      return (
        now.getFullYear() + two(now.getMonth() + 1) + two(now.getDate()) +
        '-' + two(now.getHours()) + two(now.getMinutes()) + two(now.getSeconds())
      )
    }

    function canDrop() {
      return typeof File === 'function' && typeof DataTransfer === 'function' && typeof DragEvent === 'function'
    }

    /** Hand one PNG blob to the composer through its document-level drop target. */
    function dropIntoComposer(blob, name) {
      const file = new File([blob], name, { type: 'image/png' })
      const bag = new DataTransfer()
      bag.items.add(file)
      const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: bag })
      document.body.dispatchEvent(event)
    }

    function loadFrame(dataUrl) {
      return new Promise((done, fail) => {
        const image = new Image()
        image.onload = () => done(image)
        image.onerror = () => fail(new Error('the frame did not decode'))
        image.src = dataUrl
      })
    }

    // ---------------------------------------------------------------- shutter

    /**
     * Ask the host for one frozen frame.
     * @param hideWindow - park this window first so the desktop behind is shot.
     */
    async function shoot(hideWindow) {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: document.title, hide: hideWindow !== false }),
      })
      const payload = await response.json().catch(() => null)
      if (payload === null) return { ok: false, reason: 'failed' }
      if (payload.ok !== true) {
        return {
          ok: false,
          reason: payload.reason === 'cancelled' ? 'cancelled' : 'failed',
          message: typeof payload.message === 'string' ? payload.message : '',
        }
      }
      if (payload.restored === false) return { ok: false, reason: 'failed', message: t('restoreFailed') }
      return { ok: true, payload }
    }

    /** Full flow: shoot, decode, open the overlay. */
    async function beginCapture(hideWindow) {
      if (busy) return
      busy = true
      publish({ phase: 'shooting', frame: null, error: '' })
      try {
        const result = await shoot(hideWindow)
        if (!result.ok) {
          if (result.reason !== 'cancelled') {
            publish({ phase: 'idle', error: '' })
            console.warn('[dsh-screenshot]', t('failed'), result.reason, result.message || '')
          } else {
            publish({ phase: 'idle', error: '' })
          }
          return
        }
        if (!canDrop()) {
          publish({ phase: 'idle', error: '' })
          return
        }
        const image = await loadFrame(result.payload.dataUrl)
        publish({
          phase: 'cropping',
          frame: {
            dataUrl: result.payload.dataUrl,
            image,
            width: result.payload.width,
            height: result.payload.height,
            left: result.payload.left,
            top: result.payload.top,
          },
          error: '',
        })
      } catch (error) {
        publish({ phase: 'idle', frame: null, error: String(error && error.message ? error.message : error) })
        console.warn('[dsh-screenshot]', t('failed'), error)
      } finally {
        busy = false
        pending = false
      }
    }

    // ----------------------------------------------------------------- glyphs

    function GlyphUndo() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M5.6 4.2 L2.6 7 L5.6 9.8',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M2.9 7 L9.2 7 A3.4 3.4 0 0 1 9.2 13.8 L6.6 13.8',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
        }),
      )
    }

    function GlyphTick() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M3.4 8.6 L6.8 12 L12.6 4.6',
          stroke: 'currentColor',
          strokeWidth: 2.1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function GlyphCross() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M4 4 L12 12 M12 4 L4 12',
          stroke: 'currentColor',
          strokeWidth: 2.1,
          strokeLinecap: 'round',
        }),
      )
    }

    /** The camera the command row shows; the shell calls icons as <icon size={14} />. */
    function CameraIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          'aria-hidden': 'true',
        },
        h('path', { d: 'M2 5.6h2.1l.9-1.4h4l.9 1.4H14v7H2z', strokeLinejoin: 'round' }),
        h('circle', { cx: 8, cy: 9, r: 2.3 }),
      )
    }

    // ---------------------------------------------------------------- overlay

    const TOOL_LOOK = {
      undo: { ink: '#3c5a82', tint: '#dee4ee' },
      confirm: { ink: '#18924e', tint: '#c4e8d0' },
      cancel: { ink: '#cc2828', tint: '#f2cdcd' },
    }

    function ToolButton(props) {
      const [hover, setHover] = React.useState(false)
      const look = TOOL_LOOK[props.kind]
      return h(
        'button',
        {
          type: 'button',
          title: props.label,
          'aria-label': props.label,
          onClick: (event) => {
            event.stopPropagation()
            props.onRun()
          },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            padding: 0,
            border: '1px solid ' + look.ink,
            borderRadius: 6,
            background: hover ? '#ffffff' : look.tint,
            color: look.ink,
            cursor: 'pointer',
            font: 'inherit',
          },
        },
        props.children,
      )
    }

    /** Screen point to image pixel. Returns null before the stage is mounted. */
    function toImage(frame, event, node) {
      if (node === null || node === undefined || frame.width <= 0) return null
      const rect = node.getBoundingClientRect()
      if (rect.width <= 0) return null
      // Divide the image size by what is on screen, not by the stage's own
      // width - those are the same number and would give a scale of exactly 1.
      return {
        x: (event.clientX - rect.left) * (frame.width / rect.width),
        y: (event.clientY - rect.top) * (frame.height / rect.height),
      }
    }

    function normalise(a, b) {
      const x = Math.min(a.x, b.x)
      const y = Math.min(a.y, b.y)
      return { x, y, width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }
    }

    function clampBox(box, frame) {
      const x = Math.max(0, Math.min(box.x, frame.width))
      const y = Math.max(0, Math.min(box.y, frame.height))
      const right = Math.max(0, Math.min(box.x + box.width, frame.width))
      const bottom = Math.max(0, Math.min(box.y + box.height, frame.height))
      return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) }
    }

    /** Which of the eight handles (if any) sits under this image-space point. */
    function handleAt(sel, point, grab) {
      if (sel === null) return ''
      const midX = sel.x + sel.width / 2
      const midY = sel.y + sel.height / 2
      const right = sel.x + sel.width
      const bottom = sel.y + sel.height
      const near = (px, py) => Math.abs(point.x - px) <= grab && Math.abs(point.y - py) <= grab
      if (near(sel.x, sel.y)) return 'nw'
      if (near(right, sel.y)) return 'ne'
      if (near(sel.x, bottom)) return 'sw'
      if (near(right, bottom)) return 'se'
      if (near(midX, sel.y)) return 'n'
      if (near(midX, bottom)) return 's'
      if (near(sel.x, midY)) return 'w'
      if (near(right, midY)) return 'e'
      return ''
    }

    function insideBody(sel, point, strip) {
      if (sel === null) return false
      return (
        point.x > sel.x + strip &&
        point.x < sel.x + sel.width - strip &&
        point.y > sel.y + strip &&
        point.y < sel.y + sel.height - strip
      )
    }

    function resizeTo(sel, handle, point, frame) {
      let left = sel.x
      let top = sel.y
      let right = sel.x + sel.width
      let bottom = sel.y + sel.height
      if (handle.indexOf('w') !== -1) left = point.x
      if (handle.indexOf('e') !== -1) right = point.x
      if (handle.indexOf('n') !== -1) top = point.y
      if (handle.indexOf('s') !== -1) bottom = point.y
      const box = {
        x: Math.min(left, right),
        y: Math.min(top, bottom),
        width: Math.abs(right - left),
        height: Math.abs(bottom - top),
      }
      return clampBox(box, frame)
    }

    function cursorFor(handle) {
      if (handle === 'nw' || handle === 'se') return 'nwse-resize'
      if (handle === 'ne' || handle === 'sw') return 'nesw-resize'
      if (handle === 'n' || handle === 's') return 'ns-resize'
      if (handle === 'e' || handle === 'w') return 'ew-resize'
      return 'crosshair'
    }

    function Overlay() {
      const state = React.useSyncExternalStore(subscribe, snapshot)
      const frame = state.frame
      const open = state.phase === 'cropping' && frame !== null

      const [tail, setTail] = React.useState({ width: 0, height: 0 })
      const [sel, setSel] = React.useState(null)
      const [marks, setMarks] = React.useState([])
      const [live, setLive] = React.useState(null)
      const [cursor, setCursor] = React.useState('crosshair')
      const stage = React.useRef(null)
      const drag = React.useRef(null)
      // The pointerup handler must see the last box the pointermove produced,
      // not the one from the render that installed the handler.
      const liveRef = React.useRef(null)

      // Fit the frozen frame to the viewport, once, and never upscale: a 1:1
      // frame keeps one image pixel one screen pixel when the desktop is small.
      React.useEffect(() => {
        if (!open || frame === null) return
        const fit = () => {
          const scale = Math.min(window.innerWidth / frame.width, window.innerHeight / frame.height, 1)
          setTail({ width: Math.round(frame.width * scale), height: Math.round(frame.height * scale) })
        }
        fit()
        setSel(null)
        setMarks([])
        setLive(null)
        window.addEventListener('resize', fit)
        return () => window.removeEventListener('resize', fit)
      }, [open, frame])

      const close = React.useCallback(() => {
        drag.current = null
        publish({ phase: 'idle', frame: null, error: '' })
      }, [])

      const finish = React.useCallback(async () => {
        if (frame === null || sel === null || sel.width < MIN_SIDE || sel.height < MIN_SIDE) return
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(sel.width)
        canvas.height = Math.round(sel.height)
        const paint = canvas.getContext('2d')
        if (paint === null) return
        paint.drawImage(
          frame.image,
          Math.round(sel.x), Math.round(sel.y), Math.round(sel.width), Math.round(sel.height),
          0, 0, canvas.width, canvas.height,
        )
        // Marks live in image space; clip each one to the selection so a stroke
        // that runs off the crop edge does not reappear shrunken inside it.
        paint.save()
        paint.beginPath()
        paint.rect(0, 0, canvas.width, canvas.height)
        paint.clip()
        paint.strokeStyle = '#e5322d'
        paint.lineWidth = 2
        marks.forEach((mark) => {
          paint.strokeRect(
            mark.x - Math.round(sel.x),
            mark.y - Math.round(sel.y),
            mark.width,
            mark.height,
          )
        })
        paint.restore()

        const blob = await new Promise((done) => canvas.toBlob(done, 'image/png'))
        if (blob === null || blob === undefined) {
          close()
          return
        }
        dropIntoComposer(blob, 'screenshot-' + stamp() + '.png')
        close()
      }, [frame, sel, marks, close])

      // Keyboard: Esc abandons, Enter accepts, Ctrl+Z drops the last mark.
      React.useEffect(() => {
        if (!open) return
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            close()
            return
          }
          if (event.key === 'Enter') {
            event.preventDefault()
            void finish()
            return
          }
          if ((event.ctrlKey || event.metaKey) && (event.key === 'z' || event.key === 'Z')) {
            event.preventDefault()
            setMarks((list) => list.slice(0, Math.max(0, list.length - 1)))
          }
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [open, close, finish])

      if (!open) return null

      const scale = tail.width > 0 ? tail.width / frame.width : 1
      const grab = GRAB_PX / scale
      const strip = Math.min(HANDLE_PX / scale, Math.min(sel === null ? 0 : sel.width / 4, sel === null ? 0 : sel.height / 4))

      const onPointerDown = (event) => {
        if (event.button !== 0) return
        const point = toImage(frame, event, stage.current)
        if (point === null) return
        if (sel !== null) {
          const handle = handleAt(sel, point, grab)
          if (handle !== '') {
            drag.current = { kind: 'resize', handle, origin: point, box: sel }
            event.currentTarget.setPointerCapture(event.pointerId)
            return
          }
          if (event.ctrlKey || event.metaKey) {
            if (sel.x <= point.x && point.x <= sel.x + sel.width && sel.y <= point.y && point.y <= sel.y + sel.height) {
              drag.current = { kind: 'move', origin: point, box: sel }
              event.currentTarget.setPointerCapture(event.pointerId)
              return
            }
          }
          if (insideBody(sel, point, strip)) {
            drag.current = { kind: 'mark', origin: point, box: sel }
            liveRef.current = { x: point.x, y: point.y, width: 0, height: 0 }
            setLive(liveRef.current)
            event.currentTarget.setPointerCapture(event.pointerId)
            return
          }
        }
        drag.current = { kind: 'select', origin: point, box: null }
        liveRef.current = { x: point.x, y: point.y, width: 0, height: 0 }
        setLive(liveRef.current)
        event.currentTarget.setPointerCapture(event.pointerId)
      }

      const onPointerMove = (event) => {
        const point = toImage(frame, event, stage.current)
        if (point === null) return
        const run = drag.current
        if (run === null) {
          // Idle: the cursor advertises what a press here would do.
          if (sel === null) {
            setCursor('crosshair')
            return
          }
          const hot = handleAt(sel, point, grab)
          setCursor(hot === '' ? 'crosshair' : cursorFor(hot))
          return
        }
        if (run.kind === 'select') {
          liveRef.current = normalise(run.origin, point)
          setLive(liveRef.current)
          return
        }
        if (run.kind === 'resize') {
          setSel(resizeTo(run.box, run.handle, point, frame))
          return
        }
        if (run.kind === 'move') {
          const dx = point.x - run.origin.x
          const dy = point.y - run.origin.y
          setSel(clampBox({ x: run.box.x + dx, y: run.box.y + dy, width: run.box.width, height: run.box.height }, frame))
          return
        }
        if (run.kind === 'mark') {
          liveRef.current = normalise(run.origin, point)
          setLive(liveRef.current)
        }
      }

      const onPointerUp = (event) => {
        const run = drag.current
        drag.current = null
        if (run === null) return
        if (run.kind === 'select') {
          const draft = liveRef.current
          const box = clampBox(draft === null ? { x: 0, y: 0, width: 0, height: 0 } : draft, frame)
          liveRef.current = null
          setLive(null)
          if (box.width >= MIN_SIDE && box.height >= MIN_SIDE) setSel(box)
          return
        }
        if (run.kind === 'mark') {
          const mark = liveRef.current
          liveRef.current = null
          setLive(null)
          if (mark !== null && mark.width >= MIN_SIDE && mark.height >= MIN_SIDE) {
            setMarks((list) => list.concat([mark]))
          }
        }
        try {
          event.currentTarget.releasePointerCapture(event.pointerId)
        } catch (error) {
          // capture may already be gone; nothing to release
        }
      }

      const box = live !== null ? live : sel

      const handles = []
      if (sel !== null) {
        const spots = [
          ['nw', 0, 0],
          ['n', 0.5, 0],
          ['ne', 1, 0],
          ['e', 1, 0.5],
          ['se', 1, 1],
          ['s', 0.5, 1],
          ['sw', 0, 1],
          ['w', 0, 0.5],
        ]
        spots.forEach((spot) => {
          handles.push(
            h('span', {
              key: spot[0],
              style: {
                position: 'absolute',
                left: (sel.x + sel.width * spot[1]) * scale - HANDLE_PX / 2,
                top: (sel.y + sel.height * spot[2]) * scale - HANDLE_PX / 2,
                width: HANDLE_PX,
                height: HANDLE_PX,
                background: '#ffffff',
                border: '1px solid #505050',
                boxSizing: 'border-box',
                pointerEvents: 'none',
              },
            }),
          )
        })
      }

      return h(
        'div',
        {
          className: 'dsh-shot-layer',
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 2147483000,
            background: 'rgba(8, 12, 20, .72)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'auto',
          },
          onContextMenu: (event) => {
            event.preventDefault()
            close()
          },
        },
        h(
          'div',
          {
            ref: stage,
            onPointerDown,
            onPointerMove,
            onPointerUp,
            style: {
              position: 'relative',
              width: tail.width,
              height: tail.height,
              cursor,
              touchAction: 'none',
              userSelect: 'none',
            },
          },
          h('img', {
            src: frame.dataUrl,
            alt: '',
            draggable: false,
            style: { display: 'block', width: tail.width, height: tail.height, userSelect: 'none' },
          }),
          box === null
            ? null
            : h('div', {
                style: {
                  position: 'absolute',
                  left: box.x * scale,
                  top: box.y * scale,
                  width: box.width * scale,
                  height: box.height * scale,
                  boxShadow: '0 0 0 9999px rgba(8, 12, 20, .45)',
                  border: '1px solid #6fa8ff',
                  boxSizing: 'border-box',
                  pointerEvents: 'none',
                },
              }),
          marks.map((mark, index) =>
            h('div', {
              key: 'mark-' + index,
              style: {
                position: 'absolute',
                left: mark.x * scale,
                top: mark.y * scale,
                width: mark.width * scale,
                height: mark.height * scale,
                border: '2px solid #e5322d',
                boxSizing: 'border-box',
                pointerEvents: 'none',
              },
            }),
          ),
          live !== null && drag.current !== null && drag.current.kind === 'mark'
            ? h('div', {
                style: {
                  position: 'absolute',
                  left: live.x * scale,
                  top: live.y * scale,
                  width: live.width * scale,
                  height: live.height * scale,
                  border: '2px solid #e5322d',
                  boxSizing: 'border-box',
                  pointerEvents: 'none',
                },
              })
            : null,
          handles,
          sel === null
            ? null
            : h(
                'div',
                {
                  style: {
                    position: 'absolute',
                    left: Math.min(sel.x * scale + sel.width * scale - 116, tail.width - 116),
                    top: Math.min(sel.y * scale + sel.height * scale + 8, tail.height - 34),
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '3px 5px',
                    borderRadius: 8,
                    background: 'rgba(255, 255, 255, .96)',
                    boxShadow: '0 6px 18px rgba(0, 0, 0, .28)',
                    pointerEvents: 'auto',
                  },
                },
                h(ToolButton, {
                  kind: 'undo',
                  label: t('undo'),
                  onRun: () => setMarks((list) => list.slice(0, Math.max(0, list.length - 1))),
                }, h(GlyphUndo)),
                h(ToolButton, { kind: 'confirm', label: t('confirm'), onRun: () => void finish() }, h(GlyphTick)),
                h(ToolButton, { kind: 'cancel', label: t('cancel'), onRun: close }, h(GlyphCross)),
                h(
                  'span',
                  { style: { color: '#5b6472', fontSize: 11, paddingRight: 2 } },
                  Math.round(sel.width) + ' x ' + Math.round(sel.height),
                ),
              ),
        ),
        h(
          'div',
          {
            style: {
              position: 'fixed',
              left: 0,
              right: 0,
              bottom: 0,
              padding: '8px 12px',
              textAlign: 'center',
              color: 'rgba(255, 255, 255, .82)',
              fontSize: 12,
              pointerEvents: 'none',
            },
          },
          t('hint'),
        ),
      )
    }

    /** A toast-free failure surface: the shooting phase shows in the menu row. */
    function statusText() {
      if (view.phase === 'shooting') return t('shooting')
      return ''
    }

    return {
      inject: ['locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'screenshot.locale.zh')
        ctx.effect(() => ctx.locale.register(NS, 'en', en), 'screenshot.locale.en')
        const translate = ctx.locale.bind(NS)
        t = (key) => {
          const text = translate(key)
          return typeof text === 'string' && text !== '' ? text : key
        }

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'screenshot.frame', order: 60 }, Overlay),
        )

        ctx.inject(['commandUi'], (scope) => {
          const commands = scope.get('commandUi')
          scope.effect(
            () =>
              commands.register({
                name: ROW_NAME,
                label: () => (statusText() === '' ? t('command') : statusText()),
                description: () => t('commandHint'),
                icon: CameraIcon,
                available: () => !busy && !pending && view.phase === 'idle',
                ui: {
                  kind: 'popupSelect',
                  searchMode: 'substring',
                  searchLabels: () => ({
                    placeholder: t('searchPlaceholder'),
                    empty: t('empty'),
                    noResults: t('noResults'),
                  }),
                  // The shell calls .then on this, so it has to be a promise.
                  options: async () => [
                    { id: 'hide', label: t('hideLabel'), detail: t('hideDetail'), active: mode === 'hide' },
                    { id: 'keep', label: t('keepLabel'), detail: t('keepDetail'), active: mode === 'keep' },
                  ],
                  // Must not await the capture: the shell closes the sheet only
                  // after this returns, and the shot has to happen with the
                  // sheet already gone.
                  onSelect: (option) => {
                    if (MODES.indexOf(option.id) === -1) return
                    mode = option.id
                    try {
                      window.localStorage.setItem(MODE_KEY, mode)
                    } catch (error) {
                      // the choice still applies for this run
                    }
                    if (pending) return
                    pending = true
                    const hideWindow = option.id === 'hide'
                    void waitForSheetGone().then(() => beginCapture(hideWindow))
                  },
                },
              }),
            'screenshot.command',
          )

          // The shell hard-codes its section table (add: file/goal/plan/feedback),
          // so a third-party row lands at the end of Commands. Lift this one up
          // next to "File" where a screenshot belongs.
          scope.effect(() => {
            if (typeof commands.candidates !== 'function') return
            const original = commands.candidates
            commands.candidates = async (session, request) => {
              const rows = await original.call(commands, session, request)
              if (!Array.isArray(rows) || request === undefined || request.query !== '') return rows
              const from = rows.findIndex((row) => row !== null && row.name === ROW_NAME)
              if (from === -1) return rows
              const anchor = rows.findIndex((row) => row !== null && row.name === 'file')
              const moved = rows.slice()
              const lifted = moved.splice(from, 1)[0]
              const section = rows[anchor === -1 ? 0 : anchor] === undefined ? undefined : rows[anchor === -1 ? 0 : anchor].section
              moved.splice(anchor === -1 ? 0 : anchor + 1, 0, Object.assign({}, lifted, { section }))
              return moved
            }
            return () => {
              delete commands.candidates
            }
          }, 'screenshot.command.section')
        })
      },
    }
  },
})
