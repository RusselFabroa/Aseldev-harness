/**
 * Browser smoke for the teams panel: installed Google Chrome, the already
 * running server only.
 *
 * What it does, in order, each stage in its own throwaway browser context
 * (fresh localStorage, no persisted user selection, nothing written to disk
 * except the optional screenshot):
 *
 *   1. real, unmocked — boots the shell, proves the plugin is in the served
 *      boot graph and its bundle answers, then opens the Team launcher and the
 *      panel and asserts the copy matches the context's locale (English and
 *      Chinese runs). With `--session <id>` it also seeds this context's
 *      selection so the panel reads the real team for that coordinator.
 *   2. empty state — a fresh context. This deployment auto-selects a recent
 *      session, so "correct" here means either the no-session guidance or a
 *      selected session with no team yet; an error line is the failure.
 *   3. error case — the state route is aborted (mocked failure) and the panel
 *      must surface the transport copy with a retry control, not crash. Only
 *      this stage tolerates the browser's own network-failure console report.
 *   4. `--fixtures` only — the state and action routes are answered by fixtures
 *      so the controls can be exercised (per-row control states, the message
 *      form, retry/cancel posting the exact action body and settling the busy
 *      state, an open-conversation click that must stay contained, and a
 *      coordinator switch that must drop the previous team without posting).
 *      The real host is never touched by this stage.
 *
 * Every role lookup uses `exact: true` and every row-scoped control is looked
 * up inside its own row: the open panel also renders "Close the team panel"
 * (which contains "Team panel"), and an active row and a queued row both offer
 * Cancel, so panel-wide substring or count assertions are inherently ambiguous.
 *
 * Persistent user state is never mutated: every context is incognito, the
 * English/Chinese runtime comes from `context.locale` (the shipped locale
 * plugin derives the active locale from the browser while no stored preference
 * exists), and the only host calls this script makes are GETs of `state` in
 * stages 1–3 — asserted, not assumed.
 *
 * The browser: Playwright is resolved from `apps/web` (the package that
 * depends on it) and launched with `channel: 'chrome'`; this checkout has no
 * downloaded browser. Navigation uses `domcontentloaded`, never
 * `networkidle`: the app keeps two long-lived WebSocket downlinks open, so
 * "network idle" never settles.
 *
 * Usage:
 *   node aseldev/plugins/teams/browser-smoke.mjs                 # stages 1–3
 *   node aseldev/plugins/teams/browser-smoke.mjs --fixtures      # + stage 4
 *   node aseldev/plugins/teams/browser-smoke.mjs --session <id>  # real coordinator
 *   node aseldev/plugins/teams/browser-smoke.mjs --shell-only    # harness only
 * Options: --url <origin> (default http://127.0.0.1:3080),
 *          --shot <path> (default lib/teams-panel.png, gitignored), --no-shot.
 *
 * Exit code 0 = every assertion passed; 1 = a named check failed.
 */

import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..', '..')

/** Package name: the boot-graph row id and the client bundle's `id`. */
const PLUGIN_ID = '@aseldev/dsh-teams'

/** API prefix owned by the host half. */
const API_PREFIX = '/aseldev-teams/api'

const argv = process.argv.slice(2)
const has = (name) => argv.includes(name)
const value = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 || argv[index + 1] === undefined ? fallback : argv[index + 1]
}

const shellOnly = has('--shell-only')
const withFixtures = has('--fixtures')
const noShot = has('--no-shot')
const base = value('--url', 'http://127.0.0.1:3080')
const sessionId = value('--session', undefined)
const shotPath = resolve(value('--shot', join(here, 'lib', 'teams-panel.png')))

const baseUrl = new URL(base)
/** Every local request must target this port; any other local server is a failure. */
const basePort = baseUrl.port === '' ? (baseUrl.protocol === 'https:' ? '443' : '80') : baseUrl.port

/** Panel copy in both shipped locales, as the bundle's dictionaries produce it. */
const COPY = {
  en: {
    locale: 'en-US',
    button: 'Team panel',
    title: 'Team',
    noSession: 'No session selected',
    follow: 'Open a session on the left',
    idle: 'Team idle',
    loading: 'Reading team state',
    settled: 'settled',
    resume: 'Resume',
    retry: 'Retry',
    transport: /Cannot reach the teams endpoint/,
    malformed: /Malformed team state/,
  },
  zh: {
    locale: 'zh-CN',
    button: '团队任务面板',
    title: '团队',
    noSession: '未选择会话',
    follow: '先在左侧打开一个会话',
    idle: '团队空闲',
    loading: '正在读取团队状态',
    settled: '已结算',
    resume: '恢复调度',
    retry: '重试',
    transport: /无法连接团队接口/,
    malformed: /团队状态格式不正确/,
  },
}

const results = []
let browser

/**
 * Record one named check.
 * @param name - check label.
 * @param body - async body; throw to fail.
 */
async function check(name, body) {
  try {
    const detail = await body()
    results.push({ name, ok: true })
    console.log(`  ok   ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    results.push({ name, ok: false, detail: message })
    console.log(`  FAIL ${name} — ${message}`)
  }
}

/** An assertion helper that names the observed value on failure. */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Wait one turn of the event loop, for effects that settle on the next frame. */
function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Wait for one captured fixture action to arrive.
 * @param actions - captured POST bodies.
 * @param name - `action` value to wait for.
 * @param timeoutMs - bound for the wait.
 * @returns the captured body, or undefined on timeout.
 */
async function waitForAction(actions, name, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = actions.find(candidate => candidate.action === name)
    if (found !== undefined) return found
    await sleep(50)
  }
  return undefined
}

/**
 * Poll one asynchronous condition until it holds.
 * @param predicate - condition to await (may be async).
 * @param label - what is being awaited, for the timeout message.
 * @param timeoutMs - bound for the wait.
 */
async function until(predicate, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * Resolve one task row by its title.
 *
 * The row DOM contract is: title span → row-top div → row container, and the
 * row's controls are the row container's descendants. Restricting lookups to
 * one row is what keeps 'Cancel' unambiguous (an active row and a queued row
 * both offer it) and makes the assertions independent of how many rows exist.
 * @param dialog - the panel dialog.
 * @param title - the row's task title.
 * @returns the row container locator.
 */
function rowOf(dialog, title) {
  // `.first()` picks the row's own title span: the assign form's prerequisite
  // list also renders task titles further down the panel.
  return dialog.getByText(title, { exact: true }).first().locator('xpath=../..')
}

/** Accessible-name options for exact role lookups (substring matching is the default). */
const exactName = (name) => ({ name, exact: true })

/**
 * Load Playwright the way the repository installs it.
 * @returns the chromium launcher.
 */
async function loadChromium() {
  const shellRequire = createRequire(join(repo, 'apps', 'web', 'package.json'))
  // Windows: a dynamic import needs a file URL, not a bare absolute path.
  const playwright = await import(pathToFileURL(shellRequire.resolve('playwright')).href)
  const chromium = playwright.chromium ?? playwright.default?.chromium
  assert(chromium !== undefined, 'playwright resolved without a chromium export')
  return chromium
}

/**
 * One throwaway browser context with guards attached.
 * @param copy - the locale copy this page expects.
 * @param init - optional `addInitScript` source (seeded selection).
 * @returns the page plus its recorder.
 */
async function openPage(copy, init) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: copy.locale,
  })
  if (init !== undefined) await context.addInitScript(init, sessionId)
  const page = await context.newPage()
  const recorded = { consoleErrors: [], pageErrors: [], apiMutations: [], foreignPorts: [] }

  page.on('console', (message) => {
    if (message.type() === 'error') recorded.consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => { recorded.pageErrors.push(error.message) })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith(API_PREFIX)) return
    if (request.method() !== 'GET') recorded.apiMutations.push(`${request.method()} ${url.pathname}`)
  })
  page.on('request', (request) => {
    const url = new URL(request.url())
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname === '::1'
    const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
    if (local && port !== basePort) recorded.foreignPorts.push(request.url())
  })

  const response = await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  assert(response !== null, 'no response for the shell document')
  assert(response.ok(), `shell document answered HTTP ${String(response.status())}`)
  return { context, page, recorded }
}

/** Boot checks shared by every stage. */
async function assertShellBoots(page, recorded, copy) {
  await page.waitForSelector('[data-shell-overlay]', { timeout: 30_000 })
  const sweep = await page.evaluate(() => {
    const text = document.body.innerText
    return text.includes('did not activate') ? text.slice(0, 300) : ''
  })
  assert(sweep === '', `boot sweep reported: ${sweep}`)
  assert(recorded.pageErrors.length === 0, `page errors before any interaction: ${recorded.pageErrors.slice(0, 2).join(' | ')}`)
  // A panel that cannot reach its endpoint is a broken verification run, not a
  // shell problem; the stages assert it explicitly where they mock the route.
  return `${copy.locale} shell mounted`
}

/**
 * Fail with the real cause in one sentence: a missing boot-graph row means the
 * plugin is not mounted, not that the sidebar renders slowly.
 * @param page - page in a booted shell.
 */
async function assertPluginMounted(page) {
  const present = await page.evaluate(
    (id) => (globalThis.__DSH_BOOT__?.entries ?? []).some(entry => entry.id === id),
    PLUGIN_ID,
  )
  if (!present) {
    throw new Error(
      `${PLUGIN_ID} is not in the boot graph — the plugin is not mounted `
      + '(run aseldev/setup-profile.ps1, restart the harness, re-run this smoke)',
    )
  }
}

/**
 * Open the launcher button and wait for the panel dialog.
 *
 * Every lookup is `exact`: the open panel also renders a close control whose
 * accessible name ("Close the team panel") CONTAINS the launcher's
 * ("Team panel"), so substring matching would make the launcher ambiguous the
 * moment the panel opens.
 * @param page - page in a booted shell.
 * @param copy - the locale copy this page expects.
 * @returns the panel dialog locator.
 */
async function openPanel(page, copy) {
  await assertPluginMounted(page)
  const button = page.getByRole('button', exactName(copy.button))
  await button.waitFor({ state: 'visible', timeout: 10_000 })
  assert((await button.getAttribute('aria-expanded')) === 'false', 'launcher must be collapsed before the click')
  await button.click()
  const dialog = page.getByRole('dialog', exactName(copy.title))
  await dialog.waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForFunction(() => (document.querySelector('[role="dialog"]')?.innerText ?? '').trim().length > 0, null, { timeout: 10_000 })
  assert((await button.getAttribute('aria-expanded')) === 'true', 'launcher must report expanded while the panel is open')
  return dialog
}

/**
 * Fail on uncaught errors, a mutated API, or a second local server.
 * @param page - page to close.
 * @param recorded - the page's recorder.
 * @param options - `allowMutations` for the fixture stage (its routes answer
 *   the POSTs); `allowConsole` for a stage that deliberately breaks a route, so
 *   only that stage tolerates the browser's own network-failure report.
 */
async function assertClean(page, recorded, { allowMutations = false, allowConsole } = {}) {
  assert(recorded.foreignPorts.length === 0, `another local server was contacted: ${recorded.foreignPorts.slice(0, 2).join(' | ')}`)
  if (!allowMutations) {
    assert(recorded.apiMutations.length === 0, `persistent API calls were attempted: ${recorded.apiMutations.slice(0, 3).join(' | ')}`)
  }
  assert(recorded.pageErrors.length === 0, `uncaught page errors: ${recorded.pageErrors.slice(0, 3).join(' | ')}`)
  const relevant = recorded.consoleErrors.filter((text) => {
    if (/favicon|404 \(Not Found\)/.test(text)) return false
    if (allowConsole !== undefined && allowConsole.test(text)) return false
    return true
  })
  assert(relevant.length === 0, `console errors: ${relevant.slice(0, 3).join(' | ')}`)
  await page.close()
}

/** Specialists the fixture stage advertises (both modes, so the write rule is visible). */
const FIXTURE_SPECIALISTS = [
  { id: 'backend', name: 'Senior Backend Developer', instructions: 'implement', mode: 'write' },
  { id: 'frontend', name: 'Senior Frontend Developer', instructions: 'implement', mode: 'write' },
  { id: 'qa', name: 'Senior QA', instructions: 'verify', mode: 'read' },
]

/** The second coordinator the fixture stage switches to. */
const SECOND_COORDINATOR = 'fixture-coordinator-2'

/**
 * Build a synthetic `state` answer for one coordinator.
 * @param requestedId - the `sessionId` the panel asked about.
 * @returns the fixture payload (an empty team for the second coordinator).
 */
function fixtureState(requestedId) {
  const coordinators = [
    { sessionId: requestedId, label: 'Fixture team' },
    { sessionId: SECOND_COORDINATOR, label: 'Second team' },
  ]
  if (requestedId === SECOND_COORDINATOR) return { specialists: FIXTURE_SPECIALISTS, team: null, coordinators, maxLimit: 8 }
  return {
    specialists: FIXTURE_SPECIALISTS,
    team: {
      sessionId: requestedId,
      maxActive: 2,
      // Paused, so the footer offers Resume for the action-containment check.
      paused: true,
      tasks: [
        {
          id: 'task-a', specialistId: 'backend', title: 'p', prompt: 'p', status: 'working',
          workerId: 'fixture-worker-backend', files: ['src/auth'], dependsOn: [],
        },
        {
          id: 'task-b', specialistId: 'frontend', title: 'p', prompt: 'p', status: 'done',
          workerId: 'fixture-worker-frontend', files: [], dependsOn: ['task-a'], result: 'looks fine',
        },
        {
          id: 'task-c', specialistId: 'qa', title: 'p', prompt: 'p', status: 'queued',
          files: [], dependsOn: [],
        },
      ],
    },
    coordinators,
    maxLimit: 8,
  }
}

console.log(`teams browser smoke → ${base}${shellOnly ? ' (shell only)' : ''}`)
if (!noShot) mkdirSync(dirname(shotPath), { recursive: true })

try {
  const chromium = await loadChromium()
  browser = await chromium.launch({ channel: 'chrome', headless: true })

  if (shellOnly) {
    const copy = COPY.en
    const { page, recorded } = await openPage(copy)
    await check('shell document answers and the frame mounts', () => assertShellBoots(page, recorded, copy))
    await check('no other local server is contacted', async () => {
      assert(recorded.foreignPorts.length === 0, recorded.foreignPorts.slice(0, 2).join(' | '))
      return `only port ${basePort}`
    })
    await assertClean(page, recorded)
  } else {
    // ── stage 1: real, unmocked, English runtime ─────────────────────────────
    {
      const copy = COPY.en
      const seed = sessionId === undefined
        ? undefined
        : (id) => { globalThis.localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id })) }
      const { page, recorded } = await openPage(copy, seed)

      await check(`[${copy.locale}] shell boots`, () => assertShellBoots(page, recorded, copy))

      await check(`[${copy.locale}] boot graph carries the plugin and its bundle answers`, async () => {
        const row = await page.evaluate(async (id) => {
          const graph = globalThis.__DSH_BOOT__ ?? { entries: [] }
          const found = graph.entries.find(entry => entry.id === id)
          if (found === undefined) return { present: false, total: graph.entries.length }
          const response = await fetch(found.url)
          const body = await response.text()
          return { present: true, status: response.status, banner: body.slice(0, 80), rev: found.rev }
        }, PLUGIN_ID)
        assert(row.present, `${PLUGIN_ID} is not in the boot graph (plugin not mounted yet?)`)
        assert(row.status === 200, `bundle fetch answered ${String(row.status)}`)
        assert(row.banner.includes('__ModuleLoader__.load'), `unexpected bundle head: ${row.banner}`)
        return `rev ${String(row.rev)}`
      })

      await check(`[${copy.locale}] launcher is English under an English runtime`, async () => {
        await assertPluginMounted(page)
        const button = page.getByRole('button', exactName(copy.button))
        await button.waitFor({ state: 'visible', timeout: 10_000 })
        const aria = await button.getAttribute('aria-label')
        assert(aria === copy.button, `launcher aria-label is ${JSON.stringify(aria)}, expected ${JSON.stringify(copy.button)}`)
        return `“${copy.button}”`
      })

      await check(`[${copy.locale}] launcher geometry matches the sidebar entry`, async () => {
        await assertPluginMounted(page)
        const teamButton = page.getByRole('button', exactName(copy.button))
        const brainButton = page.getByRole('button', { name: "Open Asel's Brain", exact: true })
        const teamBox = await teamButton.boundingBox()
        const brainBox = await brainButton.boundingBox()
        assert(teamBox !== null && brainBox !== null, 'both launcher buttons must measure')
        assert(Math.abs(teamBox.width - brainBox.width) <= 1,
          `Team button width ${String(teamBox.width)} differs from the sidebar row ${String(brainBox.width)}`)
        assert(Math.abs(teamBox.height - brainBox.height) <= 1,
          `Team button height ${String(teamBox.height)} differs from the sidebar row ${String(brainBox.height)}`)
        assert(Math.abs(teamBox.x - brainBox.x) <= 1,
          `Team button starts at x=${String(teamBox.x)}, the sidebar row at x=${String(brainBox.x)}`)
        return `${String(teamBox.width)}x${String(teamBox.height)}px aligned with the sidebar entry`
      })

      await check(`[${copy.locale}] panel opens on the real API without a failure line`, async () => {
        const dialog = await openPanel(page, copy)
        const text = (await dialog.innerText()).replace(/\s+/g, ' ')
        assert(!copy.transport.test(text), `panel reports a transport failure: ${text.slice(0, 160)}`)
        assert(!copy.malformed.test(text), `panel reports a malformed answer: ${text.slice(0, 160)}`)
        if (sessionId === undefined) {
          // This deployment auto-selects a recent session in a fresh context, so
          // both states are correct: nothing selected, or a selected session that
          // has no team yet. What must never appear is an error.
          const guidance = text.includes(copy.follow) || text.includes(copy.noSession)
          assert(guidance || text.includes(copy.idle) || text.includes(copy.loading),
            `expected no-session guidance or an idle team, got: ${text.slice(0, 160)}`)
          return `${guidance ? 'no session selected' : 'auto-selected session, empty team'} — ${text.slice(0, 60)}`
        }
        assert(text.includes(copy.title), 'panel title missing')
        return text.slice(0, 90)
      })

      if (!noShot) await page.screenshot({ path: shotPath })
      await check(`[${copy.locale}] no uncaught errors, no API mutation, no second server`, async () => {
        await assertClean(page, recorded)
        return 'clean'
      })
    }

    // ── stage 2: real, unmocked, Chinese runtime ─────────────────────────────
    {
      const copy = COPY.zh
      const { page, recorded } = await openPage(copy)
      await check(`[${copy.locale}] shell boots`, () => assertShellBoots(page, recorded, copy))
      await check(`[${copy.locale}] launcher and panel are Chinese under a Chinese runtime`, async () => {
        const dialog = await openPanel(page, copy)
        const text = (await dialog.innerText()).replace(/\s+/g, ' ')
        assert(!copy.transport.test(text), `panel reports a transport failure: ${text.slice(0, 160)}`)
        assert(text.includes(copy.title), `panel title "${copy.title}" missing`)
        return 'Chinese copy'
      })
      await check(`[${copy.locale}] no uncaught errors, no API mutation, no second server`, async () => {
        await assertClean(page, recorded)
        return 'clean'
      })
    }

    // ── stage 3: empty state without an error (fresh context) ────────────────
    {
      const copy = COPY.en
      const { page, recorded } = await openPage(copy)
      await check('fresh context boots with an empty or unselected panel', () => assertShellBoots(page, recorded, copy))
      await check('panel shows a coherent empty state, never an error', async () => {
        const dialog = await openPanel(page, copy)
        const text = (await dialog.innerText()).replace(/\s+/g, ' ')
        assert(!copy.transport.test(text), `empty-state panel reports a transport failure: ${text.slice(0, 160)}`)
        assert(!copy.malformed.test(text), `empty-state panel reports a malformed answer: ${text.slice(0, 160)}`)
        // Two coherent states exist here: nothing selected (the panel instructs
        // the user to open a conversation) or a session the runtime auto-selected
        // but which has no team yet (all role nodes idle).
        if (text.includes(copy.follow) || text.includes(copy.noSession)) {
          assert(text.includes(copy.follow), `no-session panel is missing its instruction: ${text.slice(0, 200)}`)
          return 'no-session guidance shown'
        }
        assert(text.includes(copy.idle) || text.includes(copy.loading),
          `expected no-session guidance or an idle team, got: ${text.slice(0, 200)}`)
        return 'a session is auto-selected; idle team shown instead'
      })
      await check('Escape closes the panel', async () => {
        // The shell's composer may hold focus after the panel mounts, so Escape
        // must close the panel regardless of where focus landed.
        await page.keyboard.press('Escape')
        await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 5_000 })
        return 'closed'
      })
      await check('empty-state stage is clean', async () => {
        await assertClean(page, recorded)
        return 'clean'
      })
    }

    // ── stage 4: error case (state route aborted) ────────────────────────────
    {
      const copy = COPY.en
      const { page, recorded } = await openPage(copy)
      await page.route(`**${API_PREFIX}/state**`, (route) => route.abort('failed'))
      await check('aborted state route boots the shell', () => assertShellBoots(page, recorded, copy))
      await check('panel surfaces the transport failure with a retry control', async () => {
        const dialog = await openPanel(page, copy)
        await page.waitForFunction(
          (pattern) => new RegExp(pattern).test(document.querySelector('[role="dialog"]')?.innerText ?? ''),
          copy.transport.source,
          { timeout: 10_000 },
        )
        const text = await dialog.innerText()
        assert(text.includes(copy.retry), 'the error line offers no retry control')
        assert(text.includes(copy.title), 'the panel did not survive the failure (title missing)')
        return 'transport copy + retry shown'
      })
      await check('error stage is clean', async () => {
        // This stage aborts the state route on purpose, so the browser's own
        // network-failure console report is expected here — and only here.
        await assertClean(page, recorded, { allowConsole: /net::ERR_|Failed to fetch|ERR_FAILED/ })
        return 'clean (aborted request tolerated)'
      })
    }

    // ── stage 5: fixtures (controls and containment) ─────────────────────────
    if (withFixtures) {
      const copy = COPY.en
      const actions = []
      if (sessionId === undefined) {
        // A fresh context has no selection, so the panel would never fetch and
        // the fixtures would stay unused. Fail with the fix rather than a
        // mysterious empty panel.
        results.push({
          name: '[fixture] coordinator seeded',
          ok: false,
          detail: 'the fixture stage needs a real coordinator to select: re-run with --session <coordinatorSessionId>',
        })
        console.log('  FAIL [fixture] coordinator seeded — pass --session <coordinatorSessionId> with --fixtures')
      } else {
        const seed = (id) => {
          globalThis.localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }))
        }
        const { page, recorded } = await openPage(copy, seed)
        await page.route(`**${API_PREFIX}/state**`, (route) => {
          const requested = new URL(route.request().url()).searchParams.get('sessionId') ?? ''
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(fixtureState(requested)),
          })
        })
        await page.route(`**${API_PREFIX}/action`, (route) => {
          actions.push(JSON.parse(route.request().postData() ?? '{}'))
          return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
        })

        await check('[fixture] shell boots', () => assertShellBoots(page, recorded, copy))

        await check('[fixture] orbit renders one node per role with the live summary', async () => {
          const dialog = await openPanel(page, copy)
          await dialog.locator('.dshteam-orbit-node').first().waitFor({ state: 'visible', timeout: 10_000 })
          const nodes = dialog.locator('.dshteam-orbit-node')
          assert(await nodes.count() === 3, `expected 3 role nodes, saw ${String(await nodes.count())}`)
          const text = (await dialog.innerText()).replace(/\s+/g, ' ')
          assert(text.includes(copy.settled), `the live summary does not report settled work: ${text.slice(0, 160)}`)
          const working = dialog.locator('.dshteam-orbit-node[data-state="working"]')
          const done = dialog.locator('.dshteam-orbit-node[data-state="done"]')
          const queued = dialog.locator('.dshteam-orbit-node[data-state="queued"]')
          assert(await working.count() === 1, 'one working node expected')
          assert(await done.count() === 1, 'one done node expected')
          assert(await queued.count() === 1, 'one queued node expected')
          return '3 nodes: 1 working, 1 done, 1 queued'
        })

        await check('[fixture] clicking a role node posts no command and stays contained', async () => {
          const dialog = page.getByRole('dialog')
          const before = actions.length
          await dialog.locator('.dshteam-orbit-node[data-state="working"]').first().click()
          await sleep(1_200)
          assert(recorded.pageErrors.length === 0, `the node click threw: ${recorded.pageErrors.join(' | ')}`)
          assert(actions.length === before, `a role-node click posted ${String(actions.length - before)} action(s)`)
          const text = await dialog.innerText()
          return /refused|unknown|Cannot|not a healthy|无法/.test(text)
            ? 'navigation refused and reported'
            : 'no error line (the fabricated worker id was resolvable?)'
        })

        await check('[fixture] resume posts exactly one action', async () => {
          const dialog = page.getByRole('dialog')
          const resume = dialog.getByRole('button', { name: copy.resume, exact: true })
          await resume.waitFor({ state: 'visible', timeout: 10_000 })
          await resume.click()
          const resumed = await waitForAction(actions, 'resume')
          assert(resumed !== undefined, `no resume action was posted (saw ${JSON.stringify(actions.map(action => action.action))})`)
          await until(async () => actions.filter(action => action.action === 'resume').length === 1, 'exactly one resume action')
          return 'resume posted once'
        })
        await check('[fixture] fixture stage is clean', async () => {
          await assertClean(page, recorded, { allowMutations: true })
          return 'clean'
        })
      }
    }
  }
} catch (error) {
  results.push({ name: 'harness', ok: false, detail: error instanceof Error ? error.message : String(error) })
  console.error(`\nharness failure: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  if (browser !== undefined) await browser.close().catch(() => {})
}

if (!noShot) console.log(`\nscreenshot: ${shotPath}`)
const failed = results.filter(result => !result.ok)
console.log(`\n${String(results.length - failed.length)} passed, ${String(failed.length)} failed`)
for (const failure of failed) console.log(`  - ${failure.name}: ${String(failure.detail)}`)
process.exit(failed.length === 0 ? 0 : 1)
