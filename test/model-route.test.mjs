#!/usr/bin/env node
// A chat whose Session was persisted before this plugin knew about models must
// still get a route when it resumes, or every turn fails with
// "has no provider/model".
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { apply } from '../index.js'

const FAKE = new URL('./fake-sidecar.mjs', import.meta.url).pathname
const SENT_LOG = new URL('./.sent.jsonl', import.meta.url).pathname
const STATE = new URL('./.state-model', import.meta.url).pathname

rmSync(SENT_LOG, { force: true })
rmSync(STATE, { recursive: true, force: true })

const ROUTE = { provider: 'sinarcloud', model: 'deepseek/deepseek-v4-1-flash' }
const routes = new Map()
const seen = []

/** Stand-in agent: records what the plugin asked of it. */
function fakeAgent() {
  let selection
  return {
    model: {
      current: () => selection,
      select: (next) => { selection = { ...next }; seen.push(['select', selection]) },
    },
    followup: (message) => seen.push(['followup', message.content[0].text]),
  }
}

const ctx = {
  webServer: { register: (route) => (routes.set(route.path, route.handler), () => {}) },
  connection: { requestRejection: () => undefined },
  on: () => () => {},
  effect: (fn) => fn(),
  get: (name) => (name === 'agentDefaultModel' ? { currentSelection: () => ({ ...ROUTE }) } : undefined),
  agents: {
    get: () => undefined,
    async create() {
      throw new Error('session already exists')
    },
    async resume({ resumeSessionId, agentOptions, setup }) {
      seen.push(['resume', resumeSessionId, agentOptions])
      const agent = fakeAgent()
      // The loop awaits setup before the agent is published.
      if (setup !== undefined) await setup({}, agent)
      return { agent }
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
await sleep(400)

const resumed = seen.filter((entry) => entry[0] === 'resume')
assert.ok(resumed.length > 0, 'the persisted chat resumed')
for (const [, , agentOptions] of resumed) {
  assert.deepEqual(agentOptions, ROUTE, 'resume carries the default route')
}

const selected = seen.filter((entry) => entry[0] === 'select')
assert.ok(selected.length > 0, 'the resumed Session recorded a model selection')
assert.deepEqual(selected[0][1], ROUTE, 'the recorded selection is the deployment default')

// The message still reaches the agent after the route is fixed.
const followed = seen.filter((entry) => entry[0] === 'followup')
assert.ok(followed.length > 0, 'the message was delivered')

// A Session the person already drove in the GUI has a recorded selection, and
// that choice must survive: the plugin only fills in an unset route.
const guiPick = { provider: 'sinarcloud', model: 'deepseek/deepseek-v4-1-flash-uncensored' }
const second = new Map()
seen.length = 0
const ctx2 = {
  ...ctx,
  webServer: { register: (route) => (second.set(route.path, route.handler), () => {}) },
  agents: {
    get: () => undefined,
    async create() { throw new Error('session already exists') },
    async resume({ setup }) {
      let selection = { ...guiPick }
      const agent = {
        model: { current: () => selection, select: (next) => { selection = { ...next }; seen.push(['overwrite', selection]) } },
        followup: () => {},
      }
      if (setup !== undefined) await setup({}, agent)
      return { agent }
    },
  },
}
const call2 = (path, { method = 'GET', body = '' } = {}) => new Promise((resolve) => {
  const req = { method, headers: {}, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body) } }
  const res = { statusCode: 200, setHeader() {}, end: (payload) => resolve({ body: payload ? JSON.parse(payload) : null }) }
  void second.get(path)(req, res)
})
apply(ctx2, { stateDir: `${STATE}-gui`, sidecarPath: FAKE, workspace: '/tmp' })
await sleep(100)
await call2('/dsh-whatsmeow/action', { method: 'POST', body: JSON.stringify({ action: 'login' }) })
await sleep(400)
assert.deepEqual(seen.filter((entry) => entry[0] === 'overwrite'), [], 'a recorded GUI choice is not overwritten')

console.log('model route checks passed')
process.exit(0)
