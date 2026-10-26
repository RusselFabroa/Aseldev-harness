/**
 * Focused tests for the AI HQ office browser half.
 *
 * The bundle is compiled the way the office `build.mjs` compiles it (tsdown,
 * CJS, browser, shared React external) into a temporary directory, and then
 * loaded the way the dsh web shell loads it — a classic script calling
 * `window.__ModuleLoader__.load({ id, factory })` whose `require` answers only
 * the frozen platform table — so these assertions cover the artifact as
 * shipped, not the TypeScript sources.
 *
 * Scope: the pure helpers the panel is built on (status map, station layout
 * order, empty-state decision, wire parsing, metric counts, local time, session
 * options), the stylesheet copy inlined in the bundle, the `sidebar.launcher`
 * registration, server-rendered smoke tests of the real overlay, and jsdom
 * cases for the session selector's two poll chains (all skipped when the
 * repository's React is not installed).
 *
 * Usage: `node --test aseldev/plugins/office/client.test.mjs`.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'tsdown'

const here = dirname(fileURLToPath(import.meta.url))

/** Platform modules the shell's frozen table answers; everything else inlines. */
const SHARED = ['react', 'react/jsx-runtime']

/** Compile `client.tsx` (which imports `scene.tsx`) into a temp bundle. */
async function bundle() {
  const outDir = mkdtempSync(join(tmpdir(), 'aseldev-office-'))
  await build({
    config: false,
    tsconfig: false,
    name: '@aseldev/dsh-office/client',
    cwd: here,
    entry: { client: 'client.tsx' },
    outDir,
    format: ['cjs'],
    platform: 'browser',
    dts: false,
    sourcemap: false,
    clean: false,
    external: SHARED,
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'import.meta.env.MODE': JSON.stringify('production'),
      'import.meta.env': JSON.stringify({ MODE: 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "@aseldev/dsh-office", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }, { config: false })
  return readFileSync(join(outDir, 'client.js'), 'utf8')
}

const source = await bundle()

/** Minimal React surface: the bundle requires it and calls only hooks/elements at render time. */
const reactStub = new Proxy({}, {
  get: (_target, key) => (key === 'Fragment' ? Symbol.for('react.fragment') : () => undefined),
})

/**
 * Load one fresh bundle instance over a module table and a page window. The
 * bundle receives `window` as a parameter, so a case that needs timers or a DOM
 * passes a jsdom window here instead of the bare loader stub.
 */
function loadBundle(table, pageWindow = {}) {
  const handoffs = []
  const win = pageWindow
  win.__ModuleLoader__ = { load: handoff => void handoffs.push(handoff) }
  new Function('window', source)(win)
  assert.equal(handoffs.length, 1, 'the bundle must register exactly one factory')
  const plugin = handoffs[0].factory(specifier => {
    if (!(specifier in table)) throw new Error(`client-modules: require("${specifier}") missed the module table`)
    return table[specifier]
  })
  return { handoff: handoffs[0], plugin }
}

const { handoff, plugin } = loadBundle({
  react: reactStub,
  'react/jsx-runtime': { jsx: () => undefined, jsxs: () => undefined, Fragment: Symbol.for('react.fragment') },
})

const { STATUS, statusMeta, calculateLayout, stationSlots, isEmptyOffice } = plugin

/** One job row as the host sends it, with only the fields this case needs. */
function job(overrides) {
  return {
    id: 'j-1',
    title: 'Implement the responsive workspace',
    status: 'working',
    progress: 40,
    startedAt: '2026-03-01T09:30:00.000Z',
    updatedAt: '2026-03-01T10:05:00.000Z',
    ...overrides,
  }
}

/** One agent row — a saved specialist carrying its jobs — as the host sends it. */
function agent(overrides) {
  return {
    id: 'alpha',
    name: 'Alpha',
    role: 'frontend',
    title: 'Frontend developer',
    status: 'working',
    progress: 40,
    managerId: 'boss',
    accent: '#94baff',
    specialist: 'frontend',
    jobs: [job()],
    ...overrides,
  }
}

const state = {
  sessionId: 's-1',
  updatedAt: '2026-03-01T10:05:00.000Z',
  boss: { name: 'Asel', title: 'Founder & team owner' },
  project: { name: 'AI HQ', objective: 'Port the office into the plugin.' },
  agents: [
    agent({ id: 'alpha', name: 'Alpha' }),
    agent({ id: 'beta', name: 'Beta', status: 'review', progress: 90, managerId: 'alpha', jobs: [job({ id: 'j-9', status: 'review', progress: 90 })] }),
  ],
}

/** One specialist holding three jobs in the selected session. */
const busy = agent({
  id: 'alpha',
  name: 'Alpha',
  progress: 47,
  jobs: [
    job({ id: 'j-3', title: 'Wire the session selector', status: 'working', progress: 30, updatedAt: '2026-03-01T10:40:00.000Z' }),
    job({ id: 'j-2', title: 'Clamp the modal job titles', status: 'done', progress: 100, updatedAt: '2026-03-01T10:20:00.000Z' }),
    job({ id: 'j-1', title: 'Read the roster at boot', status: 'queued', progress: 0, startedAt: null, updatedAt: null }),
  ],
})

// ------------------------------------------------------------------ artifacts

test('the bundle is one dual-face client package with a launcher and locale', () => {
  assert.equal(handoff.id, '@aseldev/dsh-office')
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['slots', 'sessions', 'locale'], 'job rows navigate through the sessions service')
  assert.equal(plugin.OFFICE_NS, 'aseldev.office')
  for (const key of Object.keys(plugin.zh)) {
    assert.equal(typeof plugin.en[key], 'string', `en is missing "${key}"`)
  }
})

/**
 * Apply the bundle over a stub context and hand back the injected face plus the
 * calls its navigation made.
 * @param sessions - overrides for the stub sessions service.
 */
function applied(sessions = {}) {
  const calls = { open: [], subagentAddress: [], refresh: [], openSubagent: [] }
  const registered = []
  const ctx = {
    effect: callback => { callback() },
    locale: {
      register: (namespace, dictionaries) => { registered.push({ namespace, dictionaries }); return () => {} },
      bind: () => key => key,
    },
    sessions: {
      open: id => { calls.open.push(id) },
      subagentAddress: id => { calls.subagentAddress.push(id); return undefined },
      refreshSubagents: async parent => { calls.refresh.push(parent) },
      openSubagent: address => { calls.openSubagent.push(address) },
      ...sessions,
    },
    slots: {
      inject: (name, callback) => { registered.push({ injected: name }); return callback() },
      register: (options, component) => { registered.push({ options, component }); return () => {} },
    },
  }
  plugin.apply(ctx)
  const entry = registered.find(item => item.options !== undefined)
  return { injected: entry.options.inject(), registered, calls, ctx }
}

test('apply registers one sidebar.launcher entry carrying the dictionaries', () => {
  const { injected, registered, calls } = applied()

  const locale = registered.find(entry => entry.namespace !== undefined)
  assert.equal(locale.namespace, 'aseldev.office')
  assert.equal(locale.dictionaries.en['empty.agents'], 'No team assignments yet — assign work to a teammate to see them here')

  assert.ok(registered.some(entry => entry.injected === 'sidebar.launcher'))
  const entry = registered.find(item => item.options !== undefined)
  assert.equal(entry.options.name, 'sidebar.launcher')
  assert.equal(entry.options.id, 'office')
  assert.equal(entry.options.locale, 'aseldev.office')
  assert.equal(typeof entry.component, 'function')
  assert.equal(typeof injected.api.state, 'function')

  // A listed session opens directly: the shell's own sessions.open, no URL.
  return injected.openConversation('worker-9', 'coordinator-1').then(() => {
    assert.deepEqual(calls.open, ['worker-9'], 'one direct open')
    assert.deepEqual(calls.refresh, [], 'and no catalog work')
    assert.deepEqual(calls.openSubagent, [])
  })
})

test('an unlisted job id falls back to the worker path and opens once', async () => {
  const { injected, calls } = applied({
    open: id => { calls.open.push(id); throw new Error(`sessions.select: unknown session ${id}`) },
  })

  await injected.openConversation('worker-7', 'coordinator-1')
  assert.deepEqual(calls.open, ['worker-7'], 'the cheap path is tried first, once')
  assert.deepEqual(calls.refresh, ['coordinator-1'], 'then the coordinator catalog is loaded')
  assert.deepEqual(calls.openSubagent, [{ parentSessionId: 'coordinator-1', childSessionId: 'worker-7', mode: 'continuable' }],
    'and the child opens through its parent address')
})

test('a retained worker address opens without loading the catalog again', async () => {
  const retained = { parentSessionId: 'coordinator-2', childSessionId: 'worker-8', mode: 'continuable' }
  const { injected, calls } = applied({
    open: id => { calls.open.push(id); throw new Error(`sessions.select: unknown session ${id}`) },
    subagentAddress: id => { calls.subagentAddress.push(id); return retained },
  })

  await injected.openConversation('worker-8', 'coordinator-1')
  assert.deepEqual(calls.refresh, [], 'a retained address needs no refresh')
  assert.deepEqual(calls.openSubagent, [retained])
})

test('a job that fails both paths rejects with the direct refusal', async () => {
  const { injected, calls } = applied({
    open: id => { calls.open.push(id); throw new Error(`sessions.select: unknown session ${id}`) },
    openSubagent: () => { throw new Error('sessions.selectSubagent: worker-7 is not a healthy catalog child') },
  })

  await assert.rejects(() => injected.openConversation('worker-7', ''), /unknown session worker-7/,
    'without a coordinator the direct refusal is what surfaces')
  await assert.rejects(() => injected.openConversation('worker-7', 'coordinator-1'), /not a healthy catalog child/,
    'the worker path reports its own refusal when the catalog refuses it')
  assert.deepEqual(calls.open, ['worker-7', 'worker-7'], 'the direct path is tried once per call')
})

/** Selector list of one stylesheet, comments removed, keyframe steps excluded. */
function selectorsOf(css) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|\})\s*([^{}@;]+?)\s*\{/g)]
    .map(match => match[1].trim().replace(/\s+/g, ' '))
    // Keyframe steps are not selectors.
    .filter(selector => !/^[\d%\s,.]+$/.test(selector) && !/^(from|to)\b/.test(selector))
    .flatMap(selector => selector.split(',').map(part => part.trim()))
}

/**
 * Overlay rules must hang off the `.aseldev-office` root: either the root
 * compound itself (optionally narrowed by an attribute or pseudo class), or a
 * descendant of it. A bare `startsWith('.aseldev-office')` would also accept a
 * sibling class such as `.aseldev-office-launch`, which is exactly the leak
 * this check exists to catch.
 */
function isOverlayScoped(selector) {
  if (!/^\.aseldev-office(?![\w-])/.test(selector)) return false
  return /^\.aseldev-office(\[[^\]]*\])*(::?[a-z-]+)*$/.test(selector) || selector.includes(' ')
}

/** The only global class prefix this plugin may ship (the sidebar launcher). */
const LAUNCHER_ALLOWLIST = /^\.aseldev-office-launch(?![\w-])/

test('office.css is the stylesheet the bundle ships, and every overlay rule is root-scoped', () => {
  const css = readFileSync(join(here, 'office.css'), 'utf8')
  assert.equal(plugin.OFFICE_CSS, css, 'client.tsx OFFICE_CSS drifted from office.css')

  const selectors = selectorsOf(css)
  assert.ok(selectors.length > 20, 'expected the office stylesheet to define rules')
  for (const selector of selectors) {
    assert.ok(isOverlayScoped(selector), `unscoped selector: ${selector}`)
  }

  // The launcher chrome is the one global sheet; its selectors must all sit
  // under the allowlisted prefix, and none of them may live in office.css.
  const launcher = selectorsOf(plugin.LAUNCHER_CSS)
  assert.ok(launcher.length > 0, 'the launcher sheet must ship its hover/focus rules')
  for (const selector of launcher) {
    assert.ok(LAUNCHER_ALLOWLIST.test(selector), `launcher selector outside the allowlist: ${selector}`)
    assert.ok(!selectors.includes(selector), `launcher rule duplicated into office.css: ${selector}`)
  }
})

// -------------------------------------------------------------- status palette

test('status map keeps the reference colors and falls back to idle', () => {
  assert.deepEqual(STATUS.working, { label: 'Working', color: '#8fc5a1' })
  assert.deepEqual(STATUS.review, { label: 'Needs your approval', color: '#ffcb85' })
  assert.deepEqual(STATUS.blocked, { label: 'Blocked', color: '#f2929c' })
  assert.deepEqual(STATUS.done, { label: 'Done', color: '#8bbcff' })
  assert.equal(statusMeta('review').color, '#ffcb85')
  assert.equal(statusMeta('a-status-from-a-newer-host').color, STATUS.idle.color)
})

// ------------------------------------------------------------------- layout

test('stations fill the left wing first, then the right, in painter order', () => {
  assert.deepEqual(stationSlots([]), [])

  const single = stationSlots(['alpha'])
  assert.equal(single.length, 1)
  assert.equal(single[0].id, 'alpha')
  assert.equal(single[0].wing, 'Left wing')
  assert.equal(single[0].x, 3.2)

  const six = stationSlots(['a', 'b', 'c', 'd', 'e', 'f'])
  assert.deepEqual(six.map(slot => slot.id), ['a', 'b', 'c', 'd', 'e', 'f'])
  assert.deepEqual(six.map(slot => slot.wing), [
    'Left wing', 'Left wing', 'Left wing', 'Right wing', 'Right wing', 'Right wing',
  ])
  assert.deepEqual(six.map(slot => slot.x), [3.2, 3.2, 3.2, 15.3, 15.3, 15.3])
  assert.deepEqual(six.map(slot => slot.y).slice(0, 3), [5.5, 9.9, 14.3])

  // Painter order is back to front, independent of team order.
  const shuffled = stationSlots(['d', 'a', 'f', 'b', 'e', 'c'])
  assert.deepEqual(shuffled.map(slot => slot.depth), [...shuffled.map(slot => slot.depth)].sort((x, y) => x - y))
  assert.equal(shuffled.length, 6)

  const layout = calculateLayout(['a', 'b', 'c', 'd', 'e', 'f'])
  assert.equal(layout.rows, 3)
  assert.equal(layout.positions.get('a').wing, 'Left wing')
  assert.equal(layout.positions.get('f').wing, 'Right wing')
})

test('the empty state is a decided fact, not a missing one', () => {
  assert.equal(isEmptyOffice(null), false, 'before the first answer the panel shows "connecting"')
  assert.equal(isEmptyOffice({ agents: [] }), true)
  assert.equal(isEmptyOffice({ agents: [agent({})] }), false)
})

// ------------------------------------------------------------- wire parsing

test('parseState reads the documented fields and normalizes the wire', () => {
  const parsed = plugin.parseState(state)
  assert.equal(parsed.sessionId, 's-1')
  assert.equal(parsed.boss.name, 'Asel')
  assert.equal(parsed.project.name, 'AI HQ')
  assert.equal(parsed.agents.length, 2)
  assert.equal(parsed.agents[0].specialist, 'frontend')
  assert.equal(parsed.agents[1].managerId, 'alpha')

  const normalized = plugin.parseState({
    sessionId: 's-2',
    updatedAt: 1_772_000_000_000,
    boss: { name: 'Asel' },
    project: {},
    agents: [
      { id: 'gamma', status: 'speed-running', progress: 480, task: 'ignored convenience text' },
      { name: 'no id at all' },
    ],
  })
  assert.equal(normalized.agents.length, 1, 'an agent without an id is dropped, not fatal')
  assert.equal(normalized.agents[0].status, 'idle', 'an unknown status renders as idle')
  assert.equal(normalized.agents[0].progress, 100, 'progress is clamped to the bar range')
  assert.equal(normalized.agents[0].name, 'gamma')
  assert.deepEqual(normalized.agents[0].jobs, [], 'a specialist with no jobs is a valid idle teammate')
  assert.equal(normalized.updatedAt, new Date(1_772_000_000_000).toISOString())

  assert.throws(() => plugin.parseState({ agents: 'nope' }), /agents/)
  assert.throws(() => plugin.parseState(null), /object/)
})

test('a specialist keeps its jobs, newest first, and unknown job shapes are dropped', () => {
  const parsed = plugin.parseState({ ...state, agents: [busy] })
  const [held] = parsed.agents
  assert.equal(held.jobs.length, 3, 'one station carries every job of the specialist')
  assert.deepEqual(held.jobs.map(entry => entry.id), ['j-3', 'j-2', 'j-1'], 'newest update first')
  assert.deepEqual(held.jobs.map(entry => entry.status), ['running', 'done', 'queued'])
  assert.equal(held.jobs[0].progress, 30)
  assert.equal(held.jobs[2].startedAt, null, 'a queued job has not started')
  assert.equal(held.status, 'working', 'the row status is the aggregate the host sent')
  assert.equal(held.progress, 47)

  const messy = plugin.parseState({
    ...state,
    agents: [
      {
        id: 'delta',
        status: 'working',
        jobs: [
          { id: 'j-a', title: 'Starting now', status: 'starting', progress: 0, startedAt: 1_772_000_000_000 },
          { id: 'j-b', title: 'Blew up', status: 'failed', progress: 100 },
          { id: 'j-c', title: 'Needs you', status: 'review', progress: 60 },
          { id: 'j-d', title: 'Cancelled', status: 'canceled', progress: 10 },
          { title: 'no id at all' },
          'not a job',
          null,
        ],
      },
      { id: 'epsilon', status: 'idle', jobs: 'not an array' },
    ],
  })
  const [delta, epsilon] = messy.agents
  assert.deepEqual(delta.jobs.map(entry => entry.id), ['j-a', 'j-b', 'j-c', 'j-d'],
    'every identified job is kept, junk is dropped, and jobs without stamps tie on id')
  assert.equal(delta.jobs.find(entry => entry.id === 'j-a').status, 'running', 'a starting job folds to running')
  assert.equal(delta.jobs.find(entry => entry.id === 'j-b').status, 'failed')
  assert.equal(delta.jobs.find(entry => entry.id === 'j-c').status, 'blocked', 'needs-approval folds to blocked')
  assert.equal(delta.jobs.find(entry => entry.id === 'j-d').status, 'failed', 'a cancelled job folds to failed')
  assert.equal(new Date(delta.jobs.find(entry => entry.id === 'j-a').startedAt).getTime(), 1_772_000_000_000)
  assert.deepEqual(epsilon.jobs, [], 'an unreadable job list is no jobs, not a broken document')

  const { startedAt, updatedAt } = plugin.jobSpan(parsed.agents[0].jobs)
  assert.equal(startedAt, '2026-03-01T09:30:00.000Z', 'the window starts with the earliest job')
  assert.equal(updatedAt, '2026-03-01T10:40:00.000Z', 'and ends with the latest update')
  assert.deepEqual(plugin.jobSpan([]), { startedAt: null, updatedAt: null })
})

test('metric counts and local timestamps are pure and total', () => {
  assert.deepEqual(plugin.statsOf(null), { teammates: 0, working: 0, needs: 0 })
  assert.deepEqual(plugin.statsOf(plugin.parseState(state)), { teammates: 2, working: 1, needs: 1 })

  assert.equal(plugin.formatLocal(null), '—')
  assert.equal(plugin.formatLocal('not a date'), '—')
  assert.notEqual(plugin.formatLocal('2026-03-01T09:30:00.000Z'), '—')
})

test('statusText localises known statuses and degrades gracefully', () => {
  const echo = key => key
  assert.equal(plugin.statusText(echo, 'working'), 'Working', 'an echo translator falls back to the scene label')
  assert.equal(plugin.statusText(translate, 'working'), 'Working')
  assert.equal(plugin.statusText(translate, 'blocked'), 'Blocked')
  assert.equal(plugin.statusText(translate, 'unknown-from-the-future'), 'Idle')
})

// ------------------------------------------------------------------ repaint

test('sameScene ignores the host\'s per-answer updatedAt stamp', () => {
  const first = plugin.parseState(state)
  // The host stamps a new updatedAt on every answer; the scene does not draw it.
  const restamped = plugin.parseState({ ...state, updatedAt: '2026-03-01T10:06:30.000Z' })
  assert.equal(plugin.sameScene(first, restamped), true, 'an untouched team must not repaint')
  assert.equal(plugin.sameScene(null, restamped), false, 'the first answer always lands')

  const moved = plugin.parseState({
    ...state,
    agents: state.agents.map(entry => (entry.id === 'alpha' ? { ...entry, status: 'review', progress: 90 } : entry)),
  })
  assert.equal(plugin.sameScene(first, moved), false, 'a status or progress change repaints')

  const renamed = plugin.parseState({ ...state, boss: { name: 'Someone else', title: 'Owner' } })
  assert.equal(plugin.sameScene(first, renamed), false, 'the cards are drawn too')

  const stamped = plugin.parseState({
    ...state,
    agents: state.agents.map(entry => (entry.id === 'beta'
      ? { ...entry, jobs: [{ ...job({ id: 'j-9', status: 'review', progress: 90 }), updatedAt: '2026-03-01T11:00:00.000Z' }] }
      : entry)),
  })
  assert.equal(plugin.sameScene(first, stamped), false, 'a job\'s own stamp feeds the modal')
})

// ------------------------------------------------------- server-rendered smoke

/** English copy with `{name}` params, matching the panel's translate seat. */
function translate(key, params) {
  const template = plugin.en[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
}

/** The repository's own React, when this checkout has it installed. */
function peerRequire() {
  try {
    const requireFrom = createRequire(pathToFileURL(join(here, '../../../packages/client/ui-primitives/package.json')))
    const React = requireFrom('react')
    const jsxRuntime = requireFrom('react/jsx-runtime')
    const { renderToStaticMarkup } = requireFrom('react-dom/server')
    const { createRoot } = requireFrom('react-dom/client')
    const { JSDOM } = requireFrom('jsdom')
    // Touch a known member so a stub React cannot pass for the real one.
    React.useId
    return { React, jsxRuntime, renderToStaticMarkup, createRoot, JSDOM }
  } catch {
    return null
  }
}

const peer = peerRequire()

/** Default camera/toggles the panel receives from the launcher. */
const baseCamera = { zoom: 1, pan: { x: 0, y: 0 }, labels: true, links: false, motion: true }

/** Render the panel with the repository's React. */
function renderPanel(props) {
  const { plugin: real } = loadBundle({ react: peer.React, 'react/jsx-runtime': peer.jsxRuntime })
  return peer.renderToStaticMarkup(real.OfficePanel({
    state: plugin.parseState(state),
    error: null,
    sessions: null,
    polledId: 's-1',
    selectedId: null,
    target: null,
    camera: baseCamera,
    t: translate,
    panelRef: { current: null },
    onClose: () => {},
    onSelect: () => {},
    onSelectSession: () => {},
    onCloseModal: () => {},
    onCamera: () => {},
    onFit: () => {},
    ...props,
  }))
}

test('the panel renders one station per teammate plus the command desk', { skip: peer === null }, () => {
  const html = renderPanel({})
  assert.match(html, /class="aseldev-office"/)
  assert.match(html, /data-station="boss"/)
  assert.match(html, /data-station="alpha"/)
  assert.match(html, /data-station="beta"/)
  assert.match(html, /aria-label="Alpha, Frontend developer, Working, 1 job, 1 running"/)
  assert.match(html, /aria-pressed="false"/)
  assert.match(html, /role="button"/)
  assert.match(html, /<strong>2<\/strong><span>Teammates<\/span>/)
  assert.match(html, /<strong>1<\/strong><span>Working<\/span>/)
  assert.match(html, /Drag|Select a station/)
  assert.match(html, /Your desk/)
})

test('the zoom slider reaches 250% and the camera survives it', { skip: peer === null }, () => {
  const html = renderPanel({ camera: { ...baseCamera, zoom: 2.5, pan: { x: 120, y: -60 } } })
  assert.match(html, /min="70"/)
  assert.match(html, /max="250"/, 'the ceiling is 250%')
  assert.match(html, /step="5"/, 'the step is unchanged')
  assert.match(html, /value="250"/, 'the slider sits at its new maximum')
  assert.match(html, /<output>250%<\/output>/, 'and the readout says 250%')
  // The camera transform scales by the zoom and offsets by the clamped pan, so
  // 2.5x is still one finite transform.
  assert.match(html, /transform="translate\(840 345\) scale\(2\.5\) translate\(-720 -405\)"/)
  assert.doesNotMatch(html, /NaN|Infinity/, 'no coordinate goes non-finite at 2.5x')
})

test('the scene draws the office, its labels, and its motion hooks', { skip: peer === null }, () => {
  const html = renderPanel({ selectedId: 'beta' })
  // A ported geometry bug shows up as a hole in a coordinate, never as a throw.
  assert.doesNotMatch(html, /NaN|undefined/, 'every projected coordinate is a number')
  assert.match(html, /id="office-glow"/)
  assert.match(html, /id="office-carpet"/)
  assert.match(html, /INFRASTRUCTURE/, 'the server room is drawn')
  assert.match(html, /ASELDEV \/ HQ/, 'the floor brand mark is drawn')
  // One nameplate per station: two teammates plus the command desk.
  assert.equal([...html.matchAll(/class="office-nameplate"/g)].length, 3)
  assert.match(html, /office-signal/)
  assert.match(html, /office-typing/, 'working sprites animate their hands')
  assert.match(html, /aria-pressed="true"/, 'the selected station is marked')
  assert.doesNotMatch(html, /class="office-route"/, 'reporting lines are off by default')

  const withLinks = renderPanel({ camera: { ...baseCamera, links: true, labels: false, motion: false } })
  assert.match(withLinks, /class="office-route"/)
  assert.match(withLinks, /data-motion="off"/)
})

/** The scene markup after the label layer's opening tag, which is the last group. */
function labelLayer(html) {
  const at = html.indexOf('class="office-labels"')
  assert.notEqual(at, -1, 'the scene must render a label layer')
  const start = html.lastIndexOf('<g', at)
  const tag = html.slice(start, html.indexOf('>', at) + 1)
  return { tag, body: html.slice(at) }
}

test('every nameplate is emitted by one layer painted above every station', { skip: peer === null }, () => {
  const html = renderPanel({})
  const layer = labelLayer(html)

  // The layer opens after the last station body, and the plates live after it.
  const lastStation = html.lastIndexOf('class="office-station')
  assert.ok(lastStation !== -1 && lastStation < html.indexOf('class="office-labels"'), 'labels paint after every station')
  assert.equal([...html.matchAll(/class="office-nameplate"/g)].length, 3, 'one plate per station: 2 teammates + the desk')
  const firstPlate = html.indexOf('class="office-nameplate"')
  assert.ok(firstPlate > html.indexOf('class="office-labels"'), 'no plate is drawn inside a station body')

  // Reporting lines stay under the plates too.
  const withLinks = renderPanel({ camera: { ...baseCamera, links: true } })
  assert.ok(withLinks.lastIndexOf('class="office-route') < withLinks.indexOf('class="office-labels"'), 'labels paint after the reporting lines')

  // Each plate names its station for the panel's click/Enter delegation.
  assert.equal([...layer.body.matchAll(/data-station="/g)].length, 3)
  for (const id of ['boss', 'alpha', 'beta']) assert.match(layer.body, new RegExp(`data-station="${id}"`))
  // ...but the plate is not a second focus target: the station body owns that.
  assert.doesNotMatch(layer.tag, /tabindex|role=|aria-label/)
  assert.doesNotMatch(layer.body, /tabindex/, 'plates are pointer targets only')
  assert.match(layer.tag, /aria-hidden="true"/, 'the plate text must not duplicate the station name for AT')

  // Plate order matches station order: back to front.
  const order = text => [...text.matchAll(/data-station="([^"]+)"/g)].map(match => match[1])
  const stationOrder = order(html.slice(0, html.indexOf('class="office-labels"')))
  assert.deepEqual(order(layer.body), stationOrder, 'labels keep the stations\' painter order')
})

test('nameplates float above the desk, clear of the monitor and the head', () => {
  // The plate hangs below its anchor, so the bottom edge is what must clear the
  // desk furniture: it is the pixel nearest the monitor.
  assert.ok(plugin.PLATE_ANCHOR_Y > 0 && plugin.PLATE_ANCHOR_Y < 1.85, 'anchored over the desk, not in front of it')
  assert.ok(plugin.PLATE_ANCHOR_Z > plugin.MONITOR_TOP_Z, 'the anchor itself sits above the monitor')
  assert.ok(plugin.PLATE_BOTTOM_Z > plugin.MONITOR_TOP_Z,
    `plate bottom ${String(plugin.PLATE_BOTTOM_Z)} must clear the monitor ${String(plugin.MONITOR_TOP_Z)}`)
  assert.ok(plugin.PLATE_BOTTOM_Z > plugin.HEAD_TOP_Z,
    `plate bottom ${String(plugin.PLATE_BOTTOM_Z)} must clear the head ${String(plugin.HEAD_TOP_Z)}`)
  assert.ok(plugin.PLATE_ANCHOR_Z < 6.8, 'and stay under the ceiling')
  assert.equal(plugin.PLATE_HEIGHT, 29)
})

test('nameplates in one column are nudged off the row step so they do not stack', { skip: peer === null }, () => {
  // Six teammates fill one column of three rows: rows 0, 1, 2 on each wing.
  const many = { ...plugin.parseState(state), agents: ['a', 'b', 'c', 'd', 'e', 'f'].map(id => agent({ id, name: id.toUpperCase() })) }
  assert.deepEqual(stationSlots(['a', 'b', 'c', 'd', 'e', 'f']).map(slot => slot.row), [0, 1, 2, 0, 1, 2])

  const layer = labelLayer(renderPanel({ state: many })).body
  const anchors = [...layer.matchAll(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="132"/g)].map(match => Number(match[1]))
  assert.ok(anchors.length >= 4, 'one plate per station and the desk')
  // Same column, consecutive rows: the plates march left, but the odd row is
  // shifted back so the two steps are not equal.
  const step01 = Math.abs(anchors[1] - anchors[0])
  const step12 = Math.abs(anchors[2] - anchors[1])
  assert.ok(anchors[1] < anchors[0] && anchors[2] < anchors[1], 'plates still follow the depth order')
  assert.ok(Math.abs(step12 - step01) > 5, `alternate rows must offset the plate (steps ${String(step01)} vs ${String(step12)})`)
})

test('the labels toggle hides the whole layer', { skip: peer === null }, () => {
  assert.match(labelLayer(renderPanel({})).tag, /display="inline"/)
  assert.match(labelLayer(renderPanel({ camera: { ...baseCamera, labels: false } })).tag, /display="none"/)
  // Hiding labels must not hide the stations themselves.
  assert.match(renderPanel({ camera: { ...baseCamera, labels: false } }), /class="office-station/)
})

test('a working station glows and an idle one does not', { skip: peer === null }, () => {
  const glowCount = text => [...text.matchAll(/class="office-glow"/g)].length

  const working = renderPanel({})
  assert.match(working, /class="office-station office-working"/, 'the working station carries the glow class')
  assert.ok(glowCount(working) >= 3, 'its floor pool, desk wash, and monitor halo are all drawn')
  assert.ok(working.includes(`fill="${plugin.GLOW}"`), 'the light is the active-work colour')
  assert.ok(working.includes(`stroke="${plugin.GLOW}"`), 'and it traces the monitor shell')

  const calm = renderPanel({ state: plugin.parseState({ ...state, agents: [agent({ id: 'calm', name: 'Calm', status: 'idle', progress: 0 })] }) })
  assert.doesNotMatch(calm, /office-working/, 'an idle station is not lit')
  assert.equal(glowCount(calm), 0, 'not even the command desk glows')

  for (const status of ['done', 'blocked', 'queued', 'offline']) {
    const other = renderPanel({ state: plugin.parseState({ ...state, agents: [agent({ id: 'other', name: 'Other', status })] }) })
    assert.doesNotMatch(other, /office-working/, `a ${status} station stays dark`)
    assert.equal(glowCount(other), 0, `a ${status} station draws no light`)
  }
})

test('the motion toggle stops the glow pulse but keeps the light', { skip: peer === null }, () => {
  const html = renderPanel({ camera: { ...baseCamera, motion: false } })
  assert.match(html, /data-motion="off"/)
  assert.match(html, /class="office-glow"/, 'the glow markup is still drawn')
  assert.match(html, /office-typing/, 'the typing sway is drawn too, and stopped by the stylesheet')

  const css = readFileSync(join(here, 'office.css'), 'utf8')
  assert.match(css, /\.aseldev-office \.office-glow \{ animation: office-glow/, 'the pulse is the glow animation')
  const motionOff = css.slice(css.indexOf('[data-motion="off"]'))
  const rule = motionOff.slice(0, motionOff.indexOf('}'))
  assert.match(rule, /\.office-glow/, 'motion off lists the glow')
  assert.match(rule, /animation: none/, 'and switches it off')
  assert.match(css, /prefers-reduced-motion[\s\S]*animation: none !important/, 'and a reduced-motion reader never sees it')
})

/**
 * The sprite rectangles of the first `.office-pixels` group carrying `marker`,
 * which is how the scenery's pixel props are told apart from a teammate sprite.
 */
function spriteRects(html, marker) {
  const groups = [...html.matchAll(/class="office-pixels">/g)]
    .map(match => html.slice(match.index, html.indexOf('</g>', match.index)))
    .filter(group => group.includes(marker))
  assert.ok(groups.length > 0, `no sprite carries ${marker}`)
  return [...groups[0].matchAll(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="(#[0-9a-f]{6})"/g)]
    .map(match => ({ x: Number(match[1]), y: Number(match[2]), w: Number(match[3]), h: Number(match[4]), fill: match[5] }))
}

test('the specialist sprite is a three-quarter view turned toward the upper right', { skip: peer === null }, () => {
  const html = renderPanel({})
  // Still no face: the turn exposes the jaw, never the eyes.
  assert.doesNotMatch(html, /office-eyes|office-blink/)
  assert.doesNotMatch(html, /x="-3" y="-21" width="2" height="2"/, 'no eye rectangles')
  assert.doesNotMatch(html, /x="2" y="-21" width="2" height="2"/)

  const rects = spriteRects(html, '#2b3644')
  const back = rects.find(rect => rect.y === -15 && rect.h === 8 && rect.w > 8)
  const skull = rects.find(rect => rect.y === -25 && rect.h === 9 && rect.w >= 9)
  assert.ok(back !== undefined && skull !== undefined, 'the torso and the skull are both drawn')
  const torsoCentre = back.x + back.w / 2
  const headCentre = skull.x + skull.w / 2
  assert.ok(headCentre - torsoCentre >= 1,
    `the head sits up-right of the torso centre (${String(headCentre)} vs ${String(torsoCentre)})`)

  // A sliver of the right jaw and a hint of ear, so the pose reads three-quarter.
  assert.match(html, /x="7" y="-23" width="2" height="6" fill="#94a5b4"/, 'the right cheek and jaw show')
  assert.match(html, /x="6" y="-22" width="1" height="2" fill="#7d8ea0"/, 'with an ear on the hair line')
  assert.match(html, /x="1" y="-16" width="3" height="2" fill="#7d8ea0"/, 'and the neck leaves the collar diagonally')

  // Near arm larger and closer, far arm a sliver behind the torso.
  const nearForearm = rects.find(rect => rect.x === 6 && rect.y === -18 && rect.fill === back.fill)
  const farForearm = rects.find(rect => rect.x === -6 && rect.y === -12)
  const nearHand = rects.find(rect => rect.x === 7 && rect.y === -19)
  const farHand = rects.find(rect => rect.x === -7 && rect.y === -15)
  assert.ok(nearForearm !== undefined && farForearm !== undefined && nearHand !== undefined && farHand !== undefined)
  assert.ok(nearForearm.w > farForearm.w, `the near arm is thicker (${String(nearForearm.w)} vs ${String(farForearm.w)})`)
  assert.ok(nearHand.w > farHand.w, `the near hand is bigger (${String(nearHand.w)} vs ${String(farHand.w)})`)
  assert.ok(nearForearm.h > farForearm.h, 'and reaches further up the desk')

  // The feet are still on the chair, and the turn is drawn in pixels rather than
  // rotated, so the sprite base never moves and the grid stays crisp.
  const base = Math.max(...rects.map(rect => rect.y + rect.h))
  assert.equal(base, 0, 'the sprite base is the seat contact')
  assert.match(html, /x="-5" y="-3" width="4" height="3" fill="#101824"/, 'near shoe')
  assert.match(html, /x="2" y="-3" width="4" height="3" fill="#101824"/, 'far shoe')
  assert.doesNotMatch(html, /rotate\(|skewX|skewY/, 'no group rotation or skew to blur the pixels')
  assert.match(html, /transform="translate\([-\d.]+ [-\d.]+\) scale\([\d.]+\)"/)

  // The hooks the station relies on stay.
  assert.match(html, /office-typing/, 'the typing sway hook stays')
  assert.match(html, /office-signal/, 'the antenna signal stays')
  assert.match(html, /class="office-station office-working"/, 'the working glow still lives on the station')
})

test('the panel shows the empty state when the team has no assignments', { skip: peer === null }, () => {
  const html = renderPanel({ state: { ...plugin.parseState(state), agents: [] } })
  assert.match(html, /No team assignments yet — assign work to a teammate to see them here/)
  assert.doesNotMatch(html, /data-station="alpha"/)
  assert.match(html, /data-station="boss"/, 'the command desk stays visible')
})

test('a refused poll names the failure and keeps the last good scene', { skip: peer === null }, () => {
  const reason = 'the teams store at /home/me/.dsh/teams/state.json is not valid JSON'
  const html = renderPanel({ error: reason })
  assert.match(html, /Office unavailable — the teams store at .* is not valid JSON/)
  assert.match(html, /class="office-live office-live-error" role="status"/)
  assert.match(html, /title="the teams store at .* is not valid JSON"/, 'the untruncated reason is in the tooltip')
  // The stale office stays on screen: a broken store must not blank the scene.
  assert.match(html, /data-station="alpha"/)
  assert.match(html, /data-station="boss"/)

  // Without any good answer yet, the viewport carries the reason itself.
  const cold = renderPanel({ state: null, error: 'the teams store is not valid JSON' })
  assert.match(cold, /Office unavailable — the teams store is not valid JSON/)
  assert.doesNotMatch(cold, /data-station=/, 'no scene without a snapshot')
  assert.doesNotMatch(cold, /Connecting to the office/, 'a failure is not reported as loading')

  // A clean answer clears it.
  assert.doesNotMatch(renderPanel({}), /Office unavailable/)
})

test('a specialist with three jobs is one station and three modal rows', { skip: peer === null }, () => {
  const pooled = plugin.parseState({ ...state, agents: [busy] })

  // One station means one saved specialist, whatever it is carrying.
  const scene = renderPanel({ state: pooled })
  assert.equal([...scene.matchAll(/class="office-station/g)].length, 2, 'one station for the specialist plus the command desk')
  assert.match(scene, /data-station="alpha"/)
  assert.match(scene, /aria-label="Alpha, Frontend developer, Working, 3 jobs, 1 running"/)

  const html = renderPanel({ state: pooled, selectedId: 'alpha', target: { kind: 'agent', id: 'alpha' } })
  assert.match(html, /<dialog class="office-modal" aria-labelledby="office-modal-title"/)
  assert.match(html, /id="office-modal-title">Alpha</)
  assert.match(html, /Frontend developer/)
  assert.match(html, /<dt>Jobs<\/dt>/)
  assert.match(html, /class="office-job-count">1 running · 1 done · 1 queued</, 'the count header summarises the list')
  assert.equal([...html.matchAll(/class="office-job" data-status=/g)].length, 3, 'one row per job')
  assert.deepEqual([...html.matchAll(/class="office-job" data-status="([^"]+)"/g)].map(match => match[1]),
    ['running', 'done', 'queued'], 'the rows are newest first')
  assert.match(html, /Wire the session selector/)
  assert.match(html, /Clamp the modal job titles/)
  assert.match(html, /Read the roster at boot/)
  assert.match(html, /class="office-chip office-job-chip" style="color:#8fc5a1"/, 'the running chip uses the working colour')
  assert.match(html, /class="office-chip office-job-chip" style="color:#8bbcff"/, 'the done chip uses the done colour')
  assert.match(html, /aria-valuenow="30"/)
  assert.match(html, /aria-valuenow="100"/)
  assert.match(html, /aria-valuenow="47"/, 'the aggregate bar keeps the specialist progress')
  assert.match(html, /Reports to/)
  assert.match(html, /Asel/, 'reports to the human owner when managerId is boss')
  assert.match(html, /Started/)
  assert.match(html, /Updated/)
  assert.match(html, /office-portrait/, 'the large pixel portrait is rendered')
})

test('an idle specialist says it has no assignments in this session', { skip: peer === null }, () => {
  const idle = agent({ id: 'idle', name: 'Idle', status: 'idle', progress: 0, jobs: [] })
  const one = plugin.parseState({ ...state, agents: [idle] })

  assert.match(renderPanel({ state: one }), /aria-label="Idle, Frontend developer, Idle"/,
    'a station without jobs carries no job note')

  const html = renderPanel({ state: one, selectedId: 'idle', target: { kind: 'agent', id: 'idle' } })
  assert.match(html, /class="office-job-empty">No assignments in this session</)
  assert.doesNotMatch(html, /class="office-jobs"/, 'no list without jobs')
  assert.doesNotMatch(html, /class="office-job-count"/)
  assert.match(html, /<span>Started —<\/span>/, 'a jobless specialist has no job stamps')
})

test('the station draws the specialist aggregate, not one of its jobs', { skip: peer === null }, () => {
  const pooled = agent({
    id: 'pooled',
    name: 'Pooled',
    status: 'review',
    progress: 70,
    jobs: [job({ id: 'j-a', status: 'failed', progress: 80 }), job({ id: 'j-b', status: 'done', progress: 100 })],
  })
  const html = renderPanel({ state: plugin.parseState({ ...state, agents: [pooled] }) })
  assert.match(html, /class="office-station" data-station="pooled" data-status="review"/,
    'the dot takes the aggregate status, not a job status')
  assert.match(html, /aria-label="Pooled, Frontend developer, Needs your approval, 2 jobs, 0 running"/)
  // The nameplate bar: (132 - 2) * 70 / 100 = 91, in the review colour.
  assert.match(html, /width="91" height="1.3" fill="#ffcb85"/, 'the plate bar takes the aggregate progress and colour')
})

/** The declaration block of one selector in a stylesheet. */
function ruleOf(css, selector) {
  const at = css.indexOf(`${selector} {`)
  assert.notEqual(at, -1, `missing rule: ${selector}`)
  return css.slice(at, css.indexOf('}', at))
}

test('the job list is a scrollable structure that survives a 360 px modal', { skip: peer === null }, () => {
  const html = renderPanel({ state: plugin.parseState({ ...state, agents: [busy] }), selectedId: 'alpha', target: { kind: 'agent', id: 'alpha' } })
  assert.match(html, /<ul class="office-jobs" role="list">/, 'the rows keep their list semantics without bullets')

  const css = readFileSync(join(here, 'office.css'), 'utf8')
  const dialog = ruleOf(css, '.aseldev-office .office-modal')
  assert.match(dialog, /max-height:/, 'the dialog is bounded')
  assert.match(dialog, /overflow: auto/, 'and scrolls its own rows')
  assert.match(dialog, /width: min\(560px, calc\(100vw - 24px\)\)/, 'it stays inside a 360 px viewport')
  assert.match(ruleOf(css, '.aseldev-office .office-job-title'), /-webkit-line-clamp: 2/, 'a long title clamps to two lines')
  assert.match(ruleOf(css, '.aseldev-office .office-job-title'), /overflow-wrap: anywhere/)
  assert.match(ruleOf(css, '.aseldev-office .office-jobs'), /list-style: none/)
})

test('the modal has a boss view with counts and the project', { skip: peer === null }, () => {
  const html = renderPanel({ selectedId: 'boss', target: { kind: 'boss' } })
  assert.match(html, /id="office-modal-title">Asel</)
  assert.match(html, /Human · in command/)
  assert.match(html, /2 teammates · 1 working · 1 need you/)
  assert.match(html, /AI HQ/)
  assert.match(html, /Port the office into the plugin\./)
  assert.doesNotMatch(html, /Started/, 'the command desk has no assignment stamps')
  assert.doesNotMatch(html, /Reports to/, 'the owner reports to nobody')
})

// ----------------------------------------------------------- session selector

/** The host's `sessions` answer: running rows grouped first, capped by the host. */
const sessionsWire = {
  currentSessionId: 's-1',
  sessions: [
    { id: 's-3', title: 'Ship the selector', status: 'working', updatedAt: '2026-03-01T10:00:00.000Z', teammates: 3, working: 2, running: true },
    { id: 's-2', title: '', status: 'idle', updatedAt: '2026-03-01T09:00:00.000Z', teammates: 1, working: 0, running: false },
    { id: 's-1', title: 'Office work', status: 'idle', updatedAt: '2026-03-01T08:00:00.000Z', teammates: 2, working: 1, running: false },
  ],
}

test('selector options put this session first, mark running ones, and fall back to the id', () => {
  const list = plugin.parseSessions(sessionsWire)
  assert.equal(list.currentSessionId, 's-1')
  assert.deepEqual(list.sessions.map(session => session.id), ['s-3', 's-2', 's-1'])
  assert.equal(list.sessions[0].running, true)
  assert.equal(list.sessions[0].working, 2)
  assert.equal(list.sessions[1].title, '', 'a session with no title yet keeps an empty one')

  const options = plugin.sessionOptions(list, list.currentSessionId, translate)
  assert.deepEqual(options.map(option => option.value), ['s-1', 's-3', 's-2'],
    'this session first, then the host order, without duplicating this conversation')
  assert.deepEqual(options.map(option => option.label), [
    '(this session)',
    'Ship the selector — 2 working · running',
    's-2 — 0 working',
  ])

  // The host owns the cap: the panel renders whatever list it is given.
  const capped = plugin.parseSessions({
    currentSessionId: 's-1',
    sessions: Array.from({ length: 30 }, (_, index) => ({ id: `m-${String(index)}`, title: `T${String(index)}`, working: 0, running: false })),
  })
  assert.equal(capped.sessions.length, 30)
  assert.equal(plugin.sessionOptions(capped, 's-1', translate).length, 31, '30 rows plus this session')

  // Before the first list answer the shell's own conversation is still selectable.
  assert.deepEqual(plugin.sessionOptions(null, 's-9', translate), [{ value: 's-9', label: '(this session)' }])
  assert.deepEqual(plugin.sessionOptions(null, null, translate), [])

  // A newer host that sends no list is a contract failure, not an empty list.
  assert.throws(() => plugin.parseSessions({ currentSessionId: 's-1' }), /sessions/)
  assert.throws(() => plugin.parseSessions(null), /object/)
})

test('the subtitle names the session the drawn snapshot belongs to', () => {
  const list = plugin.parseSessions(sessionsWire)
  assert.equal(plugin.sessionTitle(list, 's-1'), 'Office work')
  assert.equal(plugin.sessionTitle(list, 's-2'), 's-2', 'an untitled session shows its id')
  assert.equal(plugin.sessionTitle(list, 'gone'), 'gone', 'a session the host does not list still names itself')
  assert.equal(plugin.sessionTitle(list, ''), null, 'no session yet leaves the tagline in place')
  assert.equal(plugin.sessionTitle(null, 's-1'), null, 'before the first list answer the tagline stays')
})

test('both routes carry the trust header, and the list names the asking conversation', async () => {
  const calls = []
  const previous = globalThis.fetch
  const reply = (body, ok = true) => ({ ok, status: ok ? 200 : 403, json: async () => body })
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers })
    return url.includes('/sessions')
      ? reply(sessionsWire)
      : reply(String(url).includes('refused') ? { error: 'the teams store is not valid JSON' } : state, !String(url).includes('refused'))
  }
  try {
    const api = plugin.createOfficeApi()
    const signal = new AbortController().signal

    assert.equal((await api.state('s 1', signal)).sessionId, 's-1')
    assert.equal(calls[0].url, '/aseldev-office/api/state?sessionId=s%201')
    assert.equal(calls[0].headers['x-aseldev-office'], '1')

    assert.equal((await api.sessions('s-1', signal)).currentSessionId, 's-1')
    assert.equal(calls[1].url, '/aseldev-office/api/sessions')
    assert.equal(calls[1].headers['x-aseldev-office'], '1', 'the list route needs the trust header too')
    assert.equal(calls[1].headers['x-aseldev-office-session'], 's-1', 'the host learns which conversation is asking')

    await api.sessions(null, signal)
    assert.equal(calls[2].headers['x-aseldev-office-session'], undefined, 'no conversation yet sends no hint')

    // The host's own reason is what the header chip shows, for either route.
    await assert.rejects(() => api.state('refused', signal), /the teams store is not valid JSON/)
  } finally {
    globalThis.fetch = previous
  }
})

test('the header carries the session selector left of the metrics', { skip: peer === null }, () => {
  const list = plugin.parseSessions(sessionsWire)
  const html = renderPanel({ sessions: list, polledId: 's-1' })
  assert.match(html, /<label class="office-session"><span>Session<\/span><select class="office-select"><option value="s-1" selected="">\(this session\)<\/option>/)
  assert.match(html, /Ship the selector — 2 working · running/)
  assert.ok(html.indexOf('class="office-session"') < html.indexOf('class="office-metrics"'),
    'the selector sits left of the metrics')
  assert.match(html, /Floor 01 · Office work/, 'the subtitle names the shown session')

  // No list yet: the panel still lets the reader stay on this conversation.
  const cold = renderPanel({ sessions: null, polledId: 's-1' })
  assert.match(cold, /<option value="s-1" selected="">\(this session\)<\/option>/)
  assert.match(cold, /Your direction\. Your team\. Your office\./, 'without a session title the tagline stays')
})

// ------------------------------------------------------ interactive harness
//
// The selector's behaviour lives in effects (poll on open, re-poll on a pick,
// fall back when a session disappears), so these cases drive the shipped
// bundle's real component in jsdom with a hand-cranked interval scheduler: the
// panel's 2 s and 10 s polls fire only when a case says so.

/** A jsdom page whose interval scheduler the case advances itself. */
function interactivePage() {
  const dom = new peer.JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:3080/' })
  const timers = []
  dom.window.setInterval = (fn, ms) => { timers.push({ fn, ms, dead: false }); return timers.length }
  dom.window.clearInterval = id => { const timer = timers[id - 1]; if (timer !== undefined) timer.dead = true }
  // jsdom exposes <dialog> without modality, so the panel's showModal/close are
  // shimmed to the open attribute; the component is unchanged.
  dom.window.HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute('open', '') }
  dom.window.HTMLDialogElement.prototype.close = function close() { this.removeAttribute('open') }
  return { dom, timers }
}

/** A stub host client for both routes, recording the session each state poll asked for. */
function stubApi(overrides = {}) {
  const stateCalls = []
  const api = {
    async state(sessionId, signal) {
      stateCalls.push(sessionId)
      const answer = overrides.state === undefined ? { ...state, sessionId } : await overrides.state(sessionId, signal)
      return plugin.parseState(answer)
    },
    async sessions(currentSessionId, signal) {
      if (overrides.sessions === undefined) return plugin.parseSessions(sessionsWire)
      return plugin.parseSessions(await overrides.sessions(currentSessionId, signal))
    },
  }
  return { api, stateCalls }
}

/** Render the real launcher into a jsdom page and open the overlay. */
async function openLauncher(api, { current = 's-1', openConversation = async () => {} } = {}) {
  const { dom, timers } = interactivePage()
  const browserGlobals = {
    window: globalThis.window, document: globalThis.document,
    Element: globalThis.Element, DOMPoint: globalThis.DOMPoint,
  }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  // The bundle is a browser script: `Element` and `DOMPoint` are globals there.
  globalThis.Element = dom.window.Element
  globalThis.DOMPoint = dom.window.DOMPoint
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const { plugin: real } = loadBundle({ react: peer.React, 'react/jsx-runtime': peer.jsxRuntime }, dom.window)
  const container = dom.window.document.getElementById('root')
  const root = peer.createRoot(container)
  const act = peer.React.act
  // Every interaction settles inside act, so the panel's effect-driven state
  // updates are flushed before the case asserts on them.
  const run = async body => {
    await act(async () => {
      await body()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }

  await run(() => {
    root.render(peer.React.createElement(real.OfficeLauncher, {
      wide: true,
      api,
      t: translate,
      openConversation,
      useSessions: selector => selector({ current }),
    }))
  })
  await run(() => { container.querySelector('.aseldev-office-launch').click() })

  const select = () => container.querySelector('.office-select')
  const jobs = () => [...container.querySelectorAll('.office-job')]
  return {
    text: () => container.innerHTML,
    value: () => select().value,
    jobs,
    async pick(id) {
      await run(() => {
        const node = select()
        node.value = id
        node.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      })
    },
    /** Open one station's detail modal the way a reader does: click its body. */
    async openStation(id) {
      await run(() => {
        container.querySelector(`.office-station[data-station="${id}"]`)
          .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
    },
    /** Click one job row, by its id in the list. */
    async clickJob(index) {
      await run(() => { jobs()[index].click() })
    },
    /** Press a key on one job row; the row handles Enter and Space itself. */
    async pressJob(index, key) {
      await run(() => {
        jobs()[index].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      })
    },
    /** Advance every interval registered for `ms`, as a real tick would. */
    async tick(ms) {
      await run(() => {
        for (const timer of timers) if (!timer.dead && timer.ms === ms) timer.fn()
      })
    },
    async close() {
      await run(() => { root.unmount() })
      dom.window.close()
      globalThis.window = browserGlobals.window
      globalThis.document = browserGlobals.document
      globalThis.Element = browserGlobals.Element
      globalThis.DOMPoint = browserGlobals.DOMPoint
      delete globalThis.IS_REACT_ACT_ENVIRONMENT
    },
  }
}

test('picking a session re-polls the state route for that id', { skip: peer === null }, async () => {
  const { api, stateCalls } = stubApi()
  const page = await openLauncher(api)
  try {
    assert.deepEqual(stateCalls, ['s-1'], 'the panel polls this conversation on open')
    assert.match(page.text(), /data-station="alpha"/)
    assert.equal(page.value(), 's-1', 'this session is the default selection')

    await page.pick('s-3')
    assert.deepEqual(stateCalls, ['s-1', 's-3'], 'a pick re-polls immediately')
    assert.match(page.text(), /Floor 01 · Ship the selector/, 'the subtitle follows the shown session')

    await page.tick(2000)
    assert.deepEqual(stateCalls.slice(-1), ['s-3'], 'the 2 s cadence follows the picked session')
  } finally {
    await page.close()
  }
})

test('a failed sessions poll keeps the scene and leaves the state cadence alone', { skip: peer === null }, async () => {
  const { api, stateCalls } = stubApi({ sessions: () => { throw new Error('the session list is unavailable') } })
  const page = await openLauncher(api)
  try {
    assert.deepEqual(stateCalls, ['s-1'], 'the state route is polled while the list fails')
    assert.match(page.text(), /data-station="alpha"/, 'the scene survives a failed sessions poll')
    assert.match(page.text(), /Office unavailable — the session list is unavailable/)
    assert.equal(page.value(), 's-1', 'this conversation stays selectable without a list')

    await page.tick(2000)
    assert.equal(stateCalls.length, 2, 'the 2 s state cadence is untouched')
    await page.tick(10_000)
    assert.match(page.text(), /data-station="alpha"/, 'the list retry does not clear the scene')
  } finally {
    await page.close()
  }
})

test('a session that disappears falls back to this one and keeps the last good scene', { skip: peer === null }, async () => {
  let dropped = false
  const { api, stateCalls } = stubApi({
    sessions: () => (dropped
      ? { ...sessionsWire, sessions: sessionsWire.sessions.filter(row => row.id !== 's-3') }
      : sessionsWire),
    // The fallback's first answer never lands, so the kept scene is observable.
    state: sessionId => (dropped && sessionId === 's-1' ? new Promise(() => {}) : { ...state, sessionId }),
  })
  const page = await openLauncher(api)
  try {
    await page.pick('s-3')
    assert.equal(page.value(), 's-3')

    dropped = true
    await page.tick(10_000)
    assert.equal(page.value(), 's-1', 'the vanished session falls back to this conversation')
    assert.equal(stateCalls.at(-1), 's-1', 'the fallback re-polls this conversation')
    assert.match(page.text(), /data-station="alpha"/, 'the last good scene stays until the next answer')
    assert.match(page.text(), /Floor 01 · s-3/,
      'the kept scene names its own session, by id now that the host no longer titles it')
  } finally {
    await page.close()
  }
})

test('a job row opens that job\'s conversation and gets out of the way', { skip: peer === null }, async () => {
  const opened = []
  const { api } = stubApi({ state: sessionId => ({ ...state, sessionId, agents: [busy] }) })
  const page = await openLauncher(api, { openConversation: async (id, parent) => { opened.push([id, parent]) } })
  try {
    await page.openStation('alpha')
    assert.equal(page.jobs().length, 3, 'every job of the specialist is a row')
    assert.equal(page.jobs()[0].tagName, 'BUTTON', 'a row is a real button')
    assert.equal(page.jobs()[0].getAttribute('aria-label'), 'Wire the session selector, Running, open conversation')

    await page.clickJob(0)
    assert.deepEqual(opened, [['j-3', 's-1']],
      'one call per click, naming the job and the coordinator whose office is on screen')
    assert.doesNotMatch(page.text(), /class="aseldev-office"/,
      'the overlay closes so the reader lands in the conversation')
  } finally {
    await page.close()
  }
})

test('a job row also opens from the keyboard, and a double refusal keeps the office', { skip: peer === null }, async () => {
  const opened = []
  const { api } = stubApi({ state: sessionId => ({ ...state, sessionId, agents: [busy] }) })
  const page = await openLauncher(api, { openConversation: async (id, parent) => { opened.push([id, parent]) } })
  try {
    await page.openStation('alpha')
    await page.pressJob(1, 'Enter')
    assert.deepEqual(opened, [['j-2', 's-1']], 'Enter activates the row once')
    assert.doesNotMatch(page.text(), /class="aseldev-office"/)
  } finally {
    await page.close()
  }

  const refusing = await openLauncher(api, {
    // Both the direct open and the worker path refused, which is the one case
    // the injected navigation rejects in.
    openConversation: async () => { throw new Error('sessions.selectSubagent: j-3 is not a healthy catalog child') },
  })
  try {
    await refusing.openStation('alpha')
    await refusing.pressJob(0, ' ')
    assert.match(refusing.text(), /Office unavailable — sessions\.selectSubagent: j-3 is not a healthy catalog child/,
      'the refusal that lands is reported in the chip, never thrown at the shell')
    assert.match(refusing.text(), /class="aseldev-office"/, 'and the office stays up')
    assert.equal(refusing.jobs().length, 3, 'with its rows intact')
  } finally {
    await refusing.close()
  }
})
