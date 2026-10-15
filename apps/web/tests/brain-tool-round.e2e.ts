// Web e2e scenario: the synthesized knowledge-vault round, seeded cold through
// the persistence seam, renders both brain tools through their generic tool
// rows without a model call. The disclosure proves replay-stable naming and
// the exact durable search/read outputs.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../examples/acp-agent/tests/snapshots/brain-tool-round/session.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/brain-tool-round', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/brain-tool-round/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'brain-tool-round-web-e2e'
const PROMPT = 'Search my knowledge vault for deployment notes and read the top match. Then reply with the single word DONE and stop.'

describe.skipIf(MODE === 'record')('web e2e: knowledge-vault tool rows', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    const fixture = await readFile(FIXTURE, 'utf8')
    expect(fixtureUserPrompts(fixture)).toEqual([PROMPT])
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, fixture, SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await page.locator('[data-tool="brain_search"]').waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('renders the search and read rounds with their recorded results', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-brain-tool-round'))
    const search = page.locator('[data-tool="brain_search"]')
    const read = page.locator('[data-tool="brain_read"]')
    await read.waitFor({ timeout: 15_000 })
    await search.getByText('Search knowledge vault').waitFor({ state: 'visible', timeout: 10_000 })
    await read.getByText('Read note').waitFor({ state: 'visible', timeout: 10_000 })

    // Expand both disclosures so the golden pins the canonical results, not
    // just the collapsed summaries.
    for (const row of [search, read]) {
      const toggle = row.getByRole('button', { expanded: false }).first()
      if (await toggle.count() > 0) await toggle.click()
    }
    const searchOutput = async (): Promise<string> => (await search.locator('pre').allTextContents()).join('\n')
    const readOutput = async (): Promise<string> => (await read.locator('pre').allTextContents()).join('\n')
    await expect.poll(searchOutput, { timeout: 10_000 }).toContain('2 matching note(s)')
    await expect.poll(searchOutput, { timeout: 10_000 }).toContain('- Ops/deploy.md — deploy:')
    await expect.poll(readOutput, { timeout: 10_000 }).toContain('The web profile binds 127.0.0.1:3080')

    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .replace(/\b\d{1,2}\/\d{1,2}(?= \{\{clock\}\})/g, '{{date}}')
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
