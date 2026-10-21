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

const ROOT = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(ROOT, 'scripts')
const DRIVER = join(SCRIPTS, 'snip.ps1')

const SHOT_ROUTE = '/dsh-shot/shot'
const PING_ROUTE = '/dsh-shot/ping'

/** PowerShell 5.1 is the one shipped on every supported Windows version. */
const SHELL = (() => {
  const root = process.env.SystemRoot
  return root === undefined || root === ''
    ? 'powershell.exe'
    : join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
})()

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
      child = spawn(SHELL, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      done({ code: -1, stdout, stderr: String(error), expired })
      return
    }
    const alarm = setTimeout(() => {
      expired = true
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
  const run = await runDriver(['-File', DRIVER, '-RestoreOnly', '-Record', record], RESTORE_BUDGET_MS)
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

          try {
            const args = [
              '-File', DRIVER,
              '-OutPath', pngFile,
              '-Record', recordFile,
              '-TimeoutSeconds', String(CAPTURE_BUDGET_SECONDS),
              '-HideWindow', park ? '1' : '0',
              '-SourceDir', SCRIPTS,
            ]
            if (title !== '') args.push('-TitleFragment', title)

            const run = await runDriver(args, DRIVER_BUDGET_MS)
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
