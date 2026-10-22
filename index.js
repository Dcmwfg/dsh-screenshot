/**
 * Host half of the screenshot bundle.
 *
 * One route: ask the native driver to park this window, draw a full-screen
 * selection form over the whole virtual desktop, let the user frame and annotate
 * a region, crop it to PNG, and put the window back. The client only forwards
 * the finished image to the composer.
 *
 * The selection deliberately lives in a native top-level form rather than in the
 * page: a DOM overlay can never leave the renderer's viewport, so it can only
 * offer a scaled-down picker inside the app window. A WinForms form sized to
 * SystemInformation.VirtualScreen covers every monitor 1:1.
 *
 * Everything here runs in the DSH host process, never in the tool sandbox:
 * cross-process window control is refused inside that sandbox.
 */
import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const inject = ['webServer', 'connection']

const IS_MAC = process.platform === 'darwin'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(ROOT, 'scripts')
/** One driver per platform: the same job lives in different places on each. */
const DRIVER = join(SCRIPTS, IS_MAC ? 'snip-mac.sh' : 'snip.ps1')

const SHOT_ROUTE = '/dsh-shot/shot'
const PING_ROUTE = '/dsh-shot/ping'

/**
 * Windows runs the driver under PowerShell 5.1, the one shipped on every
 * supported version (and the one that can compile DshShot.cs in-process).
 * macOS runs it under the system bash.
 */
const SHELL = IS_MAC
  ? '/bin/bash'
  : (() => {
      const root = process.env.SystemRoot
      return root === undefined || root === ''
        ? 'powershell.exe'
        : join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    })()

/** What the shell needs in front of the driver path; macOS needs nothing. */
const SHELL_FLAGS = IS_MAC
  ? []
  : ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass']

/** How long the user may spend on the selector before the driver gives up. */
const CAPTURE_BUDGET_SECONDS = 180
/** Room for the answer plus a wedged process being killed. */
const DRIVER_BUDGET_MS = (CAPTURE_BUDGET_SECONDS + 30) * 1000
const BODY_LIMIT_BYTES = 4_096
const TITLE_LIMIT_CHARS = 160
const RESTORE_BUDGET_MS = 20_000

function reply(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/**
 * Collect the request body up to a hard limit.
 * @returns the parsed object, {} for an empty body, or undefined when unusable.
 */
async function collectBody(req) {
  const parts = []
  let total = 0
  for await (const part of req) {
    total += part.length
    if (total > BODY_LIMIT_BYTES) return undefined
    parts.push(part)
  }
  if (total === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(parts).toString('utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed
}

/**
 * The driver prints exactly one JSON line as its answer; earlier lines can be
 * Add-Type chatter, so scan backwards for the last parseable object.
 */
function answerLine(stdout) {
  const rows = stdout.split(/\r?\n/)
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index].trim()
    if (row.charCodeAt(0) !== 0x7b) continue
    try {
      return JSON.parse(row)
    } catch {
      // not the answer; keep scanning upwards
    }
  }
  return undefined
}

/**
 * The argv that asks this platform's driver for one capture.
 *
 * The two drivers do different things inside, but the host half asks for the
 * same thing on both: a PNG at this path, this window out of the way or not,
 * and one JSON line back. Exported so the mapping can be checked without a host.
 */
export function driverArgs(options) {
  const recordFile = options.recordFile
  if (options.restoreOnly === true) {
    return IS_MAC
      ? [DRIVER, '--restore-only', '--record', recordFile]
      : ['-File', DRIVER, '-RestoreOnly', '-Record', recordFile]
  }
  // Only a browser is minimized; every shell is hidden. Which one this is comes
  // from the caller, because a page on http cannot tell what is showing it.
  const hideKind = options.hostKind === 'browser' ? 'minimize' : 'hide'
  if (IS_MAC) {
    const args = [
      DRIVER,
      '--out', options.outPath,
      '--record', recordFile,
      '--timeout', String(CAPTURE_BUDGET_SECONDS),
      '--hide', options.hideWindow ? '1' : '0',
      '--target-kind', options.hostKind,
      '--hide-kind', hideKind,
    ]
    if (options.title !== '') args.push('--title', options.title)
    return args
  }
  const args = [
    '-File', DRIVER,
    '-OutPath', options.outPath,
    '-Record', recordFile,
    '-TimeoutSeconds', String(CAPTURE_BUDGET_SECONDS),
    '-HideWindow', options.hideWindow ? '1' : '0',
    '-TargetKind', options.hostKind,
    '-HideKind', hideKind,
    '-SourceDir', SCRIPTS,
  ]
  if (options.title !== '') args.push('-TitleFragment', options.title)
  return args
}

/**
 * Run the driver and wait for it to exit.
 * Resolves with { code, stdout, stderr, expired } - never rejects, so every
 * branch below can still answer the client.
 */
function runDriver(args, budgetMs) {
  return new Promise((done) => {
    let stdout = ''
    let stderr = ''
    let expired = false
    let child
    try {
      child = spawn(SHELL, [...SHELL_FLAGS, ...args], {
        windowsHide: true,
        // The macOS driver is killed as a group so the selector it started goes
        // with it; killing bash alone would leave a crosshair on screen.
        detached: IS_MAC,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      done({ code: -1, stdout, stderr: String(error), expired })
      return
    }
    const alarm = setTimeout(() => {
      expired = true
      if (IS_MAC && typeof child.pid === 'number') {
        try {
          process.kill(-child.pid, 'SIGTERM')
          return
        } catch {
          // fall through to a plain kill
        }
      }
      child.kill()
    }, budgetMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (part) => {
      stdout += part
    })
    child.stderr.on('data', (part) => {
      stderr += part
    })
    const settle = (code) => {
      clearTimeout(alarm)
      done({ code, stdout, stderr, expired })
    }
    child.on('error', (error) => {
      stderr += String(error)
      settle(-1)
    })
    child.on('close', (code) => settle(code))
  })
}

/**
 * Last resort: pull a parked window back when the driver died before its own
 * finally block could. Answers true when the window is known to be back.
 */
async function unpark(record) {
  if (record === undefined || record === '') return false
  const run = await runDriver(
    driverArgs({ recordFile: record, restoreOnly: true }),
    RESTORE_BUDGET_MS,
  )
  const answer = answerLine(run.stdout)
  return answer !== undefined && answer.restored === true
}

export function apply(ctx) {
  const refuse = (req, res) => {
    const status = ctx.connection.requestRejection(req)
    if (status === undefined) return false
    res.statusCode = status
    res.end()
    return true
  }

  // Liveness only: answers without starting a child, so a broken driver still
  // reports "the host half is loaded" and the client can tell the two apart.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: PING_ROUTE,
        handler: (req, res) => {
          if (refuse(req, res)) return
          reply(res, 200, { ok: true, driver: DRIVER, shell: SHELL })
        },
      }),
    'screenshot.ping',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SHOT_ROUTE,
        handler: async (req, res) => {
          if (refuse(req, res)) return
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }
          const type = String(req.headers['content-type'] ?? '')
            .split(';', 1)[0]
            .trim()
            .toLowerCase()
          if (type !== 'application/json') {
            reply(res, 415, { ok: false, reason: 'failed', message: 'send application/json' })
            return
          }
          const body = await collectBody(req)
          if (body === undefined) {
            reply(res, 400, { ok: false, reason: 'failed', message: 'request body is not readable JSON' })
            return
          }

          const tag = Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
          const pngFile = join(tmpdir(), '$dsh-shot-' + tag + '.png')
          const recordFile = join(tmpdir(), '$dsh-shot-' + tag + '.parked')
          const title = typeof body.title === 'string' ? body.title.slice(0, TITLE_LIMIT_CHARS) : ''
          const park = body.hide !== false
          // Who may step aside, and how, depends on what is showing the page:
          //   title    - a shell that serves the page under dsh-app://, where the
          //              caption names the window outright; hide it, exactly as
          //              the desktop build always has.
          //   shell    - a launcher that hosts the page in its own native window
          //              (DSH-X's Tauri window); its caption is the shell's own,
          //              so it is identified by its webview child instead, and it
          //              is hidden the same way - one code path for every shell.
          //   browser  - a real browser tab; only a known browser process is ever
          //              touched and minimizing keeps a taskbar button to come
          //              back to.
          //   auto     - let the driver decide from the window itself: a shell
          //              that owns the window is hidden, a browser tab is
          //              minimized. This is what the web build sends, because a
          //              page on http cannot tell which shell (if any) holds it.
          const kind = typeof body.host === 'string' ? body.host.trim().toLowerCase() : ''
          const hostKind =
            kind === 'browser' || kind === 'shell' || kind === 'auto' ? kind : 'title'

          try {
            const run = await runDriver(
              driverArgs({ outPath: pngFile, recordFile, title, hideWindow: park, hostKind }),
              DRIVER_BUDGET_MS,
            )
            if (run.expired) {
              const restored = park ? await unpark(recordFile) : true
              reply(res, 200, {
                ok: false,
                reason: 'failed',
                restored,
                message: restored
                  ? 'the selector timed out; the window was put back'
                  : 'the selector timed out and the window did not come back',
              })
              return
            }

            const answer = answerLine(run.stdout)
            if (answer === undefined) {
              const restored = park ? await unpark(recordFile) : true
              const detail = run.stderr.trim().split(/\r?\n/).slice(-3).join(' ')
              reply(res, 200, {
                ok: false,
                reason: 'failed',
                restored,
                message: detail === '' ? 'the capture driver exited with code ' + run.code : detail,
              })
              return
            }
            if (answer.ok !== true) {
              reply(res, 200, {
                ok: false,
                reason: typeof answer.reason === 'string' && answer.reason !== '' ? answer.reason : 'failed',
                message: typeof answer.message === 'string' ? answer.message : '',
                restored: true,
              })
              return
            }

            const bytes = await readFile(pngFile)
            reply(res, 200, {
              ok: true,
              dataUrl: 'data:image/png;base64,' + bytes.toString('base64'),
              width: answer.width,
              height: answer.height,
              hidden: answer.hidden === true,
              // "hide" for a shell that owns its window, "minimize" for a
              // browser tab, "" when nothing was touched. The client only needs
              // it to tell a missed window apart when it asked for one.
              mode: typeof answer.mode === 'string' ? answer.mode : '',
              restored: true,
              bytes: bytes.length,
            })
          } catch (error) {
            const restored = park ? await unpark(recordFile) : true
            reply(res, 200, { ok: false, reason: 'failed', restored, message: String(error) })
          } finally {
            await rm(pngFile, { force: true }).catch(() => {})
            await rm(recordFile, { force: true }).catch(() => {})
          }
        },
      }),
    'screenshot.shot',
  )
}
