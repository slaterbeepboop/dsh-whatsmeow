#!/usr/bin/env node
// A chat whose Session was persisted by an earlier run must resume, not fail:
// otherwise every existing chat goes silent after a DSH restart.
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { apply } from '../index.js'

const FAKE = new URL('./fake-sidecar.mjs', import.meta.url).pathname
const SENT_LOG = new URL('./.sent.jsonl', import.meta.url).pathname
const STATE = new URL('./.state-resume', import.meta.url).pathname

rmSync(SENT_LOG, { force: true })
rmSync(STATE, { recursive: true, force: true })

const routes = new Map()
const events = []

const ctx = {
  webServer: { register: (route) => (routes.set(route.path, route.handler), () => {}) },
  connection: { requestRejection: () => undefined },
  on: () => () => {},
  effect: (fn) => fn(),
  agents: {
    get: () => undefined,
    async create() {
      // The store already owns this id, exactly as after a DSH restart.
      throw new Error('session already exists')
    },
    async resume({ resumeSessionId }) {
      events.push(['resume', resumeSessionId])
      return { agent: { followup: (message) => events.push(['followup', message.content[0].text]) } }
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
await call('/dsh-whatsmeow/action', { method: 'POST', body: JSON.stringify({ action: 'login' }) })
await sleep(200)

assert.deepEqual(events, [
  ['resume', 'whatsapp-628222-s.whatsapp.net'],
  ['followup', 'halo dari wa'],
], 'a persisted chat resumes and still receives the message')

console.log('resume path checks passed')

// The spawned fake sidecar keeps the loop alive; the assertions are done.
process.exit(0)
