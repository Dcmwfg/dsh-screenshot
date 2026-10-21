/**
 * Client half of the screenshot bundle.
 *
 * One entry point only: a "截图" row in the composer's "+" command menu. The
 * host half runs the native helper, which hides this window, freezes the
 * screen, lets the user drag a region (with rectangle/arrow annotation),
 * restores the window, and answers with one PNG data URL.
 *
 * The PNG reaches the composer through the document-level drop target the
 * attachment surface installs (dsh-client-ui-attachment, installDocumentDropEvents),
 * so it uploads and previews exactly like a dropped file and nothing is sent
 * until the user submits.
 */
window.__ModuleLoader__.load({
  id: 'dsh-screenshot',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-screenshot'
    const SNIP_URL = '/dsh-screenshot/snip'
    /** The contribution's command name without the leading slash. */
    const ROW_NAME = 'shot'

    const zh = {
      command: '截图',
      commandHint: '框选屏幕任意区域（可标注），把图片放进输入框',
      failed: '截图失败',
      hideLabel: '隐藏本窗口后截图',
      hideDetail: '截到后台的其它窗口',
      keepLabel: '保持窗口可见',
      keepDetail: '只框选 DSH 自己',
      searchPlaceholder: '选择截图方式',
      empty: '没有可选方式',
      noResults: '没有匹配的方式',
    }

    const en = {
      command: 'Screenshot',
      commandHint: 'Crop any part of the screen (optionally annotate it) and drop the image in the composer',
      failed: 'Screenshot failed',
      hideLabel: 'Hide this window, then capture',
      hideDetail: 'Captures whatever is behind DSH',
      keepLabel: 'Keep this window visible',
      keepDetail: 'Only crops DSH itself',
      searchPlaceholder: 'Pick a capture mode',
      empty: 'No capture modes',
      noResults: 'No matching mode',
    }

    /** The two capture modes, newest choice wins and survives restarts. */
    const MODE_KEY = 'dsh-screenshot.mode'
    const MODES = ['hide', 'keep']
    let mode = 'hide'
    try {
      const stored = window.localStorage.getItem(MODE_KEY)
      if (MODES.includes(stored)) mode = stored
    } catch {
      // Storage can be blocked; the default is fine.
    }

    /** How long to keep polling for the picker sheet to leave the DOM. */
    const SHEET_CLOSE_TIMEOUT_MS = 1500
    /** Extra beat after the sheet is gone, so the repaint has landed. */
    const SHEET_PAINT_MS = 120

    /** Live translator; replaced with the locale-bound one during apply. */
    let t = (key) => key
    /** True while one capture is in flight; the menu row greys out meanwhile. */
    let busy = false
    /** True from the moment a mode is picked until its capture actually starts. */
    let pending = false

    /**
     * Hand one PNG to the composer as a pending attachment.
     *
     * A synthetic drop rides the same document-level listener a real
     * drag-and-drop uses, so this needs no package-private composer API and
     * keeps working when the composer's internals move.
     */
    function attachImage(dataUrl, name) {
      const comma = dataUrl.indexOf(',')
      const binary = atob(dataUrl.slice(comma + 1))
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)

      const file = new File([bytes], name, { type: 'image/png' })
      const transfer = new DataTransfer()
      transfer.items.add(file)

      const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
      document.body.dispatchEvent(event)
    }

    function stamp() {
      const now = new Date()
      const pad = (value) => String(value).padStart(2, '0')
      return now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds())
    }

    /** True only when the browser can build a synthetic file drop at all. */
    function canDrop() {
      return typeof DataTransfer === 'function' && typeof DragEvent === 'function' && typeof File === 'function'
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    /** One paint boundary; falls back to a timer where rAF does not exist. */
    function nextFrame() {
      return new Promise((resolve) => {
        if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(() => resolve())
        else setTimeout(resolve, 16)
      })
    }

    /**
     * True once the picker sheet is gone from the DOM.
     * Its search box is the one element whose placeholder this plugin owns,
     * so it is a stable hook that survives the shell's hashed class names.
     */
    function sheetGone() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return true
      const placeholder = t('searchPlaceholder')
      const fields = document.querySelectorAll('input[placeholder]')
      for (let index = 0; index < fields.length; index += 1) {
        const node = fields[index]
        if (node && node.getAttribute && node.getAttribute('placeholder') === placeholder) return false
      }
      return true
    }

    /**
     * Wait until the command sheet has closed and painted away.
     *
     * The shell's PopupSelectController only closes the sheet AFTER onSelect
     * resolves (dsh-client-ui-commands/lib/client.js:1250 awaits it, 1262-1265
     * then sets CLOSED), so the capture must not start inside that promise.
     * Waiting here lets the panel disappear before the native helper freezes
     * the screen, which is what keeps it out of a "keep window visible" shot.
     */
    async function waitForSheetClosed() {
      const deadline = Date.now() + SHEET_CLOSE_TIMEOUT_MS
      await nextFrame()
      await nextFrame()
      while (!sheetGone() && Date.now() < deadline) await sleep(50)
      // The node is gone but the compositor may still hold the old frame.
      await nextFrame()
      await sleep(SHEET_PAINT_MS)
    }

    /**
     * Run one capture and drop the result into the composer.
     * @param hideWindow - step this window aside first so the desktop behind is
     *   what gets captured; false crops DSH itself.
     */
    async function runCapture(hideWindow) {
      if (busy) return { ok: false, reason: 'busy' }
      if (!canDrop()) return { ok: false, reason: 'unsupported' }
      busy = true
      try {
        const response = await fetch(SNIP_URL, {
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
        attachImage(payload.dataUrl, 'screenshot-' + stamp() + '.png')
        return { ok: true, reason: '' }
      } catch (error) {
        return { ok: false, reason: 'failed', message: String(error && error.message ? error.message : error) }
      } finally {
        busy = false
      }
    }

    /**
     * The 16px camera glyph the command row renders. The host calls an icon
     * component as `<icon size={14} />`, so the size prop is honored instead of
     * assuming 16.
     */
    function CameraIcon(props) {
      const size = props !== null && props !== void 0 && typeof props.size === 'number' ? props.size : 16
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

    return {
      inject: ['locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'screenshot.locale.zh')
        ctx.effect(() => ctx.locale.register(NS, 'en', en), 'screenshot.locale.en')
        const translate = ctx.locale.bind(NS)
        t = (key) => translate(key)

        ctx.inject(['commandUi'], (scope) => {
          const commands = scope.get('commandUi')
          scope.effect(
            () =>
              commands.register({
                name: 'shot',
                label: () => t('command'),
                description: () => t('commandHint'),
                icon: CameraIcon,
                available: () => !busy && !pending,
                ui: {
                  kind: 'popupSelect',
                  searchMode: 'substring',
                  searchLabels: () => ({
                    placeholder: t('searchPlaceholder'),
                    empty: t('empty'),
                    noResults: t('noResults'),
                  }),
                  // Async on purpose: the shell calls `.then` on whatever this
                  // returns, so a bare array throws inside load() and the panel
                  // sits on "loading options" forever.
                  options: async () => [
                    { id: 'hide', label: t('hideLabel'), detail: t('hideDetail'), active: mode === 'hide' },
                    { id: 'keep', label: t('keepLabel'), detail: t('keepDetail'), active: mode === 'keep' },
                  ],
                  // Deliberately NOT async-awaited by the capture: the shell
                  // closes the sheet only after this returns, so awaiting the
                  // capture here would leave the panel on screen and freeze it
                  // into a "keep window visible" screenshot.
                  onSelect: (option) => {
                    if (!MODES.includes(option.id)) return
                    mode = option.id
                    try {
                      window.localStorage.setItem(MODE_KEY, mode)
                    } catch {
                      // Storage can be blocked; the choice still applies this run.
                    }
                    if (pending) return
                    pending = true
                    const hideWindow = option.id === 'hide'
                    void waitForSheetClosed()
                      .then(() => fire(hideWindow))
                      .finally(() => {
                        pending = false
                      })
                  },
                },
              }),
            'screenshot.command',
          )

          // 菜单分区是宿主硬编码的：SECTION_ROWS.add 只有 file/goal/plan/feedback，
          // 没被列出的第三方贡献一律落到 Commands 段末尾。这里给候选列表做一次
          // 后处理，把 /shot 那行搬到 Add 段里 file 的后面，和「文件」并排。
          scope.effect(() => {
            if (typeof commands.candidates !== 'function') return
            const original = commands.candidates
            commands.candidates = async (session, req) => {
              const rows = await original.call(commands, session, req)
              if (!Array.isArray(rows) || req?.query !== '') return rows
              const from = rows.findIndex((row) => row?.name === ROW_NAME)
              if (from === -1) return rows
              const anchorAt = rows.findIndex((row) => row?.name === 'file')
              const moved = [...rows]
              const [row] = moved.splice(from, 1)
              const at = anchorAt === -1 ? 0 : anchorAt + 1
              const section = rows[anchorAt === -1 ? 0 : anchorAt]?.section
              moved.splice(at, 0, { ...row, section })
              return moved
            }
            return () => {
              // candidates 是原型上的方法，这里加的是实例自有属性，删掉即还原。
              delete commands.candidates
            }
          }, 'screenshot.command.section')
        })
      },
    }

    /**
     * Menu path: run the capture and swallow the outcome. A cancelled capture
     * is silent; a real failure has no surface of its own in a menu row, so it
     * goes to the console with the helper's own message.
     * @param hideWindow - whether the native helper steps this window aside.
     */
    async function fire(hideWindow) {
      const result = await runCapture(hideWindow)
      if (!result.ok && result.reason !== 'cancelled') {
        console.warn('[dsh-screenshot]', t('failed'), result.reason, result.message || '')
      }
    }
  },
})
