/**
 * Host half of dsh-whatsmeow: owns the whatsmeow sidecar process, exposes the
 * pairing state to the browser over two same-origin HTTP routes, and bridges
 * WhatsApp chats to DSH Sessions.
 *
 * One WhatsApp chat maps to one DSH Session. An inbound message is delivered as
 * a user-role message on that Session; the assistant text of the turn it starts
 * is sent back to the same chat.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const inject = ['webServer', 'connection', 'agents']

export const name = 'dsh-whatsmeow'

/** Same-origin routes the Client half reads. */
const STATE_PATH = '/dsh-whatsmeow/state'
const ACTION_PATH = '/dsh-whatsmeow/action'

/** Slack on the sidecar's own rotation window, so a code is never offered past its life. */
const QR_GRACE_MS = 2_000

/** Body ceiling for the action route; its payload is one short word. */
const MAX_BODY_BYTES = 8 * 1024

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Answer one JSON request without caching; the payload is live connection state.
 * @param res - the response to own.
 * @param status - HTTP status code.
 * @param payload - JSON-serialisable body.
 */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** Read a bounded request body as UTF-8 text, or `undefined` past the ceiling. */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return undefined
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Turn a WhatsApp chat JID into a stable DSH Session id. The local part is
 * already digits, so only the server suffix needs flattening.
 * @param chat - the chat JID, for example `628123@s.whatsapp.net`.
 * @returns a session id unique to that chat.
 */
function sessionIdFor(chat) {
  return `whatsapp-${chat.replace(/@/g, '-').replace(/[^a-zA-Z0-9._-]/g, '_')}`
}

/**
 * Mount the plugin.
 * @param ctx - the Host plugin context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...config }
  const stateDir = options.stateDir
  const workspace = options.workspace
  const selfOnly = options.selfOnly
  const sidecarPath = options.sidecarPath || join(here, 'bin', 'whatsmeow-sidecar')

  /** Latest sidecar state, mirrored for the browser. */
  const state = {
    process: 'stopped',
    state: 'stopped',
    jid: '',
    pushName: '',
    qr: null,
    error: null,
    chats: [],
  }

  /** chat JID → DSH session id, and the reverse, for the live process. */
  const chatToSession = new Map()
  const sessionToChat = new Map()
  /** session id → assistant text accumulated for the turn in flight. */
  const turnText = new Map()
  /** request id → resolver for a sidecar command awaiting its answer. */
  const pending = new Map()
  let nextRequestId = 1
  let child = null
  let stdoutBuffer = ''

  /**
   * Send one command to the sidecar and resolve with its answer.
   * @param command - the command object without an id.
   * @param timeoutMs - how long to wait before failing.
   * @returns the sidecar's `data` payload.
   */
  function request(command, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      if (!child?.stdin?.writable) {
        reject(new Error('whatsmeow sidecar is not running'))
        return
      }
      const id = nextRequestId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`sidecar did not answer "${command.cmd}" in ${timeoutMs}ms`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`)
    })
  }

  /** Apply one sidecar event to the mirrored state and, for messages, to a Session. */
  function handleEvent(event) {
    switch (event.event) {
      case 'status':
        state.state = event.state ?? state.state
        state.jid = event.jid ?? state.jid
        state.pushName = event.pushName ?? state.pushName
        if (event.state !== 'qr') state.qr = null
        if (event.reason) state.error = event.reason
        break

      case 'qr':
        // The sidecar reports how long this code stays valid; trust that window
        // rather than a flat guess, or the phone scans a discarded pairing.
        state.qr = {
          png: event.png,
          code: event.code,
          timeout: event.timeout,
          expiresAt: Date.now() + Math.max(0, (event.timeout ?? 20) * 1000 - QR_GRACE_MS),
        }
        state.error = null
        break

      case 'error':
        state.error = event.message ?? 'unknown sidecar error'
        break

      case 'message':
        void deliverInbound(event)
        break

      default:
        break
    }
  }

  /** Bridge one inbound WhatsApp message onto its chat's DSH Session. */
  async function deliverInbound(event) {
    // Echoes of our own sends would otherwise loop straight back in.
    if (event.fromMe) return
    if (selfOnly && event.isGroup) return

    const chat = event.chat
    const text = event.text?.trim() ? event.text : `[${event.kind} message]`
    const sessionId = chatToSession.get(chat) ?? sessionIdFor(chat)
    chatToSession.set(chat, sessionId)
    sessionToChat.set(sessionId, chat)
    if (!state.chats.includes(chat)) state.chats.push(chat)

    try {
      const agent = await ensureSession(sessionId)
      agent.followup(Object.freeze({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
    } catch (error) {
      state.error = `deliver to session failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  /** Return the live agent for one chat, creating or resuming its Session as needed. */
  async function ensureSession(sessionId) {
    const live = ctx.agents.get(sessionId)
    if (live) return live
    try {
      const handle = await ctx.agents.create({ sessionId, meta: { cwd: workspace } })
      return handle.agent
    } catch (error) {
      // A Session persisted by an earlier run already owns this id, so resume it.
      // Without this a restart would silently mute every existing chat.
      try {
        const resumed = await ctx.agents.resume({ resumeSessionId: sessionId })
        return resumed.agent
      } catch {
        throw error
      }
    }
  }

  /** Relay the assistant text of a finished turn back to the chat that started it. */
  function flushTurn(sessionId) {
    const text = turnText.get(sessionId)
    turnText.delete(sessionId)
    const chat = sessionToChat.get(sessionId)
    if (!text || !chat) return
    request({ cmd: 'send', to: chat, text }).catch((error) => {
      state.error = `reply to WhatsApp failed: ${error instanceof Error ? error.message : String(error)}`
    })
  }

  /** Start the sidecar and begin mirroring its protocol lines. */
  async function start() {
    if (!existsSync(sidecarPath)) {
      state.process = 'failed'
      state.error = `sidecar binary missing at ${sidecarPath}; run sidecar/build.sh`
      return
    }
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    child = spawn(sidecarPath, [], {
      cwd: stateDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DSH_WHATSBMEOW_DIR: stateDir },
    })
    state.process = 'running'

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk
      let newline = stdoutBuffer.indexOf('\n')
      while (newline !== -1) {
        const line = stdoutBuffer.slice(0, newline).trim()
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        newline = stdoutBuffer.indexOf('\n')
        if (!line) continue
        let parsed
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        if (typeof parsed.id === 'number') {
          const waiter = pending.get(parsed.id)
          if (!waiter) continue
          pending.delete(parsed.id)
          clearTimeout(waiter.timer)
          if (parsed.ok) waiter.resolve(parsed.data)
          else waiter.reject(new Error(parsed.error ?? 'sidecar command failed'))
        } else if (typeof parsed.event === 'string') {
          handleEvent(parsed)
        }
      }
    })

    // The sidecar logs diagnostics on stderr; keep them out of the protocol and
    // out of the mirrored state, which reports only its own failures.
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', () => {})

    child.on('exit', (code) => {
      state.process = code === 0 ? 'stopped' : 'failed'
      state.state = 'stopped'
      state.qr = null
      for (const [id, waiter] of pending) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error('sidecar exited'))
        pending.delete(id)
      }
      child = null
    })
  }

  function stop() {
    if (!child) return
    try {
      child.stdin.end()
    } catch {
      // The pipe is already gone; the exit handler still clears the state.
    }
    child = null
  }

  ctx.effect(() => {
    void start()
    return () => { stop() }
  }, 'dsh-whatsmeow: sidecar process')

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const sessionId = session.id
    if (!sessionToChat.has(sessionId)) return
    if (event.type === 'assistant/message') {
      const text = event.data?.message?.content
        ?.filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (text) turnText.set(sessionId, (turnText.get(sessionId) ?? '') + text)
      return
    }
    if (event.type === 'turn/end') flushTurn(sessionId)
  }), 'dsh-whatsmeow: session relay')

  const reject = (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATE_PATH,
    handler: async (req, res) => {
      if (reject(req, res)) return
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }
      sendJson(res, 200, {
        process: state.process,
        state: state.state,
        jid: state.jid,
        pushName: state.pushName,
        // A code past its rotation window is worse than no code: the phone
        // would scan a pairing attempt the server already discarded.
        qr: state.qr && Date.now() < state.qr.expiresAt ? state.qr.png : null,
        error: state.error,
        chats: state.chats,
      })
    },
  }), `dsh-whatsmeow: GET ${STATE_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ACTION_PATH,
    handler: async (req, res) => {
      if (reject(req, res)) return
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      const body = await readBoundedBody(req)
      if (body === undefined) {
        sendJson(res, 413, { ok: false, error: 'body too large' })
        return
      }
      let action
      try {
        action = JSON.parse(body).action
      } catch {
        sendJson(res, 400, { ok: false, error: 'body must be JSON' })
        return
      }
      if (action !== 'login' && action !== 'logout') {
        sendJson(res, 400, { ok: false, error: 'action must be login or logout' })
        return
      }
      try {
        if (action === 'logout') {
          // Drop the chat mapping too: the next pairing starts from a clean slate.
          chatToSession.clear()
          sessionToChat.clear()
          state.chats.length = 0
        }
        await request({ cmd: action }, 30_000)
        sendJson(res, 200, { ok: true })
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }), `dsh-whatsmeow: POST ${ACTION_PATH}`)
}

/** Defaults for every option the row may override. */
const DEFAULTS = {
  stateDir: join(process.env.HOME ?? '.', '.dsh-whatsmeow'),
  workspace: process.env.DSH_WHATSBMEOW_WORKSPACE ?? process.cwd(),
  /** Group chats stay out of DSH unless the row opts in. */
  selfOnly: true,
  sidecarPath: '',
}
