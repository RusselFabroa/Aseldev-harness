/**
 * Host tests: the pure mapping in `state.mjs`, and the HTTP route of the BUILT
 * plugin.
 *
 *   node aseldev/plugins/office/build.mjs
 *   node --test aseldev/plugins/office/host.test.mjs
 *
 * The route cases drive `lib/host.js` — the file a real profile loads — so run
 * the build first, exactly as the package's `test` script does. The store below
 * is the exact JSON the teams plugin's `TeamEngine` writes; no other stand-in
 * data is used.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from './lib/host.js'
import {
  DEFAULT_BOSS_NAME,
  DEFAULT_BOSS_TITLE,
  DEFAULT_PROJECT_NAME,
  DEFAULT_PROJECT_OBJECTIVE,
  accentOf,
  officeSessions,
  officeState,
  progressOf,
  resolveBoss,
  resolveProject,
  roleLabel,
  roleOf,
  statusOf,
} from './state.mjs'

const T0 = Date.UTC(2026, 0, 2, 3, 4, 5)
const T1 = T0 + 60_000
const T2 = T0 + 120_000
const T3 = T0 + 300_000
const NOW = '2026-01-02T04:00:00.000Z'

/** The trust header the route requires. */
const TRUST = { 'x-aseldev-office': '1' }

/** The sessions route, addressed without a query. */
const SESSIONS = '/aseldev-office/api/sessions'

/** The saved roster shape (`specialists` in teams/state.json). */
const ROSTER = [
  { id: 'backend', name: 'Senior Backend Developer', mode: 'write', instructions: 'Smallest complete change.' },
  { id: 'frontend', name: 'Senior Frontend Developer', mode: 'write', instructions: 'Shared primitives and tokens.' },
  { id: 'qa', name: 'Senior QA', mode: 'read', instructions: 'Inspect and report only.' },
  { id: 'designer', name: 'Isometric scene artist', mode: 'write', instructions: 'Draw the office.' },
]

/**
 * One team, as the engine persists it.
 * @param {object} [overrides] - team or store fields to replace.
 * @returns {object} parsed `teams/state.json`.
 */
function store(overrides = {}) {
  const tasks = [
    {
      id: 'task-1',
      specialistId: 'backend',
      specialist: { ...ROSTER[0] },
      title: 'Host half\nsecond line ignored',
      prompt: 'the complete task',
      files: ['aseldev/plugins/office/host.ts'],
      dependsOn: [],
      status: 'working',
      workerId: 'worker-a',
      createdAt: T0,
    },
    {
      id: 'task-2',
      specialistId: 'qa',
      specialist: { ...ROSTER[2] },
      title: 'Review the mapping',
      prompt: 'the complete task',
      files: [],
      dependsOn: ['task-1'],
      status: 'queued',
      createdAt: T1,
    },
    {
      id: 'task-3',
      specialistId: 'designer',
      specialist: { ...ROSTER[3] },
      title: 'Scene pass',
      prompt: 'the complete task',
      files: ['aseldev/plugins/office/scene.ts'],
      dependsOn: [],
      status: 'done',
      workerId: 'worker-c',
      createdAt: T0,
      finishedAt: T1,
    },
    {
      id: 'task-4',
      specialistId: 'frontend',
      specialist: { ...ROSTER[1] },
      title: 'Room labels',
      prompt: 'the complete task',
      files: ['aseldev/plugins/office/client.tsx'],
      dependsOn: [],
      status: 'failed',
      workerId: 'worker-d',
      createdAt: T1,
    },
  ]
  return {
    version: 1,
    specialists: ROSTER.map(entry => ({ ...entry })),
    teams: {
      coordinator: { sessionId: 'coordinator', maxActive: 3, paused: false, tasks, ...overrides },
    },
  }
}

/** Build the document for the fixture team. */
function document(input = {}) {
  return officeState({
    sessionId: 'coordinator',
    store: store(),
    boss: { name: 'Asel', title: 'Founder & team owner' },
    project: { name: 'AselDev', objective: 'Ship the office' },
    now: NOW,
    ...input,
  })
}

/**
 * Three conversations with teams, as the engine persists them: two still have
 * work queued or in flight, and the third is paused but was updated last.
 * @returns {object} parsed `teams/state.json`.
 */
function sessionsStore() {
  return {
    version: 1,
    specialists: ROSTER.map(entry => ({ ...entry })),
    teams: {
      'session-running': {
        sessionId: 'session-running', maxActive: 3, paused: false,
        tasks: [{ id: 'task-r1', specialistId: 'backend', title: 'Ship it', status: 'working', workerId: 'worker-r1', createdAt: T1 }],
      },
      'session-queued': {
        sessionId: 'session-queued', maxActive: 3, paused: false,
        tasks: [
          { id: 'task-q1', specialistId: 'qa', title: 'Wait', status: 'queued', createdAt: T0 },
          { id: 'task-q2', specialistId: 'qa', title: 'Settled', status: 'done', createdAt: T0, finishedAt: T0 },
        ],
      },
      'session-paused': {
        sessionId: 'session-paused', maxActive: 3, paused: true,
        tasks: [{ id: 'task-p1', specialistId: 'designer', title: 'Later', status: 'done', createdAt: T3, finishedAt: T3 }],
      },
    },
  }
}

test('draws one station per saved specialist, carrying that specialist\'s jobs', () => {
  const state = document()
  assert.equal(state.sessionId, 'coordinator')
  assert.equal(state.updatedAt, NOW)
  assert.deepEqual(state.boss, { name: 'Asel', title: 'Founder & team owner' })
  assert.deepEqual(state.project, { name: 'AselDev', objective: 'Ship the office' })
  // Four saved specialists, four stations — never one per assignment.
  assert.equal(state.agents.length, 4)
  assert.deepEqual(state.agents.map(station => station.id), ['backend', 'frontend', 'qa', 'designer'])
  assert.deepEqual(state.agents[0], {
    id: 'backend',
    name: 'Senior Backend Developer',
    role: 'backend',
    title: 'Backend developer',
    accent: '#83c7b3',
    status: 'working',
    progress: 0,
    managerId: 'boss',
    specialist: 'backend',
    task: 'Host half',
    jobs: [{
      id: 'task-1',
      title: 'Host half',
      status: 'working',
      progress: 50,
      startedAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
    }],
  })
  // A settled job keeps its finish time, and a failure blocks its station.
  assert.equal(state.agents[1].status, 'blocked', 'the frontend assignment failed')
  assert.equal(state.agents[2].status, 'queued')
  assert.equal(state.agents[3].status, 'done')
  assert.equal(state.agents[3].progress, 100)
  assert.equal(state.agents[3].jobs[0].updatedAt, new Date(T1).toISOString())
})

test('groups three assignments to one specialist into one station', () => {
  // The bug this shape fixes: one specialist running three jobs was three stations.
  const state = officeState({
    sessionId: 'coordinator',
    store: store({
      tasks: [
        { id: 'task-a', specialistId: 'backend', title: 'Ship the host half', status: 'working', createdAt: T2 },
        { id: 'task-b', specialistId: 'backend', title: 'Write the mapping', status: 'done', createdAt: T0, finishedAt: T1 },
        { id: 'task-c', specialistId: 'backend', title: 'Review the route', status: 'failed', createdAt: T1 },
      ],
    }),
    boss: { name: 'Asel', title: 'Founder & team owner' },
    project: { name: 'AselDev', objective: 'Ship the office' },
    now: NOW,
  })
  const backend = state.agents.find(station => station.id === 'backend')
  assert.deepEqual(backend.jobs.map(job => job.id), ['task-a', 'task-c', 'task-b'], 'newest job first')
  assert.equal(backend.jobs.length, 3)
  assert.deepEqual(backend.jobs.map(job => job.status), ['working', 'blocked', 'done'])
  assert.equal(backend.status, 'working', 'work in flight outranks the settled history')
  assert.equal(backend.progress, 33, 'one of three jobs is done')
  assert.equal(backend.task, 'Ship the host half', 'the station line is the newest job')
  assert.equal(state.agents.filter(station => station.id === 'backend').length, 1)
  // The other saved specialists still appear with no jobs of their own.
  assert.deepEqual(state.agents.map(station => station.id), ['backend', 'frontend', 'qa', 'designer'])
})

test('a specialist with no assignments is an idle station with no jobs', () => {
  const state = officeState({
    sessionId: 'coordinator',
    store: store({ tasks: [] }),
    boss: { name: 'Asel', title: 'Founder & team owner' },
    project: { name: 'AselDev', objective: 'Ship the office' },
    now: NOW,
  })
  assert.equal(state.agents.length, 4)
  assert.deepEqual(state.agents[0], {
    id: 'backend',
    name: 'Senior Backend Developer',
    role: 'backend',
    title: 'Backend developer',
    accent: '#83c7b3',
    status: 'idle',
    progress: 0,
    managerId: 'boss',
    specialist: 'backend',
    task: 'No assignments in this session',
    jobs: [],
  })
})

test('keeps roster order and caps the station list', () => {
  const reversed = { ...store(), specialists: [...ROSTER].reverse() }
  assert.deepEqual(document({ store: reversed }).agents.map(station => station.id), ['designer', 'qa', 'frontend', 'backend'])
  // The cap keeps the first stations in roster order.
  assert.deepEqual(document({ maxAgents: 2 }).agents.map(station => station.id), ['backend', 'frontend'])
  assert.deepEqual(document({ maxAgents: 1 }).agents.length, 1)
})

test('ignores assignments naming no saved specialist', () => {
  const state = officeState({
    sessionId: 'coordinator',
    store: store({
      tasks: [
        { id: 'task-ghost', specialistId: 'ghost', title: 'Nobody', status: 'working', createdAt: T1 },
        { id: 'task-anon', title: 'No specialist at all', status: 'queued', createdAt: T1 },
      ],
    }),
    boss: { name: 'Asel', title: 'Founder & team owner' },
    project: { name: 'AselDev', objective: 'Ship the office' },
    now: NOW,
  })
  assert.deepEqual(state.agents.map(station => station.id), ['backend', 'frontend', 'qa', 'designer'], 'no station is invented')
  assert.ok(state.agents.every(station => station.jobs.length === 0 && station.status === 'idle'))
})

test('maps every job status through the alias table, and derives the station from them', () => {
  const jobsFor = statuses => officeState({
    sessionId: 'coordinator',
    store: store({
      tasks: statuses.map((status, index) => ({
        id: `task-${String(index)}`, specialistId: 'backend', title: status, status, createdAt: T0 + index,
      })),
    }),
    boss: { name: 'Asel', title: 'Founder & team owner' },
    project: { name: 'AselDev', objective: 'Ship the office' },
    now: NOW,
  }).agents[0]
  const aliased = jobsFor(['starting', 'settled_ok', 'canceling', 'teleported'])
  assert.deepEqual(aliased.jobs.map(job => job.status), ['idle', 'offline', 'done', 'working'], 'newest first')
  assert.equal(aliased.status, 'working')

  // Aggregate precedence: working, then queued, then blocked, then all done.
  assert.equal(jobsFor(['done', 'working']).status, 'working')
  assert.equal(jobsFor(['done', 'queued']).status, 'queued')
  assert.equal(jobsFor(['done', 'failed']).status, 'blocked')
  assert.equal(jobsFor(['done', 'canceled']).status, 'idle', 'a canceled job is neither done nor failed')
  assert.equal(jobsFor(['done', 'done']).status, 'done')
  assert.equal(jobsFor(['done', 'done']).progress, 100)
})

test('normalizes every assignment status the teams store can hold', () => {
  const cases = [
    ['queued', 'queued'], ['starting', 'working'], ['working', 'working'], ['canceling', 'offline'],
    ['done', 'done'], ['failed', 'blocked'], ['canceled', 'offline'], ['blocked', 'blocked'],
    ['running', 'working'], ['in_progress', 'working'], ['in-progress', 'working'],
    ['awaiting', 'done'], ['settled-ok', 'done'], ['settled_ok', 'done'],
    ['pending', 'queued'], ['idle', 'idle'], ['none', 'idle'],
    ['stopped', 'offline'], ['offline', 'offline'],
    [' WORKING ', 'working'],
  ]
  for (const [input, expected] of cases) assert.equal(statusOf(input), expected, `status ${input}`)
  assert.equal(statusOf('teleported'), 'idle')
  assert.equal(statusOf(undefined), 'idle')
  assert.equal(statusOf(7), 'idle')
})

test('derives roles and accents from the specialist id and name', () => {
  assert.equal(roleOf({ id: 'backend', name: 'Senior Backend Developer' }), 'backend')
  assert.equal(roleOf({ id: 'frontend', name: 'Senior Frontend Developer' }), 'frontend')
  assert.equal(roleOf({ id: 'qa', name: 'Senior QA' }), 'qa')
  // Role id keywords, including ones no roster id spells the same way.
  assert.equal(roleOf({ id: 'designer', name: 'Isometric scene artist' }), 'design')
  assert.equal(roleOf({ id: 'platform', name: 'Infrastructure' }), 'devops')
  assert.equal(roleOf({ id: 'docs', name: 'Technical writer' }), 'writer')
  assert.equal(roleOf({ id: 'scout', name: 'Analyst' }), 'research')
  assert.equal(roleOf({ id: 'pm', name: 'Project Manager' }), 'pm')
  // A keyword only counts at a word start, so prose inside another word does not decide.
  assert.equal(roleOf({ id: 'capital', name: 'Generalist' }), 'general')
  assert.equal(roleOf(undefined), 'general')
  assert.equal(roleLabel('general'), 'Team member')

  const accents = ['pm', 'backend', 'frontend', 'design', 'qa', 'devops', 'data', 'security', 'writer', 'research', 'general']
  const hexes = accents.map(accentOf)
  assert.equal(new Set(hexes).size, hexes.length, 'every role has its own accent')
  assert.match(accentOf('backend'), /^#[0-9a-f]{6}$/)
  assert.equal(accentOf('unheard-of'), '#9eb2cb')
})

test('clamps progress and derives it from the status when absent', () => {
  assert.equal(progressOf(undefined, 'queued'), 0)
  assert.equal(progressOf(undefined, 'working'), 50)
  assert.equal(progressOf(undefined, 'done'), 100)
  assert.equal(progressOf(0, 'working'), 0)
  assert.equal(progressOf(42, 'queued'), 42)
  assert.equal(progressOf(42.6, 'working'), 43)
  assert.equal(progressOf(140, 'working'), 100)
  assert.equal(progressOf(-5, 'done'), 0)
  assert.equal(progressOf('80', 'working'), 50, 'a non-number is not a percentage')
  assert.equal(progressOf(Number.NaN, 'working'), 50)
})

test('a conversation title longer than the label bound clamps instead of failing', () => {
  const long = 'x'.repeat(400)
  assert.equal(resolveBoss({ sessionTitle: long }).name, 'x'.repeat(200))
  // A non-text or blank title degrades to the default, never to an error.
  assert.equal(resolveBoss({ sessionTitle: 42 }).name, DEFAULT_BOSS_NAME)
  assert.equal(resolveBoss({ sessionTitle: '   ' }).name, DEFAULT_BOSS_NAME)
  // The document built from such a title is a normal document.
  const state = document({ boss: resolveBoss({ sessionTitle: long }) })
  assert.equal(state.boss.name.length, 200)
  assert.equal(state.agents.length, 4)
})

test('falls back for the boss and project cards', () => {
  assert.deepEqual(resolveBoss(), { name: DEFAULT_BOSS_NAME, title: DEFAULT_BOSS_TITLE })
  assert.deepEqual(resolveProject(), { name: DEFAULT_PROJECT_NAME, objective: DEFAULT_PROJECT_OBJECTIVE })
  // The conversation's own title names the boss, and an explicit name wins over it.
  assert.equal(resolveBoss({ sessionTitle: 'Isometric office' }).name, 'Isometric office')
  assert.equal(resolveBoss({ bossName: 'Asel', sessionTitle: 'Isometric office' }).name, 'Asel')
  assert.equal(resolveBoss({ bossName: '  ' }).name, DEFAULT_BOSS_NAME)
  assert.equal(resolveBoss({ bossTitle: 'Owner' }).title, 'Owner')
  assert.equal(resolveProject({ projectName: 'Office', projectObjective: 'Draw it' }).objective, 'Draw it')

  assert.throws(() => resolveBoss({ bossName: 7 }), /bossName must be text/)
  assert.throws(() => resolveProject({ projectObjective: 'x'.repeat(201) }), /at most 200 characters/)
})

test('answers no stations when the store holds no roster', () => {
  const build = input => officeState({
    sessionId: 'coordinator',
    boss: { name: 'You', title: 'Founder & team owner' },
    project: { name: 'AselDev Harness', objective: 'Ship it' },
    now: NOW,
    ...input,
  })
  const expected = {
    sessionId: 'coordinator',
    updatedAt: NOW,
    boss: { name: 'You', title: 'Founder & team owner' },
    project: { name: 'AselDev Harness', objective: 'Ship it' },
    agents: [],
  }
  assert.deepEqual(build({ store: undefined }), expected)
  assert.deepEqual(build({ store: null }), expected)
  assert.deepEqual(build({ store: { version: 1, specialists: ROSTER, teams: {} } }).agents.length, 4, 'a roster is drawn even with no team')
  assert.deepEqual(build({ store: { teams: { coordinator: { tasks: [] } } } }).agents, [], 'an assignment without a saved roster draws nothing')
  assert.deepEqual(build({ store: { specialists: 'nonsense', teams: { coordinator: { tasks: [] } } } }).agents, [])
  // Another conversation's team is not this conversation's office.
  const other = {
    specialists: ROSTER,
    teams: { 'some-other-session': { tasks: [{ id: 'task-x', specialistId: 'backend', title: 'Elsewhere', status: 'working' }] } },
  }
  assert.ok(build({ store: other }).agents.every(station => station.jobs.length === 0))
})

test('bounds one job title and the station line to the first 240 characters', () => {
  const long = `#${'a'.repeat(400)}\nsecond line`
  const one = officeState({
    sessionId: 'coordinator',
    store: store({ tasks: [{ id: 'task-x', title: long, specialist: ROSTER[0], specialistId: 'backend', status: 'working' }] }),
    boss: { name: 'You', title: 'Owner' },
    project: { name: 'AselDev', objective: 'Ship it' },
    now: NOW,
  })
  assert.equal(one.agents[0].task.length, 240)
  assert.equal(one.agents[0].jobs[0].title.length, 240)
  assert.ok(!one.agents[0].task.includes('\n'))
  assert.ok(one.agents[0].task.endsWith('…'))
})

test('lists every conversation with a team, running first then most recently updated', () => {
  const list = officeSessions({
    store: sessionsStore(),
    currentSessionId: 'session-queued',
    titles: { 'session-running': 'Ship the office' },
    now: NOW,
    maxSessions: 50,
  })
  assert.equal(list.currentSessionId, 'session-queued')
  // A queued assignment still runs; the paused conversation was updated last but is idle.
  assert.deepEqual(list.sessions.map(row => row.id), ['session-running', 'session-queued', 'session-paused'])
  assert.deepEqual(list.sessions[0], {
    id: 'session-running',
    title: 'Ship the office',
    status: 'active',
    updatedAt: new Date(T1).toISOString(),
    teammates: 1,
    working: 1,
    running: true,
  })
  // A conversation without a title falls back to its id.
  assert.equal(list.sessions[1].title, 'session-queued')
  assert.equal(list.sessions[1].teammates, 2)
  assert.equal(list.sessions[1].working, 0)
  assert.equal(list.sessions[1].running, true)
  assert.equal(list.sessions[1].updatedAt, new Date(T0).toISOString())
  assert.equal(list.sessions[2].status, 'paused')
  assert.equal(list.sessions[2].running, false)
})

test('a session list of no teams is empty, and the cap and title bound hold', () => {
  const empty = officeSessions({ store: undefined, now: NOW })
  assert.deepEqual(empty, { currentSessionId: null, sessions: [] })
  assert.deepEqual(officeSessions({ store: null, now: NOW }).sessions, [])
  assert.deepEqual(officeSessions({ store: { version: 1, teams: {} }, now: NOW }).sessions, [])
  assert.deepEqual(officeSessions({ store: { teams: 'nonsense' }, now: NOW }).sessions, [])
  // A blank asking conversation is no hint at all.
  assert.equal(officeSessions({ store: undefined, currentSessionId: '   ', now: NOW }).currentSessionId, null)

  assert.deepEqual(officeSessions({ store: sessionsStore(), now: NOW, maxSessions: 1 }).sessions.map(row => row.id), ['session-running'])
  const long = officeSessions({ store: store(), titles: { coordinator: 'x'.repeat(400) }, now: NOW })
  assert.equal(long.sessions[0].title, 'x'.repeat(200))
  // A team with no assignments keeps the document timestamp, so ordering stays total.
  const bare = officeSessions({ store: { teams: { bare: { sessionId: 'bare', paused: false, tasks: [] } } }, now: NOW })
  assert.deepEqual(bare.sessions, [
    { id: 'bare', title: 'bare', status: 'active', updatedAt: NOW, teammates: 0, working: 0, running: false },
  ])
})

// ----------------------------------------------------------------- http route
/**
 * Start the built plugin over a stand-in web server.
 * @param {{teamsDir?: string}} [config] - plugin config overrides.
 * @param {{title?: string}} [services] - a conversation title to expose through stand-in `sessions` / `sessionTitle`.
 * @returns {Promise<{home: string, call: (request?: object) => Promise<{status: number, body: any}>}>} the temp Harness home and a request driver for the captured route handlers.
 */
async function startHost(config = {}, services = {}) {
  const home = mkdtempSync(join(tmpdir(), 'office-host-'))
  const routes = new Map()
  const ctx = {
    webServer: { register(route) { routes.set(route.path, route); return () => {} } },
    // Without a stubbed title the boss falls back to its default.
    get(name) {
      if (services.title === undefined) return undefined
      if (name === 'sessions') return { get: () => ({ events: [] }) }
      if (name === 'sessionTitle') return { get: () => ({ title: services.title }) }
      return undefined
    },
    effect(fn) { return fn() },
    logger: { info() {}, warn() {} },
  }
  await apply(ctx, { teamsDir: join(home, 'teams'), ...config })
  assert.deepEqual([...routes.keys()], ['/aseldev-office/api/state', '/aseldev-office/api/sessions'], 'both routes are registered')

  return {
    home,
    async call({
      method = 'GET',
      url = '/aseldev-office/api/state?sessionId=coordinator',
      headers = {},
      remote = '127.0.0.1',
    } = {}) {
      const path = new URL(url, 'http://127.0.0.1').pathname
      const registered = routes.get(path)
      if (registered === undefined) throw new Error(`no route registered for ${path}`)
      const req = { method, url, socket: { remoteAddress: remote }, headers: { host: '127.0.0.1:3080', ...headers } }
      const answer = { status: 0, body: undefined }
      const res = {
        statusCode: 0,
        headersSent: false,
        headers: {},
        setHeader(key, value) { this.headers[key] = value },
        end(text) {
          answer.status = this.statusCode
          answer.body = JSON.parse(text)
          this.headersSent = true
        },
      }
      await registered.handler(req, res)
      return answer
    },
  }
}

test('the route answers only trusted, correctly addressed requests', async () => {
  const host = await startHost()
  try {
    assert.equal((await host.call()).status, 403, 'no trust header')
    assert.equal((await host.call({ headers: TRUST, remote: '10.1.2.3' })).status, 403, 'not this computer')
    assert.equal((await host.call({ headers: { ...TRUST, origin: 'http://elsewhere.test' } })).status, 403, 'cross-origin')
    assert.equal((await host.call({ method: 'POST', headers: TRUST })).status, 405, 'not a GET')
    const missing = await host.call({ url: '/aseldev-office/api/state', headers: TRUST })
    assert.equal(missing.status, 400, 'no sessionId')
    assert.match(missing.body.error, /sessionId/)
    assert.equal((await host.call({ url: '/aseldev-office/api/state?sessionId=', headers: TRUST })).status, 400, 'blank sessionId')
  } finally {
    rmSync(host.home, { recursive: true, force: true })
  }
})

test('a long conversation title still answers a document, not an error', async () => {
  const host = await startHost({}, { title: 'T'.repeat(400) })
  try {
    const answer = await host.call({ headers: TRUST })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.boss.name, 'T'.repeat(200))
    assert.deepEqual(answer.body.agents, [])
  } finally {
    rmSync(host.home, { recursive: true, force: true })
  }
})

test('an absent store is an empty office and a corrupt one is an error', async () => {
  const host = await startHost()
  try {
    const empty = await host.call({ headers: TRUST })
    assert.equal(empty.status, 200)
    assert.equal(empty.body.sessionId, 'coordinator')
    assert.deepEqual(empty.body.agents, [])
    assert.deepEqual(empty.body.boss, { name: DEFAULT_BOSS_NAME, title: DEFAULT_BOSS_TITLE })
    assert.deepEqual(empty.body.project, { name: DEFAULT_PROJECT_NAME, objective: DEFAULT_PROJECT_OBJECTIVE })

    mkdirSync(join(host.home, 'teams'), { recursive: true })
    writeFileSync(join(host.home, 'teams', 'state.json'), '{ not json')
    const broken = await host.call({ headers: TRUST })
    assert.equal(broken.status, 500, 'a store that will not parse is reported, never shown as an empty team')
    assert.match(broken.body.error, /not valid JSON/)
    assert.equal((await host.call({ url: SESSIONS, headers: TRUST })).status, 500, 'the sessions route reports it too')
  } finally {
    rmSync(host.home, { recursive: true, force: true })
  }
})

test('the sessions route answers only trusted, correctly addressed GET requests', async () => {
  const host = await startHost()
  try {
    assert.equal((await host.call({ url: SESSIONS })).status, 403, 'no trust header')
    assert.equal((await host.call({ url: SESSIONS, headers: TRUST, remote: '10.1.2.3' })).status, 403, 'not this computer')
    assert.equal((await host.call({ url: SESSIONS, headers: { ...TRUST, origin: 'http://elsewhere.test' } })).status, 403, 'cross-origin')
    assert.equal((await host.call({ url: SESSIONS, headers: TRUST, method: 'POST' })).status, 405, 'not a GET')
    const empty = await host.call({ url: SESSIONS, headers: TRUST })
    assert.equal(empty.status, 200, 'an empty teams store is an empty list, not an error')
    assert.deepEqual(empty.body, { currentSessionId: null, sessions: [] })
    const longHeader = await host.call({ url: SESSIONS, headers: { ...TRUST, 'x-aseldev-office-session': 'x'.repeat(201) } })
    assert.equal(longHeader.status, 400, 'an over-long conversation id is refused')
    assert.match(longHeader.body.error, /x-aseldev-office-session/)
  } finally {
    rmSync(host.home, { recursive: true, force: true })
  }
})

test('the sessions route lists the store running-first, capped, titled by the sessions service', async () => {
  const host = await startHost({ maxSessions: 2 }, { title: 'Shared title' })
  try {
    mkdirSync(join(host.home, 'teams'), { recursive: true })
    writeFileSync(join(host.home, 'teams', 'state.json'), JSON.stringify(sessionsStore()))
    const answer = await host.call({ url: SESSIONS, headers: { ...TRUST, 'x-aseldev-office-session': 'session-queued' } })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.currentSessionId, 'session-queued')
    // The cap keeps the running-first order; the paused conversation does not fit.
    assert.deepEqual(answer.body.sessions.map(row => row.id), ['session-running', 'session-queued'])
    assert.deepEqual(answer.body.sessions[0], {
      id: 'session-running',
      title: 'Shared title',
      status: 'active',
      updatedAt: new Date(T1).toISOString(),
      teammates: 1,
      working: 1,
      running: true,
    })
  } finally {
    rmSync(host.home, { recursive: true, force: true })
  }
})
