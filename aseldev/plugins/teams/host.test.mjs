/**
 * Host-wiring tests for `host.ts`.
 *
 *   node --test --import tsx/esm aseldev/plugins/teams/host.test.mjs
 *
 * Drives the real `engine.mjs`, the real `defineTool`, and a real scoped Cordis
 * context (so `scopeOf` and the registry-derived filters execute). Only the
 * Cordis host surfaces are stand-ins.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'


// The BUILT entry: the shipped plugin is what a real profile loads.
// Run `node build.mjs` in this directory first.
const HOST = new URL('./lib/host.js', import.meta.url).href

/** What the stand-in registry reports as visible to the coordinator. */
const VISIBLE = [
  'read', 'read_image', 'glob', 'grep', 'web_search', 'brain_read', 'brain_search', 'ask_user_question', 'todo_write',
  'write', 'edit', 'bash', 'pwsh',
  'subagent', 'subagent_fork', 'send_message', 'list_agents', 'workflow', 'ralph', 'team_manage',
  'run_code',
]


/**
 * Build one plugin instance over stand-in host surfaces.
 * @param options - config overrides and test switches.
 * @returns handles the tests drive.
 */
async function harness(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'teams-host-'))
  const listeners = {}
  const registered = []
  const guards = []
  const routes = []
  const starts = []
  const logged = { info: [], warn: [] }
  const live = new Map()
  let seq = 0
  let release
  let releaseFollowup

  const subagents = {
    startContinuable(spec) {
      starts.push(spec)
      if (options.holdStart === true) {
        return new Promise((resolve) => {
          release = () => { seq += 1; resolve({ childId: `worker-${seq}`, messageId: `m-${seq}` }) }
        })
      }
      seq += 1
      return Promise.resolve({ childId: `worker-${seq}`, messageId: `m-${seq}` })
    },
    async followup(_parent, id, content) {
      starts.push({ followup: id, content })
      if (options.holdFollowup === true) {
        return new Promise((resolve) => { releaseFollowup = () => resolve('m-followup') })
      }
      return 'm-followup'
    },
    interrupt(id) { starts.push({ interrupt: id }) },
  }

  /** Prompt contexts the plugin registers; its scope capture rides the coordination one. */
  const contexts = []
  const systemPrompt = { context(entry) { contexts.push(entry); return () => {} } }

  const toolRuntime = {
    register(definition) { registered.push(definition); return () => {} },
    guard(fn) { guards.push(fn); return () => {} },
    schemas(view) {
      if (options.schemasThrow === true) throw new Error('visibility unavailable')
      assert.equal(view, live.get('coordinator'), 'the registry is asked with the exact Agent')
      return VISIBLE.map(name => ({ name }))
    },
  }
  const agents = { get: id => live.get(id) }
  const webServer = { register: route => { routes.push(route); return () => {} } }
  const disposers = []
  const ctx = {
    subagents,
    agents,
    webServer,
    get(service) {
      return {
        webServer,
        subagents,
        agents,
        tools: toolRuntime,
      }[service]
    },
    inject(_deps, callback) { callback({ ...this, tools: toolRuntime, systemPrompt }) },
    on(event, listener) { listeners[event] = listener; return () => {} },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose },
    logger: {
      info: (...args) => logged.info.push(args.join(' ')),
      warn: (...args) => logged.warn.push(args.join(' ')),
    },
  }
  live.set('coordinator', { id: 'coordinator', ctx: {} })

  const module = await import(HOST)
  await module.apply(ctx, { dir, maxActive: 2, maxLimit: 4, interruptWaitMs: 40, ...options.config })

  // Simulate the prompt assembly the coordinator's own turn performs: that is
  // where the harness hands the plugin the scope key a worker start needs.
  const coordination = contexts.find(entry => entry.name === 'teams:coordination')

  const tool = registered[0]
  assert.ok(tool !== undefined, 'team_manage registered')
  const coordinator = { agent: { id: 'coordinator' }, signal: new AbortController().signal }
  const tick = () => new Promise(r => setImmediate(r))

  return {
    dir,
    ctx,
    tool,
    guards,
    routes,
    starts,
    logged,
    live,
    coordinator,
    tick,
    release: () => release?.(),
    releaseFollowup: () => releaseFollowup?.(),
    /** Claim one message for an agent, as the loop would. */
    claim(agentId, messages) {
      return listeners['agent/pre-step']({ agent: { id: agentId } }, async () => ({ kind: 'enter', messages }))
    },
    decide(agentId, decision) {
      return listeners['agent/pre-step']({ agent: { id: agentId } }, async () => decision)
    },
    end(workerId, stopReason = 'completed', text = 'done') {
      listeners['subagent/end']({ id: workerId, stopReason, lastAssistantMessage: [{ type: 'text', text }] })
    },
    status: async () => (await tool.execute({ action: 'status' }, coordinator)).team.tasks[0],
    coordination,
    stop: async () => { for (const dispose of [...disposers].reverse()) await dispose() },
    dispose() { rmSync(dir, { recursive: true, force: true }) },
  }
}

/** Coordinator-scheduled wake, as the adapter admits it. */
const scheduled = id => [{ id, source: { kind: 'user' } }]
/** A message a person typed into the teammate's own composer. */
const typed = () => [{ id: 'typed-by-hand', source: { kind: 'user' } }]

async function started(h) {
  await h.tool.execute({ action: 'save_specialist', specialist: { id: 'builder', name: 'Builder', mode: 'write', instructions: 'Build.' } }, h.coordinator)
  await h.tool.execute({ action: 'assign', specialistId: 'builder', title: 'Do X', prompt: 'Implement it.', files: ['src/a'] }, h.coordinator)
  await h.tick(); await h.tick()
  const task = await h.status()
  if (task.workerId !== undefined) h.live.set(task.workerId, { id: task.workerId, ctx: {} })
  return task
}

test('the store is written to the documented state.json', async (t) => {
  const h = await harness()
  t.after(() => h.dispose())
  assert.ok(existsSync(join(h.dir, 'state.json')), 'engine.mjs owns <dir>/state.json')
})

test('an unmapped teammate is allowed through the creation window', async (t) => {
  const h = await harness({ holdStart: true })
  t.after(() => h.dispose())
  await h.tool.execute({ action: 'save_specialist', specialist: { id: 'builder', name: 'Builder', mode: 'write', instructions: 'Build.' } }, h.coordinator)
  await h.tool.execute({ action: 'assign', specialistId: 'builder', title: 'First', prompt: 'Implement it.', files: ['src/a'] }, h.coordinator)
  await h.tick()
  const task = await h.status()
  assert.equal(task.status, 'starting')
  assert.equal(task.workerId, undefined, 'the id is not published yet')
  assert.equal((await h.claim('worker-1', typed())).kind, 'enter', 'an unmapped id passes; filters already apply')
  h.release()
  await h.tick(); await h.tick()
  assert.equal((await h.status()).workerId, 'worker-1')
})

test('only the scheduler may wake a working teammate', async (t) => {
  const h = await harness()
  t.after(() => h.dispose())
  const task = await started(h)
  assert.equal(task.status, 'working')
  assert.equal((await h.claim(task.workerId, scheduled('m-1'))).kind, 'enter', 'an admitted id passes')
  assert.deepEqual(await h.claim(task.workerId, typed()), { kind: 'reject' }, 'a hand-typed message is refused')
  assert.deepEqual(
    await h.claim(task.workerId, [{ id: 'msg-from-send-message', source: { kind: 'coordinator', form: 'relay' } }]),
    { kind: 'reject' },
    'a coordinator send_message does not bypass the scheduler',
  )
  assert.equal((await h.claim(task.workerId, [{ id: 'ctx', source: { kind: 'plugin', plugin: 'x' } }])).kind, 'enter', 'injected context passes')
  assert.equal((await h.claim(task.workerId, [])).kind, 'enter', 'a tool-owed continuation passes')
})

test('a settled teammate refuses every wake, whatever its source', async (t) => {
  const h = await harness()
  t.after(() => h.dispose())
  const task = await started(h)
  h.end(task.workerId, 'completed', 'changed src/a')
  await h.tick()
  assert.equal((await h.status()).status, 'done')
  assert.deepEqual(await h.claim(task.workerId, typed()), { kind: 'reject' })
  assert.deepEqual(await h.claim(task.workerId, scheduled('m-1')), { kind: 'reject' })
  assert.ok(h.logged.warn.some(w => w.includes('Team panel') && w.includes('path reservations')))
})

test('a stopping teammate is refused', async (t) => {
  const h = await harness()
  t.after(() => h.dispose())
  const task = await started(h)
  await h.tool.execute({ action: 'cancel', taskId: task.id }, h.coordinator)
  const after = await h.status()
  assert.ok(after.status === 'canceling' || after.status === 'canceled')
  assert.deepEqual(await h.claim(task.workerId, typed()), { kind: 'reject' })
})

test('unrelated agents and coordinators are untouched, and an upstream reject passes through', async (t) => {
  const h = await harness()
  t.after(() => h.dispose())
  await started(h)
  assert.equal((await h.claim('coordinator', typed())).kind, 'enter')
  assert.equal((await h.claim('never-heard-of-it', typed())).kind, 'enter')
  assert.deepEqual(await h.decide('worker-1', { kind: 'reject' }), { kind: 'reject' })
})

test('the guard refuses delegation for a worker and leaves the coordinator free', async (t) => {
  const h = await harness()
  t.after(() => h.dispose())
  const task = await started(h)
  const guard = h.guards[0]
  for (const name of ['subagent', 'subagent_fork', 'workflow', 'ralph', 'team_manage', 'subagent_codex', 'send_message', 'interrupt_agent', 'list_agents']) {
    assert.match(guard({ name, agent: { id: task.workerId } }), /Refused/, `${name} is refused for a worker`)
  }
  assert.equal(guard({ name: 'subagent', agent: { id: 'coordinator' } }), undefined, 'the coordinator may delegate')
  assert.equal(guard({ name: 'write', agent: { id: task.workerId } }), undefined, 'a writer keeps mutation tools')
})

test('a read worker is confined to its computed allow-list', async (t) => {
  const h = await harness()
  t.after(() => h.dispose())
  await h.tool.execute({ action: 'save_specialist', specialist: { id: 'reviewer', name: 'Reviewer', mode: 'read', instructions: 'Review.' } }, h.coordinator)
  await h.tool.execute({ action: 'assign', specialistId: 'reviewer', title: 'Review', prompt: 'Review it.' }, h.coordinator)
  await h.tick(); await h.tick()
  const spec = h.starts[0]
  assert.deepEqual([...spec.request.toolFilter.allow].sort(),
    ['ask_user_question', 'brain_read', 'brain_search', 'glob', 'grep', 'read', 'read_image', 'todo_write', 'web_search'])
  assert.ok(!spec.request.toolFilter.allow.includes('run_code'), 'the Code Mode transport is never named')

  const task = await h.status()
  const guard = h.guards[0]
  assert.equal(guard({ name: 'read', agent: { id: task.workerId } }), undefined, 'an allowed tool passes')
  assert.equal(guard({ name: 'report', agent: { id: task.workerId } }), undefined, 'the child-scoped report tool passes')
  for (const name of ['write', 'bash', 'edit', 'pwsh', 'web_fetch']) {
    assert.match(guard({ name, agent: { id: task.workerId } }), /read-only/, `${name} is outside the allow-list`)
  }
})

test('the write filter denies the registry-visible delegation names', async (t) => {
  const h = await harness()
  t.after(() => h.dispose())
  await started(h)
  const deny = h.starts[0].request.toolFilter.deny
  assert.deepEqual([...deny].sort(), ['list_agents', 'ralph', 'send_message', 'subagent', 'subagent_fork', 'team_manage', 'workflow'])
})

test('an underivable filter fails the assignment loudly', async (t) => {
  const h = await harness({ schemasThrow: true })
  t.after(() => h.dispose())
  const task = await started(h)
  assert.equal(task.status, 'failed')
  assert.match(String(task.error), /cannot report visibility|cannot be restricted/)
})

test('a claim waits for the delivery whose id has not been returned yet', async (t) => {
  const h = await harness({ holdFollowup: true })
  t.after(() => h.dispose())
  const task = await started(h)
  h.end(task.workerId, 'completed', 'first pass done')
  await h.tick()

  // `message` re-queues the task; pump sets `starting` and calls followup, which
  // is held open, so the id is not admitted yet.
  await h.tool.execute({ action: 'message', taskId: task.id, message: 'Check the edge case.' }, h.coordinator)
  await h.tick()
  assert.equal((await h.status()).status, 'starting')

  // The loop may claim the delivered message before `followup` returns its id.
  let settled = false
  const claim = h.claim(task.workerId, [{ id: 'm-followup', source: { kind: 'coordinator', form: 'relay' } }])
  claim.then(() => { settled = true }, () => { settled = true })
  await h.tick()
  assert.equal(settled, false, 'the claim waits instead of being judged unscheduled')

  h.releaseFollowup()
  assert.equal((await claim).kind, 'enter', 'the id arrives and the claim proceeds')
})

test('a cancellation during message admission invalidates the waiting claim', async t => {
  const h = await harness({ holdFollowup: true })
  t.after(() => h.dispose())
  const task = await started(h)
  h.end(task.workerId)
  await h.tick()
  await h.tool.execute({ action: 'message', taskId: task.id, message: 'Check again.' }, h.coordinator)
  await h.tick()
  const claim = h.claim(task.workerId, scheduled('m-followup'))
  await h.tick()
  await h.tool.execute({ action: 'cancel', taskId: task.id }, h.coordinator)
  h.releaseFollowup()
  assert.equal((await claim).kind, 'reject')
  h.end(task.workerId, 'aborted')
  await h.tick()
})

test('settled workers and late-added forbidden tools are denied through the guard', async t => {
  const h = await harness({ config: { delegationTools: ['future_tool'] } })
  t.after(() => h.dispose())
  const task = await started(h)
  const execution = { agent: { id: task.workerId }, name: 'future_tool' }
  assert.match(h.guards[0](execution), /disabled/)
  h.end(task.workerId)
  await h.tick()
  assert.match(h.guards[0]({ ...execution, name: 'write' }), /not accepting/)
})

test('closing rejects new work while retaining injected capabilities until workers are quiet', async t => {
  const h = await harness()
  t.after(() => h.dispose())
  const task = await started(h)
  let release
  h.live.set(task.workerId, { id: task.workerId, whenIdle: () => new Promise(resolve => { release = resolve }) })
  h.ctx.subagents = undefined
  h.ctx.agents = undefined
  const stopping = h.stop()
  await h.tick()
  assert.equal(typeof release, 'function', 'teardown retained the injected agent registry')
  assert.match(h.guards[0]({ agent: { id: task.workerId }, name: 'write' }), /not accepting/)
  assert.equal((await h.claim(task.workerId, scheduled('m-1'))).kind, 'reject')
  release()
  await stopping
  assert.ok(h.starts.some(s => s.interrupt === task.workerId))
})

test('inherit mode still delivers the specialist role', async (t) => {
  const h = await harness({ config: { personaMode: 'inherit' } })
  t.after(() => h.dispose())
  await started(h)
  const spec = h.starts[0]
  assert.equal(spec.request.persona, undefined, 'no persona is sent')
  const prompt = spec.request.prompt[0].text
  assert.match(prompt, /Build\./, 'the instructions ride the prompt instead')
  assert.match(prompt, /cannot delegate, message other agents/)
})

test('interrupt waits for quiescence and is bounded', async (t) => {
  const h = await harness()
  t.after(() => h.dispose())
  const task = await started(h)
  let quiet = 0
  h.live.set(task.workerId, { id: task.workerId, ctx: {}, whenIdle: async () => { quiet += 1 } })
  await h.tool.execute({ action: 'cancel', taskId: task.id }, h.coordinator)
  assert.equal(quiet, 1, 'the adapter awaited the worker')

  h.live.set(task.workerId, { id: task.workerId, ctx: {}, whenIdle: async () => new Promise(() => {}) })
  h.end(task.workerId, 'aborted')
  await h.tick()
  await h.tool.execute({ action: 'retry', taskId: task.id }, h.coordinator)
  await h.tick(); await h.tick()
  const began = Date.now()
  await h.tool.execute({ action: 'cancel', taskId: task.id }, h.coordinator).catch(() => {})
  assert.ok(Date.now() - began >= 35, 'it waited for the bound')
  assert.ok(h.logged.warn.some(w => w.includes('did not become quiet')))
})

test('disposal awaits the store teardown', async (t) => {
  const h = await harness()
  t.after(() => h.dispose())
  await started(h)
  const module = await import(HOST)
  // A second instance, so its disposer can be driven without disturbing `h`.
  const dir = mkdtempSync(join(tmpdir(), 'teams-host-dispose-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let disposeResult
  const ctx = {
    subagents: { interrupt() {} },
    agents: { get() { return undefined } },
    webServer: { register() { return () => {} } },
    get: () => undefined,
    inject() {},
    on() {},
    effect(fn) { disposeResult = fn(); return () => {} },
    logger: { info() {}, warn() {} },
  }
  await module.apply(ctx, { dir })
  assert.equal(typeof disposeResult, 'function', 'the effect body returns a disposer')
  await disposeResult()
  assert.ok(existsSync(join(dir, 'state.json')), 'the store flushed before the disposer settled')
})

test('apply rejects instead of mounting a broken plugin', async () => {
  const module = await import(HOST)
  const bad = []
  const base = { get: () => undefined, inject() {}, on() {}, effect() { return () => {} }, logger: { info() {}, warn() {} } }
  for (const config of [{ maxActive: 0 }, { maxActive: 9, maxLimit: 4 }, { maxLimit: 5000 }, { personaMode: 'x' }, { readTools: [] }, { provider: '' }, { interruptWaitMs: -1 }]) {
    await assert.rejects(module.apply(base, { dir: tmpdir(), ...config }), /aseldev-teams:/, JSON.stringify(config))
  }
  // An unusable store directory must reject, not warn.
  const file = join(mkdtempSync(join(tmpdir(), 'teams-host-bad-')), 'not-a-dir')
  writeFileSync(file, 'x')
  await assert.rejects(module.apply(base, { dir: file }))
  bad.push(file)
  for (const path of bad) rmSync(path, { force: true })
})

test('the coordination instruction is registered for every assembly', async (t) => {
  const h = await harness()
  t.after(() => h.dispose())
  assert.equal(h.coordination?.name, 'teams:coordination')
  assert.equal(typeof h.coordination?.text, 'string')
  assert.equal(
    h.coordination.text,
    'For multi-agent work in ordinary coordinator conversations, use team_manage and saved specialists rather than ad hoc delegation; start with status; declare file scopes; report actual checks. Team workers only execute own assignment.',
  )
})
test('caller instructions never enter the persona template', async (t) => {
  const h = await harness()
  t.after(() => h.dispose())
  await h.tool.execute({ action: 'save_specialist', specialist: { id: 'lit', name: 'Lit', mode: 'write', instructions: 'Literal {{placeholder}} must survive.' } }, h.coordinator)
  await h.tool.execute({ action: 'assign', specialistId: 'lit', title: 'Template', prompt: 'Do it.', files: ['a.txt'] }, h.coordinator)
  await h.tick(); await h.tick()
  const spec = h.starts[0]
  assert.equal(spec.request.persona.includes('{{'), false, 'the persona carries no caller text')
  assert.match(spec.request.prompt[0].text, /\{\{placeholder\}\}/)
})
test('the stored worker result stays inside its bound, marker included', async (t) => {
  const LIMIT = 8000
  const cases = [
    ['tiny', 'x'.repeat(7)],
    ['exact', 'x'.repeat(LIMIT)],
    ['one over', 'x'.repeat(LIMIT + 1)],
    ['far over', 'x'.repeat(LIMIT * 3)],
  ]
  for (const [name, text] of cases) {
    const h = await harness()
    try {
      const task = await started(h)
      h.end(task.workerId, 'completed', text)
      await h.tick()
      const result = (await h.status()).result || ''
      assert.ok(result.length <= LIMIT, name + ': ' + result.length + ' exceeds ' + LIMIT)
      if (text.length <= LIMIT) {
        assert.equal(result, text, name + ' is stored unchanged')
      } else {
        assert.equal(result.length, LIMIT, name + ' fills the bound exactly, marker included')
        assert.match(result, /\[truncated\]$/, name + ' is marked as truncated')
      }
    } finally {
      h.dispose()
    }
  }
})