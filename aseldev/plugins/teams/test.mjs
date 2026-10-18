/**
 * Focused tests for the teams browser half.
 *
 * The bundle is loaded the way the dsh web shell loads it — a classic script
 * calling `window.__ModuleLoader__.load({ id, factory })` whose `require`
 * answers only the shared platform table — so these assertions cover the
 * artifact as shipped, not the sources.
 *
 * Scope: the plugin surface (id, exports, dictionaries, the
 * `sidebar.launcher` registration and its injected face), worker navigation
 * (`openSubagent` through a durable address, never a bare `open`), the strict
 * wire parser, the transport, the pure derivations, and server-rendered smoke
 * tests of the real components in both locales using the repository's React
 * (skipped when that React is not installed).
 *
 * Usage: `node --test aseldev/plugins/teams/test.mjs` (after `node build.mjs`).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const artifact = join(here, 'lib', 'client.js')
const ID = '@aseldev/dsh-teams'
const NS = 'aseldev.teams'

// --- load the bundle exactly as the shell does ------------------------------

const source = readFileSync(artifact, 'utf8')

/** Minimal React surface: the bundle requires it and calls only hooks/elements at render time. */
const reactStub = new Proxy({}, {
  get: (_target, key) => (key === 'Fragment' ? Symbol.for('react.fragment') : () => undefined),
})

/** Primitives the bundle destructures at load: every name must exist. */
const primitivesStub = {
  StateDot: () => undefined,
  Button: () => undefined,
  Input: () => undefined,
  Pill: () => undefined,
  Tooltip: ({ children }) => children,
  useDismissOnOutsidePointer: () => undefined,
  IconCheckOutline14: () => undefined,
  IconChecklistOutline14: () => undefined,
  IconCloseOutline16: () => undefined,
  IconPlayOutline16: () => undefined,
  IconPlusOutline16: () => undefined,
  IconRefreshOutline16: () => undefined,
  IconSendOutline16: () => undefined,
  IconStopFill16: () => undefined,
  IconUserOutline16: () => undefined,
}

const baseTable = {
  react: reactStub,
  'react/jsx-runtime': { jsx: () => undefined, jsxs: () => undefined, Fragment: Symbol.for('react.fragment') },
  '@deepseek-ai/dsh-client-ui-primitives': primitivesStub,
}

/** Load one fresh bundle instance over a module table. */
function loadBundle(table) {
  const handoffs = []
  const win = { __ModuleLoader__: { load: (handoff) => void handoffs.push(handoff) } }
  new Function('window', source)(win)
  assert.equal(handoffs.length, 1, 'the bundle must register exactly one factory')
  const requested = new Set()
  const plugin = handoffs[0].factory((specifier) => {
    requested.add(specifier)
    if (!(specifier in table)) throw new Error(`client-modules: require("${specifier}") missed the module table`)
    return table[specifier]
  })
  return { handoff: handoffs[0], plugin, requested }
}

const { handoff: firstHandoff, plugin, requested } = loadBundle(baseTable)

/** English translate built from the shipped dictionary (the shell's seat does the same). */
const enTranslate = (key, params) => (plugin.en[key] ?? key).replace(/\{(\w+)\}/g, (m, name) => String(params?.[name] ?? m))

// --- plugin surface --------------------------------------------------------

await test('bundle registers the package name as its id', () => {
  assert.equal(firstHandoff.id, ID)
})

await test('bundle requires only the shared platform table', () => {
  assert.deepEqual([...requested].sort(), [
    '@deepseek-ai/dsh-client-ui-primitives',
    'react',
    'react/jsx-runtime',
  ])
})

await test('plugin exports apply, inject, the namespace, and its dictionaries', () => {
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual([...plugin.inject], ['slots', 'sessions', 'locale'])
  assert.equal(plugin.TEAMS_NS, NS)
  assert.equal(typeof plugin.zh, 'object')
  assert.equal(typeof plugin.en, 'object')
})

await test('zh and en dictionaries carry exactly the same keys', () => {
  const zhKeys = Object.keys(plugin.zh).sort()
  const enKeys = Object.keys(plugin.en).sort()
  assert.deepEqual(enKeys, zhKeys)
  assert.ok(zhKeys.length > 40, 'the panel copy is one dictionary, not scattered literals')
  for (const key of zhKeys) {
    assert.notEqual(plugin.zh[key], '', `zh.${key} is empty`)
    assert.notEqual(plugin.en[key], '', `en.${key} is empty`)
  }
})

await test('zhTranslate interpolates template params and falls back to the key', () => {
  assert.equal(plugin.zhTranslate('tasks.limit', { value: '2 / 8' }), '并行上限 2 / 8')
  assert.equal(plugin.zhTranslate('panel.missing.key'), 'panel.missing.key')
  assert.equal(plugin.zhTranslate('panel.title', { unused: 1 }), '团队')
})

await test('the parallel-limit field never advertises a guessed number', () => {
  // The deployment default is host configuration (3 in this deployment, not 1),
  // so a team that does not exist yet must say "host default" instead.
  assert.equal(plugin.zh['configure.hostDefault'], '宿主默认值')
  assert.equal(plugin.en['configure.hostDefault'], 'Host default')
  assert.equal('configure.placeholder' in plugin.zh, false, 'the hard-coded "1" placeholder is gone')
  assert.equal('configure.placeholder' in plugin.en, false)
})

// --- apply: registrations, dictionaries, injected face ---------------------

/** A fake client context recording every registration the plugin makes. */
function fakeContext({ retainedAddress = undefined, refreshRejects = false } = {}) {
  const calls = {
    locale: [],
    injectedSlots: [],
    opened: [],
    openedSubagent: [],
    refreshed: [],
  }
  const ctx = {
    slots: {
      inject(name, callback) {
        calls.injectedSlots.push(name)
        calls.registrationEffect = callback()
        return () => {}
      },
      register(options, component) {
        calls.registerOptions = options
        calls.component = component
        return () => {}
      },
    },
    sessions: {
      open(sessionId) {
        calls.opened.push(sessionId)
      },
      openSubagent(address) {
        calls.openedSubagent.push(address)
      },
      subagentAddress(sessionId) {
        return sessionId === 'worker-with-address' ? retainedAddress : undefined
      },
      async refreshSubagents(parentSessionId) {
        calls.refreshed.push(parentSessionId)
        if (refreshRejects) throw new Error('catalog refresh failed')
      },
    },
    locale: {
      register(namespace, dictionaries) {
        calls.locale.push({ namespace, dictionaries })
        return () => {}
      },
      bind(namespace) {
        calls.bound = namespace
        return plugin.zhTranslate
      },
    },
    effect(callback) {
      calls.effectDisposer = callback()
      return () => {}
    },
  }
  return { ctx, calls }
}

await test('apply registers its dictionaries under one namespace', () => {
  const { ctx, calls } = fakeContext()
  plugin.apply(ctx)
  assert.equal(calls.locale.length, 1)
  assert.equal(calls.locale[0].namespace, NS)
  assert.deepEqual(calls.locale[0].dictionaries, { zh: plugin.zh, en: plugin.en })
  assert.equal(calls.bound, NS, 'the translate seat binds the same namespace')
})

await test('apply contributes one sidebar.launcher entry with its locale seat', () => {
  const { ctx, calls } = fakeContext()
  plugin.apply(ctx)
  assert.deepEqual(calls.injectedSlots, ['sidebar.launcher'])
  const options = calls.registerOptions
  assert.equal(options.name, 'sidebar.launcher')
  assert.equal(options.id, 'teams')
  assert.equal(options.order, 20)
  assert.equal(options.locale, NS)
  assert.equal(typeof calls.component, 'function')
  const face = options.inject()
  assert.equal(typeof face.api.state, 'function')
  assert.equal(typeof face.api.action, 'function')
  assert.equal(typeof face.openSession, 'function')
  assert.equal(typeof face.openWorker, 'function')
  assert.equal(face.t, undefined, 'the framework locale seat supplies `t`, not the inject face')
})

await test('openSession opens an ordinary session through the runtime', async () => {
  const { ctx, calls } = fakeContext()
  plugin.apply(ctx)
  await calls.registerOptions.inject().openSession('coordinator-1')
  assert.deepEqual(calls.opened, ['coordinator-1'])
})

await test('openWorker opens a continuable child through openSubagent, never a bare open', async () => {
  const { ctx, calls } = fakeContext()
  plugin.apply(ctx)
  await calls.registerOptions.inject().openWorker('coordinator-1', 'worker-9')
  assert.deepEqual(calls.opened, [], 'a subagent child must not go through sessions.open')
  assert.deepEqual(calls.openedSubagent, [
    { parentSessionId: 'coordinator-1', childSessionId: 'worker-9', mode: 'continuable' },
  ])
  assert.deepEqual(calls.refreshed, ['coordinator-1'], 'the child catalog is made authoritative first')
})

await test('openWorker reuses an address the runtime already retained', async () => {
  const retained = { parentSessionId: 'coordinator-1', childSessionId: 'worker-with-address', mode: 'continuable' }
  const { ctx, calls } = fakeContext({ retainedAddress: retained })
  plugin.apply(ctx)
  await calls.registerOptions.inject().openWorker('coordinator-1', 'worker-with-address')
  assert.deepEqual(calls.openedSubagent, [retained])
  assert.deepEqual(calls.refreshed, [], 'a retained address needs no refresh')
  assert.deepEqual(calls.opened, [])
})

await test('openWorker surfaces a catalog-refresh failure instead of opening blindly', async () => {
  const { ctx, calls } = fakeContext({ refreshRejects: true })
  plugin.apply(ctx)
  await assert.rejects(calls.registerOptions.inject().openWorker('coordinator-1', 'worker-9'), /catalog refresh failed/)
  assert.deepEqual(calls.openedSubagent, [], 'no address is opened after a failed refresh')
})

await test('workerOpenPlan prefers a retained address and otherwise reconstructs one', () => {
  const retained = { parentSessionId: 'p', childSessionId: 'c', mode: 'one-shot' }
  assert.deepEqual(plugin.workerOpenPlan('p', 'c', retained), { address: retained, refreshParent: false })
  assert.deepEqual(plugin.workerOpenPlan('p', 'c', undefined), {
    address: { parentSessionId: 'p', childSessionId: 'c', mode: 'continuable' },
    refreshParent: true,
  })
})

// --- wire boundary ---------------------------------------------------------

const {
  parseSnapshot, statusMeta, statusText, summarise, parseList, validateAssign,
  createTeamsApi, TeamsApiError, SnapshotError,
} = plugin

/** A complete, contract-shaped `state` answer. */
function validPayload() {
  return {
    specialists: [
      { id: 'builder', name: 'Builder', instructions: 'build it', mode: 'write' },
      { id: 'reviewer', name: 'Reviewer', instructions: 'review it', mode: 'read' },
    ],
    team: {
      sessionId: 's1',
      maxActive: 2,
      paused: false,
      tasks: [
        {
          id: 'task-1', specialistId: 'builder', title: 'Fix', prompt: 'p', status: 'working',
          // The host records the assignment-time role on every task, instructions included.
          specialist: { id: 'builder', name: 'Builder', mode: 'write', instructions: 'SECRET-INSTRUCTIONS' },
          workerId: 'w1', files: ['src/auth'], dependsOn: [], result: 'ok',
        },
        {
          id: 'task-2', specialistId: 'reviewer', title: 'Review', prompt: 'p', status: 'done',
          files: [], dependsOn: ['task-1'],
        },
      ],
    },
    coordinators: [{ sessionId: 's1', label: 'Login team' }],
    maxLimit: 8,
  }
}

await test('parseSnapshot reads a complete answer', () => {
  const snapshot = parseSnapshot(validPayload())
  assert.equal(snapshot.specialists.length, 2)
  assert.equal(snapshot.specialists[0].mode, 'write')
  assert.equal(snapshot.maxLimit, 8)
  assert.equal(snapshot.team.maxActive, 2)
  assert.equal(snapshot.team.paused, false)
  assert.equal(snapshot.team.tasks.length, 2)
  assert.deepEqual(snapshot.team.tasks[0].files, ['src/auth'])
  assert.equal(snapshot.team.tasks[0].workerId, 'w1')
  assert.deepEqual(snapshot.coordinators, [{ sessionId: 's1', label: 'Login team' }])
})

await test('parseSnapshot keeps the assignment-time role copy and drops its instructions', () => {
  const snapshot = parseSnapshot(validPayload())
  const role = snapshot.team.tasks[0].specialist
  assert.deepEqual(role, { id: 'builder', name: 'Builder', mode: 'write' })
  assert.equal('instructions' in role, false, 'the browser side never carries the role instructions')
  // A task stored before the host sent the copy simply omits it.
  assert.equal(snapshot.team.tasks[1].specialist, undefined)
})

await test('parseSnapshot rejects a malformed role copy when the host sends one', () => {
  const badMode = validPayload()
  badMode.team.tasks[0].specialist.mode = 'owner'
  assert.throws(() => parseSnapshot(badMode), /team\.tasks\[0\]\.specialist\.mode/)

  const missingName = validPayload()
  delete missingName.team.tasks[0].specialist.name
  assert.throws(() => parseSnapshot(missingName), /team\.tasks\[0\]\.specialist\.name/)

  const notAnObject = validPayload()
  notAnObject.team.tasks[0].specialist = 'builder'
  assert.throws(() => parseSnapshot(notAnObject), /team\.tasks\[0\]\.specialist/)
})

await test('parseSnapshot accepts a session with no team yet', () => {
  const snapshot = parseSnapshot({ specialists: [], team: null, coordinators: [] })
  assert.equal(snapshot.team, null)
  assert.equal(snapshot.maxLimit, undefined)
})

await test('parseSnapshot keeps an unknown status as its literal (forward compatible)', () => {
  const payload = validPayload()
  payload.team.tasks[0].status = 'paused-by-host'
  const snapshot = parseSnapshot(payload)
  assert.equal(snapshot.team.tasks[0].status, 'paused-by-host')
  assert.equal(statusText('paused-by-host', plugin.zhTranslate), 'paused-by-host')
})

await test('parseSnapshot defaults an absent paused flag to false', () => {
  const payload = validPayload()
  delete payload.team.paused
  assert.equal(parseSnapshot(payload).team.paused, false)
})

/** Each case removes or corrupts one required field. */
const malformedCases = [
  ['non-object body', () => null, /body/],
  ['missing specialists', (p) => { delete p.specialists }, /specialists/],
  ['specialists not an array', (p) => { p.specialists = {} }, /specialists/],
  ['specialist without an id', (p) => { delete p.specialists[0].id }, /specialists\[0\]\.id/],
  ['specialist with an unknown mode', (p) => { p.specialists[0].mode = 'owner' }, /specialists\[0\]\.mode/],
  ['specialist without a name', (p) => { delete p.specialists[0].name }, /specialists\[0\]\.name/],
  ['specialist without instructions', (p) => { delete p.specialists[0].instructions }, /specialists\[0\]\.instructions/],
  ['missing team key', (p) => { delete p.team }, /team/],
  ['team not an object', (p) => { p.team = 'none' }, /team/],
  ['team without maxActive', (p) => { delete p.team.maxActive }, /team\.maxActive/],
  ['maxActive not a number', (p) => { p.team.maxActive = '2' }, /team\.maxActive/],
  ['paused not a boolean', (p) => { p.team.paused = 'yes' }, /team\.paused/],
  ['tasks not an array', (p) => { p.team.tasks = null }, /team\.tasks/],
  ['task without a status', (p) => { delete p.team.tasks[0].status }, /team\.tasks\[0\]\.status/],
  ['task without a specialistId', (p) => { delete p.team.tasks[1].specialistId }, /team\.tasks\[1\]\.specialistId/],
  ['task files not a string array', (p) => { p.team.tasks[0].files = ['a', 7] }, /team\.tasks\[0\]\.files\[1\]/],
  ['task workerId not a string', (p) => { p.team.tasks[0].workerId = 7 }, /team\.tasks\[0\]\.workerId/],
  ['missing coordinators', (p) => { delete p.coordinators }, /coordinators/],
  ['coordinator without a label', (p) => { delete p.coordinators[0].label }, /coordinators\[0\]\.label/],
  ['maxLimit not a number', (p) => { p.maxLimit = '8' }, /maxLimit/],
]

for (const [label, corrupt, pattern] of malformedCases) {
  await test(`parseSnapshot rejects ${label}`, () => {
    const payload = validPayload()
    // A case either mutates the payload in place or returns a replacement.
    const replaced = corrupt(payload)
    const candidate = replaced === undefined ? payload : replaced
    assert.throws(
      () => parseSnapshot(candidate),
      (error) => {
        assert.ok(error instanceof SnapshotError, `${String(error)} is a SnapshotError`)
        assert.match(error.message, /团队状态格式不正确/)
        assert.match(error.message, pattern)
        return true
      },
    )
  })
}

await test('parseSnapshot localises its diagnostic through the given translate', () => {
  const payload = validPayload()
  delete payload.team.maxActive
  assert.throws(() => parseSnapshot(payload, enTranslate), /Malformed team state: team\.maxActive/)
})

// --- derivations -----------------------------------------------------------

await test('statusMeta classifies every engine status', () => {
  for (const status of ['starting', 'working', 'canceling']) assert.equal(statusMeta(status).active, true, status)
  for (const status of ['done', 'failed', 'canceled', 'blocked']) assert.equal(statusMeta(status).settled, true, status)
  assert.equal(statusMeta('queued').active, false)
  assert.equal(statusMeta('queued').settled, false)
  assert.equal(statusMeta('blocked').dot, 'error')
  assert.equal(statusMeta('done').dot, 'done')
  assert.equal(statusMeta('working').dot, 'ongoing')
  assert.equal(statusMeta('paused-by-host').active, false)
})

await test('statusText translates known statuses and passes unknown ones through', () => {
  assert.equal(statusText('working', plugin.zhTranslate), '进行中')
  assert.equal(statusText('', plugin.zhTranslate), '未知')
  assert.equal(statusText('working', enTranslate), 'Running')
})

await test('summarise counts lifecycle groups', () => {
  const team = {
    sessionId: 's1',
    maxActive: 1,
    paused: false,
    tasks: ['queued', 'working', 'done', 'failed', 'blocked'].map((status, index) => ({
      id: `t${String(index)}`, specialistId: 'x', title: 't', prompt: 'p', status, files: [], dependsOn: [],
    })),
  }
  assert.deepEqual(summarise(team), { total: 5, active: 1, queued: 1, settled: 3, failed: 2 })
  assert.deepEqual(summarise(null), { total: 0, active: 0, queued: 0, settled: 0, failed: 0 })
})

await test('parseList splits, trims, strips trailing slashes and de-duplicates', () => {
  assert.deepEqual(parseList('a/b\nc\\d/\n\n a/b , .  '), ['a/b', 'c\\d', '.'])
  assert.deepEqual(parseList(''), [])
})

await test('validateAssign enforces the host rules before submitting', () => {
  const specialists = [
    { id: 'builder', name: 'B', instructions: 'i', mode: 'write' },
    { id: 'reader', name: 'R', instructions: 'i', mode: 'read' },
  ]
  const base = { specialistId: 'reader', title: 'T', prompt: 'P', files: '', dependsOn: [] }
  assert.equal(validateAssign(base, specialists), null)
  assert.match(validateAssign({ ...base, specialistId: 'nope' }, specialists), /请先选择专家/)
  assert.match(validateAssign({ ...base, title: '  ' }, specialists), /标题/)
  assert.match(validateAssign({ ...base, prompt: '' }, specialists), /任务说明/)
  assert.match(validateAssign({ ...base, specialistId: 'builder' }, specialists), /写类专家必须占用/)
  assert.equal(validateAssign({ ...base, specialistId: 'builder', files: 'a/b' }, specialists), null)
  assert.match(validateAssign({ ...base, specialistId: 'builder' }, specialists, enTranslate), /reservation/)
})

// --- coordinator scoping ---------------------------------------------------

await test('scopedTeam attributes an answer to the coordinator it was fetched for', () => {
  const snapshot = parseSnapshot(validPayload())
  assert.deepEqual(plugin.scopedTeam(snapshot, 's1', 's1'), { team: snapshot.team, stale: false })
  // A `team: null` answer carries no session id: its attribution is the fetch.
  const empty = parseSnapshot({ specialists: [], team: null, coordinators: [] })
  assert.deepEqual(plugin.scopedTeam(empty, 's1', 's1'), { team: null, stale: false }, 'read for s1: genuinely empty')
  assert.deepEqual(plugin.scopedTeam(empty, 's2', 's1'), { team: null, stale: true }, 'read for s1, now on s2: switching')
  // A retained team for another coordinator must never render.
  assert.deepEqual(plugin.scopedTeam(snapshot, 's2', 's1'), { team: null, stale: true })
  assert.deepEqual(plugin.scopedTeam(snapshot, 's1', 's2'), { team: null, stale: true })
  assert.deepEqual(plugin.scopedTeam(null, 's1', undefined), { team: null, stale: false })
  assert.deepEqual(plugin.scopedTeam(snapshot, undefined, 's1'), { team: null, stale: false })
  // A host echoing another session id is refused even with matching attribution.
  const echoed = parseSnapshot({ ...validPayload(), team: { ...validPayload().team, sessionId: 'other' } })
  assert.deepEqual(plugin.scopedTeam(echoed, 's1', 's1'), { team: null, stale: true })
})

await test('operationStillApplies retires a command whose coordinator or generation moved', () => {
  assert.equal(plugin.operationStillApplies('s1', 's1', 3, 3), true)
  assert.equal(plugin.operationStillApplies('s1', 's2', 3, 3), false, 'coordinator switched')
  assert.equal(plugin.operationStillApplies('s1', 's1', 3, 4), false, 'a newer command owns the panel')
  assert.equal(plugin.operationStillApplies(undefined, undefined, 3, 3), false, 'no coordinator at all')
})

// --- transport -------------------------------------------------------------

/** Install a fetch double that records requests and answers from `handler`. */
function stubFetch(handler) {
  const calls = []
  const previous = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} })
    const answer = await handler(String(url), init ?? {})
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      text: async () => answer.body === undefined ? '' : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body),
    }
  }
  return { calls, restore: () => { globalThis.fetch = previous } }
}

await test('state() sends a trusted same-origin GET with the session id', async () => {
  const fetchDouble = stubFetch(() => ({ status: 200, body: validPayload() }))
  try {
    const snapshot = await createTeamsApi().state('a b/c')
    const [call] = fetchDouble.calls
    assert.equal(call.url, '/aseldev-teams/api/state?sessionId=a%20b%2Fc')
    assert.equal(call.init.method, 'GET')
    assert.equal(call.init.headers['x-aseldev-teams'], '1')
    assert.equal(snapshot.coordinators.length, 1)
  } finally {
    fetchDouble.restore()
  }
})

await test('action() posts JSON with the session id and the trust header', async () => {
  const fetchDouble = stubFetch(() => ({ status: 200, body: { ok: true } }))
  try {
    await createTeamsApi().action('s1', { action: 'cancel', taskId: 't1' })
    const [call] = fetchDouble.calls
    assert.equal(call.url, '/aseldev-teams/api/action')
    assert.equal(call.init.method, 'POST')
    assert.equal(call.init.headers['x-aseldev-teams'], '1')
    assert.equal(call.init.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(call.init.body), { sessionId: 's1', action: 'cancel', taskId: 't1' })
  } finally {
    fetchDouble.restore()
  }
})

await test('a host refusal surfaces its own error text', async () => {
  const fetchDouble = stubFetch(() => ({ status: 409, body: { error: 'Worker is busy. Stop or wait for it before sending a direct message.' } }))
  try {
    await assert.rejects(createTeamsApi().action('s1', { action: 'resume' }), (error) => {
      assert.ok(error instanceof TeamsApiError)
      assert.equal(error.status, 409)
      assert.match(error.message, /Worker is busy/)
      return true
    })
  } finally {
    fetchDouble.restore()
  }
})

await test('a non-JSON answer reports the status instead of a parse error', async () => {
  const fetchDouble = stubFetch(() => ({ status: 200, body: '<!doctype html><html></html>' }))
  try {
    await assert.rejects(createTeamsApi().state('s1'), (error) => {
      assert.ok(error instanceof TeamsApiError)
      assert.match(error.message, /非 JSON/)
      return true
    })
  } finally {
    fetchDouble.restore()
  }
})

await test('a transport failure names the missing host plugin', async () => {
  const previous = globalThis.fetch
  globalThis.fetch = async () => { throw new TypeError('failed to fetch') }
  try {
    await assert.rejects(createTeamsApi().state('s1'), /无法连接团队接口/)
  } finally {
    globalThis.fetch = previous
  }
})

await test('caller cancellation is not reported as a user-facing error', async () => {
  const previous = globalThis.fetch
  globalThis.fetch = async () => { throw new DOMException('aborted', 'AbortError') }
  try {
    await assert.rejects(createTeamsApi().state('s1', new AbortController().signal), (error) => {
      assert.equal(plugin.isCanceled(error), true)
      assert.equal(plugin.errorText(error), '')
      return true
    })
  } finally {
    globalThis.fetch = previous
  }
})

await test('errorText explains ordinary failures and localises the empty case', () => {
  assert.equal(plugin.errorText(new Error('boom')), 'boom')
  assert.equal(plugin.errorText(new Error('')), '请求失败')
  assert.equal(plugin.errorText(new Error(''), enTranslate), 'Request failed')
  assert.equal(plugin.errorText('plain'), 'plain')
  assert.equal(plugin.errorText(new TeamsApiError('nope', 400)), 'nope')
})

// --- render smoke tests ----------------------------------------------------
//
// Renders the real components with the repository's own React (resolved from
// the shell package that depends on react-dom) so the JSX/data paths run
// outside a browser. Skipped — not failed — when that React is not installed,
// because this plugin's build does not depend on the repository.

const reactAnchor = join(here, '..', '..', '..', 'packages', 'client', 'web', 'package.json')
let serverRenderer
let realReact
try {
  const { createRequire } = await import('node:module')
  const shellRequire = createRequire(reactAnchor)
  realReact = shellRequire('react')
  serverRenderer = shellRequire('react-dom/server')
} catch {
  serverRenderer = undefined
}

/** Primitives that render their children, so markup assertions see real content. */
function renderPrimitives(h) {
  const passthrough = (tag) => (props) => {
    const { children, icon, ...rest } = props
    return h(tag, rest, icon ?? null, children)
  }
  return {
    StateDot: (props) => h('span', { 'data-state-dot': props.state }),
    Button: passthrough('button'),
    Input: (props) => h('span', null, h('input', props)),
    Pill: (props) => h('span', null, props.children),
    Tooltip: (props) => props.children,
    useDismissOnOutsidePointer: () => undefined,
    IconCheckOutline14: () => null,
    IconChecklistOutline14: () => null,
    IconCloseOutline16: () => null,
    IconPlayOutline16: () => null,
    IconPlusOutline16: () => null,
    IconRefreshOutline16: () => null,
    IconSendOutline16: () => null,
    IconStopFill16: () => null,
    IconUserOutline16: () => null,
  }
}

/** Load a fresh bundle instance whose `require` answers REAL React. */
function loadWithRealReact() {
  const h = realReact.createElement
  // The automatic-runtime jsx/jsxs shape is (type, props, key). React.createElement's
  // third argument is a CHILD, so the key must move into props — otherwise a keyed
  // element's children are replaced by its key.
  const jsx = (type, props, key) => {
    const { children, ...rest } = props ?? {}
    if (key !== undefined) rest.key = key
    if (children === undefined) return h(type, rest)
    return Array.isArray(children) ? h(type, rest, ...children) : h(type, rest, children)
  }
  const table = {
    react: realReact,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: realReact.Fragment },
    '@deepseek-ai/dsh-client-ui-primitives': renderPrimitives(h),
  }
  return loadBundle(table).plugin
}

const EMPTY_DRAFTS = {
  assign: { specialistId: '', title: '', prompt: '', files: '', dependsOn: [] },
  configure: null,
  message: {},
  messageOpen: null,
  specialist: { id: '', name: '', instructions: '', mode: 'read' },
  specialistEditing: false,
}

/** Panel props shared by the render assertions (Chinese copy unless overridden). */
function panelProps(overrides = {}) {
  return {
    snapshot: parseSnapshot(validPayload()),
    // The retained answer was fetched for s1, which is also the selected coordinator.
    snapshotFor: 's1',
    error: null,
    busy: false,
    loadedAt: new Date(),
    coordinatorId: 's1',
    coordinatorLabel: 'Login team',
    currentSessionId: 's1',
    sessionsById: { w1: { running: true } },
    drafts: EMPTY_DRAFTS,
    t: plugin.zhTranslate,
    onDrafts: () => {},
    onSelectCoordinator: () => {},
    onRefresh: () => {},
    onOpenSession: () => {},
    onOpenWorker: () => {},
    onAction: () => {},
    onDismissError: () => {},
    onClose: () => {},
    style: { left: 10, top: 10 },
    rootRef: { current: null },
    ...overrides,
  }
}

await test('panel renders task rows with status, role and worker actions', async () => {
  if (!serverRenderer) return
  const loaded = loadWithRealReact()
  const h = realReact.createElement
  const html = serverRenderer.renderToStaticMarkup(h(loaded.TeamsPanel, panelProps()))
  assert.match(html, /团队/)
  assert.match(html, /Fix/)
  assert.match(html, /Review/)
  assert.match(html, /进行中/)
  assert.match(html, /已完成/)
  assert.match(html, /Builder/)
  assert.match(html, /占用 src\/auth/)
  assert.match(html, /依赖 1 项/)
  assert.match(html, /会话运行中/)
  assert.match(html, /打开会话/)
  assert.match(html, /取消/)
  assert.match(html, /重试/)
  assert.match(html, /并行上限 2 \/ 8/)
  assert.match(html, /Login team/)
  assert.ok((html.match(/disabled=""/g) ?? []).length >= 1, 'the busy worker message toggle is disabled')
  assert.doesNotMatch(html, /正在读取团队状态/)
})

await test('panel renders the same rows in English when the locale seat is English', async () => {
  if (!serverRenderer) return
  const loaded = loadWithRealReact()
  const h = realReact.createElement
  const html = serverRenderer.renderToStaticMarkup(h(loaded.TeamsPanel, panelProps({ t: enTranslate })))
  assert.match(html, /Assignments/)
  assert.match(html, /Running/)
  assert.match(html, /Done/)
  assert.match(html, /Open conversation/)
  assert.match(html, /Parallel limit 2 \/ 8/)
  assert.match(html, /Reserves src\/auth/)
  assert.match(html, /Specialists/)
  assert.doesNotMatch(html, /团队/)
})

await test('an opened message form explains that follow-ups belong to the panel', async () => {
  if (!serverRenderer) return
  const loaded = loadWithRealReact()
  const h = realReact.createElement
  const html = serverRenderer.renderToStaticMarkup(h(loaded.TeamsPanel, panelProps({
    // task-2 is settled, so its toggle is usable and the guard hint applies.
    drafts: { ...EMPTY_DRAFTS, messageOpen: 'task-2', message: { 'task-2': 'Recheck src/b' } },
  })))
  assert.match(html, /Recheck src\/b/)
  assert.match(html, /团队守卫拒绝/)
  assert.match(html, /跟进消息请在本面板发送/)
})

await test('panel renders an action error with a dismiss control only', async () => {
  if (!serverRenderer) return
  const loaded = loadWithRealReact()
  const h = realReact.createElement
  const html = serverRenderer.renderToStaticMarkup(h(loaded.TeamsPanel, panelProps({
    error: { text: 'Worker is busy. Stop or wait for it before sending a direct message.', source: 'action' },
  })))
  assert.match(html, /Worker is busy/)
  assert.match(html, /关闭错误提示/)
  // The banner offers no poll retry, so the only 重试 left is the settled task's.
  assert.equal((html.match(/>重试</g) ?? []).length, 1)
  assert.match(html, /value="s1"[^>]*>Login team/)
  assert.match(html, /Builder \(写\)/)
})

await test('panel offers resume only while the team is paused', async () => {
  if (!serverRenderer) return
  const loaded = loadWithRealReact()
  const h = realReact.createElement
  const pausedPayload = validPayload()
  pausedPayload.team.paused = true
  const pausedHtml = serverRenderer.renderToStaticMarkup(h(loaded.TeamsPanel, panelProps({
    snapshot: parseSnapshot(pausedPayload),
  })))
  assert.match(pausedHtml, /团队已暂停/)
  assert.match(pausedHtml, /恢复调度/)

  const runningHtml = serverRenderer.renderToStaticMarkup(h(loaded.TeamsPanel, panelProps()))
  assert.doesNotMatch(runningHtml, /团队已暂停/)
  assert.doesNotMatch(runningHtml, /恢复调度/)
})

await test('a snapshot for another coordinator hides its tasks and says it is switching', async () => {
  if (!serverRenderer) return
  const loaded = loadWithRealReact()
  const h = realReact.createElement
  // The retained answer was fetched for s1; the picker has moved to s2.
  const html = serverRenderer.renderToStaticMarkup(h(loaded.TeamsPanel, panelProps({
    snapshot: parseSnapshot(validPayload()),
    snapshotFor: 's1',
    coordinatorId: 's2',
  })))
  // No stale task row, no stale task control.
  assert.doesNotMatch(html, /title="Fix"/)
  assert.doesNotMatch(html, /title="Review"/)
  assert.doesNotMatch(html, /占用 src\/auth/)
  assert.doesNotMatch(html, /依赖 1 项/)
  assert.equal((html.match(/>取消</g) ?? []).length, 0)
  assert.equal((html.match(/>重试</g) ?? []).length, 0)
  // The switch state is explicit, and the last-read stamp belongs to s1.
  assert.match(html, /正在切换协调者会话/)
  assert.match(html, /尚未同步/)
  assert.doesNotMatch(html, /已更新/)
  // Coordinator-wide parts of the snapshot survive: roster and coordinator list.
  assert.match(html, /Builder/)
  assert.match(html, /value="s1"[^>]*>Login team/)
})

await test('the same snapshot renders its tasks once the coordinator matches', async () => {
  if (!serverRenderer) return
  const loaded = loadWithRealReact()
  const h = realReact.createElement
  const html = serverRenderer.renderToStaticMarkup(h(loaded.TeamsPanel, panelProps({
    snapshot: parseSnapshot(validPayload()),
    coordinatorId: 's1',
  })))
  assert.match(html, /title="Fix"/)
  assert.match(html, /title="Review"/)
  assert.doesNotMatch(html, /正在切换协调者会话/)
})

await test('panel with no selected session tells the user to open one', async () => {
  if (!serverRenderer) return
  const loaded = loadWithRealReact()
  const h = realReact.createElement
  const html = serverRenderer.renderToStaticMarkup(h(loaded.TeamsPanel, panelProps({
    snapshot: null,
    snapshotFor: undefined,
    coordinatorId: undefined,
    currentSessionId: undefined,
  })))
  assert.match(html, /先打开一个会话/)
  assert.match(html, /未选择会话/)
  assert.doesNotMatch(html, /正在读取团队状态/)
  assert.doesNotMatch(html, /正在切换协调者会话/)
})

await test('a row labels the worker with its assignment-time role, not the edited roster', async () => {
  if (!serverRenderer) return
  const loaded = loadWithRealReact()
  const h = realReact.createElement
  const payload = validPayload()
  // The roster was edited after task-1 ran: renamed and flipped to read-only.
  payload.specialists[0] = { id: 'builder', name: 'Renamed Builder', instructions: 'now read-only', mode: 'read' }
  const html = serverRenderer.renderToStaticMarkup(h(loaded.TeamsPanel, panelProps({
    snapshot: parseSnapshot(payload),
    snapshotFor: 's1',
    coordinatorId: 's1',
  })))
  // task-1 keeps the role it was assigned under...
  assert.match(html, /Builder · 写/)
  assert.doesNotMatch(html, /Renamed Builder · 读/)
  // ...while task-2 has no copy, so the live roster still labels it.
  assert.match(html, /Reviewer · 读/)
  // The role instructions never reach the browser.
  assert.doesNotMatch(html, /SECRET-INSTRUCTIONS/)
  assert.doesNotMatch(html, /now read-only/)
})

await test('a row keeps its role copy even after that specialist is deleted', async () => {
  if (!serverRenderer) return
  const loaded = loadWithRealReact()
  const h = realReact.createElement
  const payload = validPayload()
  // Only the reviewer remains in the roster; task-1's builder is gone.
  payload.specialists = [{ id: 'reviewer', name: 'Reviewer', instructions: 'review', mode: 'read' }]
  const html = serverRenderer.renderToStaticMarkup(h(loaded.TeamsPanel, panelProps({
    snapshot: parseSnapshot(payload),
    snapshotFor: 's1',
    coordinatorId: 's1',
  })))
  assert.match(html, /Builder · 写/, 'the deleted role still labels its finished worker')
  assert.doesNotMatch(html, /（写）Builder|builder · /)
})

await test('panel renders the empty state before the first task', async () => {
  if (!serverRenderer) return
  const loaded = loadWithRealReact()
  const h = realReact.createElement
  const html = serverRenderer.renderToStaticMarkup(h(loaded.TeamsPanel, panelProps({
    snapshot: parseSnapshot({ specialists: [], team: null, coordinators: [] }),
    coordinatorId: 's1',
  })))
  assert.match(html, /该会话还没有任务/)
  assert.match(html, /没有可用专家/)
  assert.match(html, /请先选择专家/)
})

await test('a team-less panel says "host default" instead of claiming a limit of 1', async () => {
  if (!serverRenderer) return
  const loaded = loadWithRealReact()
  const h = realReact.createElement
  const teamless = serverRenderer.renderToStaticMarkup(h(loaded.TeamsPanel, panelProps({
    snapshot: parseSnapshot({ specialists: [], team: null, coordinators: [] }),
    coordinatorId: 's1',
  })))
  assert.match(teamless, /placeholder="宿主默认值"/)
  assert.doesNotMatch(teamless, /placeholder="1"/, 'the field must not advertise a guessed default')
  // Save stays disabled until the user types a requested limit.
  const english = serverRenderer.renderToStaticMarkup(h(loaded.TeamsPanel, panelProps({
    snapshot: parseSnapshot({ specialists: [], team: null, coordinators: [] }),
    coordinatorId: 's1',
    t: enTranslate,
  })))
  assert.match(english, /placeholder="Host default"/)
  assert.match(english, /<button disabled=""[^>]*>Save<\/button>/, 'Save must be disabled with no draft')

  // A team the host already reported shows its own numeric limit.
  const withTeam = serverRenderer.renderToStaticMarkup(h(loaded.TeamsPanel, panelProps()))
  assert.match(withTeam, /placeholder="2"/, 'an existing team may show its own maxActive')
  assert.doesNotMatch(withTeam, /placeholder="宿主默认值"/)
})

await test('launcher renders a closed button in both locales', async () => {
  if (!serverRenderer) return
  const loaded = loadWithRealReact()
  const h = realReact.createElement
  const common = {
    wide: true,
    expandSidebar: () => {},
    api: { state: () => Promise.resolve(parseSnapshot(validPayload())), action: () => Promise.resolve() },
    openSession: () => Promise.resolve(),
    openWorker: () => Promise.resolve(),
    useSessions: (selector) => selector({ current: 's1', byId: {} }),
  }
  const zhHtml = serverRenderer.renderToStaticMarkup(h(loaded.TeamsLauncher, { ...common, t: plugin.zhTranslate }))
  assert.match(zhHtml, /团队/)
  assert.match(zhHtml, /aria-haspopup="dialog"/)
  assert.doesNotMatch(zhHtml, /role="dialog"/)

  const enHtml = serverRenderer.renderToStaticMarkup(h(loaded.TeamsLauncher, { ...common, t: enTranslate }))
  assert.match(enHtml, /Team/)
  assert.doesNotMatch(enHtml, /团队/)
})

await test('launcher without a locale seat falls back to Chinese', async () => {
  if (!serverRenderer) return
  const loaded = loadWithRealReact()
  const h = realReact.createElement
  const html = serverRenderer.renderToStaticMarkup(h(loaded.TeamsLauncher, {
    wide: true,
    expandSidebar: () => {},
    api: { state: () => Promise.resolve(parseSnapshot(validPayload())), action: () => Promise.resolve() },
    openSession: () => Promise.resolve(),
    openWorker: () => Promise.resolve(),
    useSessions: (selector) => selector({ current: 's1', byId: {} }),
  }))
  assert.match(html, /团队/)
})

// --- report ---------------------------------------------------------------

// node:test owns the process exit code; nothing to print here.
