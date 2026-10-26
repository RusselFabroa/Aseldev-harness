/**
 * Assembled-app test for the teams addon: a real delegation through a real
 * headless composition, plus a normalized transcript snapshot of what the run
 * durably recorded.
 *
 * Keyless and deterministic. Only the LLM boundary is scripted (the fixture
 * adapter plays the coordinator and the worker); the tool pipeline, the teams
 * engine, the scheduler, the subagent service, and session persistence are the
 * real ones. The composition and its driver live under
 * `examples/headless-agent/tests/fixtures/aseldev-teams/teams/`, and the loader
 * launches that fixture itself, so this file needs no source transform.
 *
 * Requires a prior build of both halves (`node build.mjs`) and of the harness's
 * own loader-smoke helper.
 *
 * Refresh the snapshot: `DSH_TEAMS_SNAPSHOT=refresh node --test composition.test.mjs`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The harness checkout root: aseldev/plugins/teams -> aseldev -> repo. */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const fixtureDir = join(repoRoot, 'examples', 'headless-agent', 'tests', 'fixtures', 'aseldev-teams', 'teams')
const expectedPath = fileURLToPath(new URL('./composition.expected.json', import.meta.url))
const refreshing = process.env.DSH_TEAMS_SNAPSHOT === 'refresh'

const { runLoaderSmoke } = await import(
  pathToFileURL(join(repoRoot, 'packages', 'test-support', 'loader-smoke', 'lib', 'index.js')).href
)

/** Minted assignment identities a later run cannot reproduce. */
const MINTED_TASK = /task-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

/**
 * Project one run onto roles and rewrite the minted identities.
 *
 * Sessions are ranked rather than left in directory order, and each keeps only
 * the text this snapshot is about: the coordination context it logged, the
 * assignment the worker was handed, its answers, and the tool round trip.
 * @param report - the driver's JSON report.
 * @returns the normalized snapshot text, ready to compare or write.
 */
function snapshot(report) {
  const rank = { coordinator: 0, worker: 1, other: 2 }
  const roleOf = session => (session.id === report.coordinator
    ? 'coordinator'
    : session.parentSession === report.coordinator ? 'worker' : 'other')
  const projection = report.sessions
    .map(session => ({
      role: roleOf(session),
      parentRole: session.parentSession === undefined ? null : 'coordinator',
      eventTypes: session.eventTypes,
      coordination: session.coordination,
      assignment: session.assignment,
      userText: session.userText,
      assistantText: session.assistantText,
      toolNames: session.toolNames,
      toolResults: session.toolResults,
    }))
    .sort((left, right) => rank[left.role] - rank[right.role])
  return JSON.stringify(projection, null, 2).replace(MINTED_TASK, '<task>') + '\n'
}

test('a coordinator assigns a worker, settles it, follows up, and records a stable transcript', { timeout: 120_000 }, async () => {
  const { stdout, stderr } = await runLoaderSmoke({
    label: 'aseldev teams delegation',
    tempDirPrefix: 'dsh-aseldev-teams-',
    binScript: join(fixtureDir, 'driver.ts'),
    libBinScript: join(fixtureDir, 'driver.ts'),
    configPath: join(fixtureDir, 'cordis.yml'),
    // The composition sits outside a workspace package, so its bare rows resolve
    // only through the tsconfig paths map that `src` mode installs.
    mode: 'src',
    tsconfigPath: join(repoRoot, 'tsconfig.json'),
  })

  assert.equal(stderr, '')
  const report = JSON.parse(stdout)

  // Behaviour: the assignment ran, settled, and answered from the prompt the
  // worker was actually handed.
  assert.equal(report.firstStatus, 'done')
  assert.match(report.firstResult, /WORKER_FIRST: Assignment: Reader pass/)
  assert.match(report.firstResult, /Answer with WORKER_SEES\./)

  // A follow-up to the same conversation produced a second distinct outcome.
  assert.equal(report.secondStatus, 'done')
  assert.equal(report.secondResult, 'WORKER_AGAIN: second pass')

  // Two durable sessions: the coordinator and one worker child of it.
  assert.equal(report.sessions.length, 2)
  const coordinator = report.sessions.find(session => session.id === report.coordinator)
  const worker = report.sessions.find(session => session.parentSession === report.coordinator)
  assert.ok(coordinator !== undefined, 'the coordinator session is recorded')
  assert.ok(worker !== undefined, 'the worker session records its parent')

  // The coordinator's log carries the real tool round trip; the worker's carries
  // its assignment, both answers, and its durable subagent identity.
  for (const type of ['user/message', 'tool/call', 'tool/result', 'assistant/message']) {
    assert.ok(coordinator.eventTypes.includes(type), 'coordinator log has ' + type)
  }
  for (const type of ['user/message', 'assistant/message', 'subagent/descriptor']) {
    assert.ok(worker.eventTypes.includes(type), 'worker log has ' + type)
  }

  // The specialist's instructions, including literal template syntax, reach the
  // LOGGED assignment rather than a persona template.
  assert.match(worker.assignment, /^Assignment: Reader pass/)
  assert.match(worker.assignment, /Literal \{\{placeholder\}\} must survive\./)
  assert.match(worker.assignment, /Reserved paths: note\.txt/)
  assert.equal(worker.assistantText.at(-1), 'WORKER_AGAIN: second pass')
  assert.ok(worker.userText.includes('Run the same assignment again.'))
  assert.ok(coordinator.userText.includes('Set up a reader teammate and give it the assignment.'))

  // The coordination instruction reached both sides' logged context.
  assert.match(coordinator.coordination ?? '', /Auto-continue budget/)
  assert.match(coordinator.coordination ?? '', /Project Manager/)
  assert.match(worker.coordination ?? '', /team worker|team worker|executes its assignment|execute your assignment/i)

  // The two model-level team_manage results: the saved roster, then the accepted
  // assignment. Completion itself is the durable status asserted above.
  assert.match(coordinator.toolResults[0] ?? '', /^Specialists: /)
  assert.match(coordinator.toolResults[0] ?? '', /worker \(write\) Worker/)
  assert.match(coordinator.toolResults[0] ?? '', /No team yet in this conversation/)
  assert.match(coordinator.toolResults.at(-1) ?? '', /\[starting\] .*Reader pass.*paths note\.txt/)

  // The panel route, registered against the injected web server, captured before
  // teardown.
  assert.deepEqual(report.routes, ['prefix:/aseldev-teams'])

  // HMR/unload evidence, read through references retained from before teardown:
  // the retained tools registry no longer resolves the tool, and the route
  // disposer ran. Asking a fresh context would prove only that the context went
  // away, not that every root contribution was released.
  assert.equal(report.disposal.teamToolRemoved, true, 'the retained registry no longer resolves team_manage')
  assert.equal(report.disposal.routesRemoved, true, 'the route disposer ran on teardown')

  // Snapshot: static user/tool/assistant text with only minted ids rewritten.
  const normalized = snapshot(report)
  if (refreshing) {
    writeFileSync(expectedPath, normalized)
    return
  }
  assert.equal(normalized, readFileSync(expectedPath, 'utf8'))
})
