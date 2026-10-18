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
    retry: 'Retry',
    cancel: 'Cancel',
    message: 'Message',
    messageClose: 'Hide message box',
    messageSend: 'Send',
    configureSave: 'Save',
    openConversation: 'Open conversation',
    transport: /Cannot reach the teams endpoint/,
    malformed: /Malformed team state/,
    emptyTeam: 'No assignments yet',
    guardHint: /team guard/,
    statusRunning: 'Running',
    statusDone: 'Done',
  },
  zh: {
    locale: 'zh-CN',
    button: '团队任务面板',
    title: '团队',
    noSession: '未选择会话',
    follow: '先在左侧打开一个会话',
    retry: '重试',
    cancel: '取消',
    message: '发消息',
    messageClose: '收起消息',
    messageSend: '发送',
    openConversation: '打开会话',
    transport: /无法连接团队接口/,
    malformed: /团队状态格式不正确/,
    emptyTeam: '该会话还没有任务',
    guardHint: /团队守卫拒绝/,
    statusRunning: '进行中',
    statusDone: '已完成',
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
  { id: 'builder', name: 'Builder', instructions: 'implement', mode: 'write' },
  { id: 'reviewer', name: 'Reviewer', instructions: 'review', mode: 'read' },
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
      paused: false,
      tasks: [
        {
          id: 'task-a', specialistId: 'builder', title: 'Fix login timing', prompt: 'p', status: 'working',
          workerId: 'fixture-worker-running', files: ['src/auth'], dependsOn: [],
        },
        {
          id: 'task-b', specialistId: 'reviewer', title: 'Review the change', prompt: 'p', status: 'done',
          workerId: 'fixture-worker-done', files: [], dependsOn: ['task-a'], result: 'looks fine',
        },
        {
          id: 'task-c', specialistId: 'reviewer', title: 'Write the summary', prompt: 'p', status: 'queued',
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
          assert(guidance || text.includes(copy.emptyTeam), `expected no-session guidance or an empty team, got: ${text.slice(0, 160)}`)
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
        // Two coherent states exist here: nothing selected (the panel instructs the
        // user to open a conversation) or a session the runtime auto-selected but
        // which has no team yet (the panel offers to assign the first worker).
        if (text.includes(copy.noSession)) {
          assert(text.includes(copy.follow), `no-session panel is missing its instruction: ${text.slice(0, 200)}`)
          return 'no-session guidance shown'
        }
        assert(text.includes(copy.emptyTeam), `expected no-session guidance or an empty team, got: ${text.slice(0, 200)}`)
        return 'a session is auto-selected; empty team shown instead'
      })
      await check('Escape closes the panel while focus is inside it', async () => {
        // The panel focuses itself when it opens; Escape reaches its keydown
        // handler only from inside, so report where focus actually went instead
        // of failing with a bare timeout.
        const focus = await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"]')
          const active = document.activeElement
          if (dialog === null) return 'no dialog'
          if (dialog.contains(active)) return 'inside'
          return `outside (${active?.tagName ?? 'none'} ${active?.getAttribute?.('aria-label') ?? ''})`.trim()
        })
        assert(focus === 'inside', `the panel did not take focus on open: ${focus}`)
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

        /** Titles the fixture team's three tasks render with. */
        const RUNNING = 'Fix login timing'
        const SETTLED = 'Review the change'
        const QUEUED = 'Write the summary'

        await check('[fixture] rows render with per-status controls', async () => {
          const dialog = await openPanel(page, copy)
          await rowOf(dialog, RUNNING).waitFor({ state: 'visible', timeout: 10_000 })
          const text = (await dialog.innerText()).replace(/\s+/g, ' ')
          assert(text.includes(copy.statusRunning), 'the running task has no running label')
          assert(text.includes(copy.statusDone), 'the settled task has no done label')
          // Scoped per row: an active row and a queued row both offer Cancel, so a
          // panel-wide count is inherently ambiguous.
          const running = rowOf(dialog, RUNNING)
          const settled = rowOf(dialog, SETTLED)
          const queued = rowOf(dialog, QUEUED)
          assert(!(await running.getByRole('button', exactName(copy.cancel)).isDisabled()), 'the running task must be cancellable')
          assert(!(await queued.getByRole('button', exactName(copy.cancel)).isDisabled()), 'the queued task must be cancellable')
          assert(!(await settled.getByRole('button', exactName(copy.retry)).isDisabled()), 'the settled task must be retryable')
          assert(await running.getByRole('button', exactName(copy.retry)).count() === 0, 'the running task must not offer retry')
          assert(await settled.getByRole('button', exactName(copy.cancel)).count() === 0, 'the settled task must not offer cancel')
          // Message toggle: refused while the row is busy or has no worker yet.
          assert(await running.getByRole('button', exactName(copy.message)).isDisabled(), 'the busy row must not accept a message')
          assert(!(await settled.getByRole('button', exactName(copy.message)).isDisabled()), 'the settled row must accept a message')
          assert(await queued.getByRole('button', exactName(copy.message)).isDisabled(), 'a workerless row must not accept a message')
          // Open conversation: rendered on every row but usable only once the row
          // has a worker (production renders it disabled rather than hiding it).
          assert(!(await running.getByRole('button', exactName(copy.openConversation)).isDisabled()), 'the running row must open its conversation')
          assert(await queued.getByRole('button', exactName(copy.openConversation)).isDisabled(), 'a workerless row must not open a conversation')
          return '3 rows, controls scoped per row'
        })

        await check('[fixture] message form opens with the guard copy', async () => {
          const dialog = page.getByRole('dialog')
          const settled = rowOf(dialog, SETTLED)
          await settled.getByRole('button', exactName(copy.message)).click()
          const box = settled.locator('textarea')
          await box.waitFor({ state: 'visible', timeout: 5_000 })
          const text = await settled.innerText()
          assert(copy.guardHint.test(text), 'the message form does not explain the team guard')
          assert(text.includes(copy.messageSend), 'the message form has no send control')
          // Leave it closed again so later rows keep their default shape.
          await settled.getByRole('button', exactName(copy.messageClose)).click()
          return 'guard copy shown'
        })

        await check('[fixture] retry posts exactly one action and settles the busy state', async () => {
          const dialog = page.getByRole('dialog')
          const settled = rowOf(dialog, SETTLED)
          await settled.getByRole('button', exactName(copy.retry)).click()
          const retry = await waitForAction(actions, 'retry')
          assert(retry !== undefined, `no retry action was posted (saw ${JSON.stringify(actions.map(a => a.action))})`)
          assert(retry.taskId === 'task-b', `retry targeted ${String(retry.taskId)}, expected task-b`)
          // The panel is busy until the action resolves; every control is disabled
          // meanwhile, so the next click must wait for that to settle.
          await until(async () => settled.getByRole('button', exactName(copy.retry)).isEnabled(), 'the retry control to re-enable')
          assert(actions.filter(action => action.action === 'retry').length === 1, 'retry was posted more than once')
          return `taskId ${retry.taskId}`
        })

        await check('[fixture] cancel posts exactly one action from the running row', async () => {
          const dialog = page.getByRole('dialog')
          const running = rowOf(dialog, RUNNING)
          assert(!(await running.getByRole('button', exactName(copy.cancel)).isDisabled()), 'the busy-state wait did not release the panel')
          await running.getByRole('button', exactName(copy.cancel)).click()
          const cancel = await waitForAction(actions, 'cancel')
          assert(cancel !== undefined, `no cancel action was posted (saw ${JSON.stringify(actions.map(a => a.action))})`)
          assert(cancel.taskId === 'task-a', `cancel targeted ${String(cancel.taskId)}, expected task-a`)
          await until(async () => running.getByRole('button', exactName(copy.cancel)).isEnabled(), 'the cancel control to re-enable')
          return `taskId ${cancel.taskId}`
        })

        await check('[fixture] open-conversation stays contained (fake worker id)', async () => {
          const dialog = page.getByRole('dialog')
          const running = rowOf(dialog, RUNNING)
          const openers = running.getByRole('button', exactName(copy.openConversation))
          assert(await openers.count() === 1, `expected one open control in the running row, saw ${String(await openers.count())}`)
          await openers.click()
          // A fabricated worker id cannot be opened by the real runtime: the click
          // must surface an error line, never an uncaught exception. Give the
          // catalog refresh + refusal a moment to land.
          await sleep(1_200)
          const text = await dialog.innerText()
          assert(recorded.pageErrors.length === 0, `the open click threw: ${recorded.pageErrors.join(' | ')}`)
          return /not a healthy catalog child|unknown session|无法|Cannot/.test(text)
            ? 'navigation refused and reported'
            : 'no error line (worker id was resolvable?)'
        })

        await check('[fixture] switching coordinator drops the previous team and posts nothing', async () => {
          const dialog = page.getByRole('dialog')
          // Any command still in flight belongs to the previous coordinator.
          await until(async () => !(await rowOf(dialog, SETTLED).getByRole('button', exactName(copy.retry)).isDisabled()), 'the panel to be idle')
          const before = actions.length
          const picker = dialog.locator('select').first()
          await picker.selectOption(SECOND_COORDINATOR)
          // The second coordinator's mocked answer is an empty team, so its tasks
          // must never appear; the previous team's rows and actions must vanish.
          await page.waitForFunction((title) => !(document.querySelector('[role="dialog"]')?.innerText ?? '').includes(title), RUNNING, { timeout: 10_000 })
          const text = await dialog.innerText()
          assert(!text.includes(RUNNING), "the previous coordinator's task is still rendered")
          assert(!text.includes(SETTLED), "the previous coordinator's review task is still rendered")
          assert(!text.includes(QUEUED), "the previous coordinator's queued task is still rendered")
          // Stale controls are what a leaked team would expose; the rows are gone,
          // so no cancel/retry may remain anywhere in the panel.
          assert(await dialog.getByRole('button', exactName(copy.cancel)).count() === 0, 'a stale cancel control survived the switch')
          assert(await dialog.getByRole('button', exactName(copy.retry)).count() === 0, 'a stale retry control survived the switch')
          // Switching is navigation, not a command: no POST may have been added.
          assert(actions.length === before, `the switch posted ${String(actions.length - before)} action(s)`)
          // The new coordinator has no team yet, which is exactly the state that
          // must not advertise a guessed default: the deployment limit is host
          // configuration, so the field says "Host default" and Save is disabled.
          assert(await dialog.getByPlaceholder('Host default').count() === 1, 'a team-less panel must show the "Host default" placeholder')
          assert(await dialog.getByPlaceholder('1').count() === 0, 'the panel must not claim a default limit of 1')
          assert(await dialog.getByRole('button', exactName(copy.configureSave)).isDisabled(), 'Save must stay disabled until a limit is typed')
          return /Switching coordinator|No assignments yet/.test(text) ? 'switching state shown' : 'empty team rendered'
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
