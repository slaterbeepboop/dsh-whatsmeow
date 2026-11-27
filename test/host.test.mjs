#!/usr/bin/env node
// Drives the Host half of dsh-whatsmeow against a fake sidecar and asserts the
// observable contract: both routes, and the WhatsApp-to-Session bridge.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { apply } from '../index.js'

const FAKE = new URL('./fake-sidecar.mjs', import.meta.url).pathname
const SENT_LOG = new URL('./.sent.jsonl', import.meta.url).pathname
const STATE = new URL('./.state', import.meta.url).pathname

rmSync(SENT_LOG, { force: true })
rmSync(STATE, { recursive: true, force: true })

const routes = new Map()
const listeners = new Map()
const disposers = []
const created = []
const followed = []

const ctx = {
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
  connection: { requestRejection: () => undefined },
  on(event, fn) {
    listeners.set(event, fn)
    return () => listeners.delete(event)
  },
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  agents: {
    get: () => undefined,
    async create({ sessionId }) {
      created.push(sessionId)
      return { agent: { followup: (message) => followed.push({ sessionId, message }) } }
    },
    async resume({ resumeSessionId }) {
      return { agent: { followup: (message) => followed.push({ sessionId: resumeSessionId, message }) } }
    },
  },
}

/** Call one registered route with a synthetic request and capture its response. */
function callHandler(path, { method = 'GET', body = '' } = {}) {
  return new Promise((resolve) => {
    const req = {
      method,
      headers: {},
      async *[Symbol.asyncIterator]() {
        if (body) yield Buffer.from(body)
      },
    }
    const res = {
      statusCode: 200,
      setHeader() {},
      end: (payload) => resolve({ status: res.statusCode, body: payload ? JSON.parse(payload) : null }),
    }
    void routes.get(path)(req, res)
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const readSends = () => existsSync(SENT_LOG)
  ? readFileSync(SENT_LOG, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : []

apply(ctx, { stateDir: STATE, sidecarPath: FAKE, workspace: '/tmp' })
assert.ok(routes.has('/dsh-whatsmeow/state'), 'state route registered')
assert.ok(routes.has('/dsh-whatsmeow/action'), 'action route registered')
assert.ok(listeners.has('session/event'), 'session relay registered')

// The state route answers before pairing, and only GET reaches it.
await sleep(150)
let state = await callHandler('/dsh-whatsmeow/state')
assert.equal(state.status, 200)
assert.equal(state.body.process, 'running', 'sidecar reported running')
assert.equal(state.body.qr, null, 'no code before pairing starts')
assert.equal((await callHandler('/dsh-whatsmeow/state', { method: 'POST' })).status, 405)

// An unknown action is refused.
assert.equal(
  (await callHandler('/dsh-whatsmeow/action', { method: 'POST', body: JSON.stringify({ action: 'nope' }) })).status,
  400,
)

// Login surfaces a pairing code.
const login = await callHandler('/dsh-whatsmeow/action', { method: 'POST', body: JSON.stringify({ action: 'login' }) })
assert.equal(login.status, 200)
assert.equal(login.body.ok, true)
// Long enough for every scripted inbound message, the stranger included.
await sleep(300)
state = await callHandler('/dsh-whatsmeow/state')
assert.equal(state.body.state, 'qr')
assert.match(state.body.qr, /^data:image\/png;base64,/, 'pairing code reached the browser')

// Inbound text created one Session and reached its agent; echo and group stayed out.
assert.deepEqual(
  created,
  ['whatsapp-628222-s.whatsapp.net', 'whatsapp-628999-lid'],
  'one Session per chat, the LID stranger included while the allowlist is open',
)
assert.equal(followed.length, 2, 'echo and group stayed out; both real senders got through')
assert.equal(followed[0].message.content[0].text, 'halo dari wa')
assert.equal(followed[0].message.source.kind, 'user', 'inbound is a user-role prompt')
assert.equal(followed[0].message.role, 'user')

// Lock the allowlist to one number and confirm the other sender is dropped.
let allow = await callHandler('/dsh-whatsmeow/action', {
  method: 'POST',
  body: JSON.stringify({ action: 'allow', allow: { mode: 'list', numbers: ['628222'] } }),
})
assert.equal(allow.status, 200)
assert.deepEqual(allow.body.allow, { mode: 'list', numbers: ['628222'] }, 'the list is stored as digits')
state = await callHandler('/dsh-whatsmeow/state')
assert.deepEqual(state.body.allow, { mode: 'list', numbers: ['628222'] }, 'the panel sees the saved list')

// A malformed allowlist write is refused rather than silently resetting access.
assert.equal(
  (await callHandler('/dsh-whatsmeow/action', { method: 'POST', body: JSON.stringify({ action: 'allow', allow: {} }) })).status,
  400,
)

// The assistant text of the turn goes back to the chat that started it.
const relay = listeners.get('session/event')
const session = { id: 'whatsapp-628222-s.whatsapp.net' }
relay(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'halo juga' }] } } })
relay(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
await sleep(200)
assert.deepEqual(readSends(), [{ to: '628222@s.whatsapp.net', text: 'halo juga' }], 'reply reached WhatsApp')
state = await callHandler('/dsh-whatsmeow/state')
assert.deepEqual(
  state.body.chats,
  ['628222@s.whatsapp.net', '628999@lid'],
  'both chats bridged before the allowlist was locked are listed',
)

// Logout clears the bridge.
const logout = await callHandler('/dsh-whatsmeow/action', { method: 'POST', body: JSON.stringify({ action: 'logout' }) })
assert.equal(logout.status, 200)
await sleep(120)
state = await callHandler('/dsh-whatsmeow/state')
assert.deepEqual(state.body.chats, [], 'logout forgets bridged chats')
assert.equal(state.body.qr, null)

// A restart replaces the bridge process and clears the previous failure.
const restart = await callHandler('/dsh-whatsmeow/action', { method: 'POST', body: JSON.stringify({ action: 'restart' }) })
assert.equal(restart.status, 200)
await sleep(400)
state = await callHandler('/dsh-whatsmeow/state')
assert.equal(state.body.process, 'running', 'restart brought the bridge back')
assert.equal(state.body.error, null, 'restart cleared the stale error')

for (const dispose of disposers) dispose()
console.log('host plugin checks passed')

// The spawned fake sidecar keeps the loop alive; the assertions are done.
process.exit(0)
