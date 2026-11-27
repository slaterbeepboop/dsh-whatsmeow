#!/usr/bin/env node
// A locked allowlist must actually keep a stranger's message out of the agent.
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { apply } from '../index.js'

const FAKE = new URL('./fake-sidecar.mjs', import.meta.url).pathname
const SENT_LOG = new URL('./.sent.jsonl', import.meta.url).pathname
const STATE = new URL('./.state-allow', import.meta.url).pathname

rmSync(SENT_LOG, { force: true })
rmSync(STATE, { recursive: true, force: true })

const routes = new Map()
const created = []
const followed = []

const ctx = {
  webServer: { register: (route) => (routes.set(route.path, route.handler), () => {}) },
  connection: { requestRejection: () => undefined },
  on: () => () => {},
  effect: (fn) => fn(),
  get: () => undefined,
  agents: {
    get: () => undefined,
    async create({ sessionId }) {
      created.push(sessionId)
      return { agent: { followup: (message) => followed.push({ sessionId, text: message.content[0].text }) } }
    },
    async resume({ resumeSessionId }) {
      created.push(resumeSessionId)
      return { agent: { followup: (message) => followed.push({ sessionId: resumeSessionId, text: message.content[0].text }) } }
    },
  },
}

const call = (path, { method = 'GET', body = '' } = {}) => new Promise((resolve) => {
  const req = { method, headers: {}, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body) } }
  const res = {
    statusCode: 200,
    setHeader() {},
    end: (payload) => resolve({ status: res.statusCode, body: payload ? JSON.parse(payload) : null }),
  }
  void routes.get(path)(req, res)
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

apply(ctx, { stateDir: STATE, sidecarPath: FAKE, workspace: '/tmp' })
await sleep(100)

// Lock the list to the known chat before any message arrives.
const locked = await call('/dsh-whatsmeow/action', {
  method: 'POST',
  body: JSON.stringify({ action: 'allow', allow: { mode: 'list', numbers: ['+62 8222'] } }),
})
assert.equal(locked.status, 200)
assert.deepEqual(locked.body.allow, { mode: 'list', numbers: ['628222'] }, 'a typed number is normalised')

await call('/dsh-whatsmeow/action', { method: 'POST', body: JSON.stringify({ action: 'login' }) })
await sleep(400)

assert.deepEqual(created, ['whatsapp-628222-s.whatsapp.net'], 'only the allowed number reached a Session')
assert.deepEqual(followed, [{ sessionId: 'whatsapp-628222-s.whatsapp.net', text: 'halo dari wa' }])

// The blocked sender is reported rather than vanishing silently.
const state = await call('/dsh-whatsmeow/state')
assert.equal(state.body.blocked.length, 1, 'the ignored sender is recorded')
assert.match(state.body.blocked[0].sender, /628999/, 'the record names the ignored sender')

console.log('allowlist checks passed')
process.exit(0)
