/**
 * Host half of the macOS build.
 *
 * One route: ask the native driver to step the frontmost app aside, open the
 * system's own screen selector, take the PNG it wrote, and put the app back.
 * The client only forwards the finished image to the composer.
 *
 * Why the system selector and not one of our own: macOS already ships a better
 * region picker than anything worth rebuilding - the crosshair, the magnifier,
 * the live pixel readout, space to grab a whole window, Esc to cancel. So the
 * driver spends its own code on the half macOS does not do for you: getting the
 * window that hosts this page out of the way, and putting it back.
 *
 * Everything here runs in the DSH host process, never in the tool sandbox:
 * cross-application window control is refused inside that sandbox.
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
const DRIVER = join(SCRIPTS, 'snip-mac.sh')

/**
 * Route prefix, module id and bundle id all carry the platform, because this
 * is a separate package from the Windows build and the two must never claim the
 * same path if somebody installs both by accident.
 */
const SHOT_ROUTE = '/dsh-shot-mac/shot'
const PING_ROUTE = '/dsh-shot-mac/ping'

/** The bash that ships with macOS. */
const SHELL = '/bin/bash'

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
 * osascript chatter, so scan backwards for the last parseable object.
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
 * The argv that asks the driver for one capture.
 * Exported so the mapping can be checked without a host.
 */
export function driverArgs(options) {
  if (options.restoreOnly === true) {
    return [DRIVER, '--restore-only', '--record', options.recordFile]
  }
  const args = [
    DRIVER,
    '--out', options.outPath,
    '--record', options.recordFile,
    '--timeout', String(CAPTURE_BUDGET_SECONDS),
    '--hide', options.hideWindow ? '1' : '0',
    // The driver decides how each app steps aside from what it is - a browser
    // is minimized, anything else is hidden - so the two kinds are passed
    // through for the record and not branched on here.
    '--target-kind', options.hostKind,
    '--hide-kind', options.hostKind === 'browser' ? 'minimize' : 'hide',
  ]
  if (options.title !== '') args.push('--title', options.title)
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
      child = spawn(SHELL, args, {
        // A process group, so the timeout can take the selector down with the
        // script instead of leaving a crosshair on screen.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      done({ code: -1, stdout, stderr: String(error), expired })
      return
    }
    const alarm = setTimeout(() => {
      expired = true
      if (typeof child.pid === 'number') {
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
 * Last resort: put the app back when the driver died before its own trap could.
 * Answers true when the app is known to be back.
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
  if (!IS_MAC) {
    // This is the macOS package. Saying it once beats a silent capture that
    // spawns a bash path Windows does not have.
    console.warn('[dsh-screenshot-mac] this build only runs on macOS; install dsh-screenshot on Windows')
  }

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
          reply(res, 200, { ok: true, platform: process.platform, driver: DRIVER, shell: SHELL })
        },
      }),
    'screenshot.mac.ping',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SHOT_ROUTE,
        handler: async (req, res) => {
          if (refuse(req, res)) return
          if (!IS_MAC) {
            reply(res, 200, { ok: false, reason: 'failed', message: 'this build only runs on macOS' })
            return
          }
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
          const pngFile = join(tmpdir(), 'dsh-shot-mac-' + tag + '.png')
          const recordFile = join(tmpdir(), 'dsh-shot-mac-' + tag + '.parked')
          const title = typeof body.title === 'string' ? body.title.slice(0, TITLE_LIMIT_CHARS) : ''
          const park = body.hide !== false
          // The driver only ever asks the window server which app is frontmost;
          // it cannot read another app's window title, so "browser" is the only
          // kind worth distinguishing. Anything else is normalised to auto.
          const kind = typeof body.host === 'string' ? body.host.trim().toLowerCase() : ''
          const hostKind = kind === 'browser' ? 'browser' : kind === 'shell' ? 'shell' : 'auto'

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
                  ? 'the selector timed out; the app was put back'
                  : 'the selector timed out and the app did not come back',
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
              // "hide" for an app that was hidden, "minimize" for a browser
              // window, "" when nothing was touched.
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
    'screenshot.mac.shot',
  )
}
