import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamEngine } from './engine.mjs'

function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-teams-'))
  const starts = [], sends = [], stops = []
  let n = 0
  const adapter = {
    available: () => true,
    start: async args => { starts.push(args); return `worker-${++n}` },
    followup: async args => { sends.push(args) },
    interrupt: async args => { stops.push(args) },
    ...overrides,
  }
  const file = join(dir, 'state.json')
  const engine = new TeamEngine({ file, maxActive: 3, maxLimit: 5, adapter })
  t.after(async () => { await engine.dispose(); rmSync(dir, { recursive: true, force: true }) })
  return { engine, starts, sends, stops, file, adapter }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
async function assign(engine, args = {}, session = 'parent') {
  await engine.action(session, 'assign', { specialistId: 'builder', title: 'Build', prompt: 'Implement it', files: ['src/a'], ...args })
  await tick()
  return engine.state(session).team.tasks.at(-1)
}

test('disjoint writers run together; overlapping paths wait until a real settlement', async t => {
  const { engine, starts } = fixture(t)
  const a = await assign(engine)
  const b = await assign(engine, { files: ['src/b'] })
  const c = await assign(engine, { files: ['SRC/A/child'] })
  assert.equal(starts.length, 2)
  assert.equal(c.status, 'queued')
  engine.settle(a.workerId, { stopReason: 'completed', result: 'changed src/a' })
  await tick()
  assert.equal(starts.length, 3)
  assert.equal(engine.state('parent').team.tasks[0].result, 'changed src/a')
  assert.equal(b.status, 'working')
})

test('dependency failure blocks dependent work and explicit retries reuse the worker', async t => {
  const { engine, starts, sends } = fixture(t)
  const a = await assign(engine)
  await assign(engine, { files: ['src/b'], dependsOn: [a.id] })
  engine.settle(a.workerId, { stopReason: 'error', result: 'partial' })
  await tick()
  assert.equal(engine.state('parent').team.tasks[1].status, 'blocked')
  await engine.action('parent', 'retry', { taskId: a.id })
  await tick()
  assert.equal(starts.length, 1)
  assert.equal(sends[0].workerId, a.workerId)
})

test('dependent workers receive completed reports in their logged assignment prompt', async t => {
  const { engine, starts } = fixture(t)
  const research = await assign(engine, { specialistId: 'researcher', files: ['src/a'] })
  await assign(engine, { dependsOn: [research.id], files: ['src/a'] })
  engine.settle(research.workerId, { stopReason: 'completed', result: 'Use the existing extension API.' })
  await tick()
  assert.equal(starts.length, 2)
  assert.match(starts[1].task.prompt, /Dependency reports:/)
  assert.match(starts[1].task.prompt, /Use the existing extension API\./)
  assert.equal(engine.state('parent').team.tasks[1].prompt, 'Implement it')
})

test('saved specialist edits do not alter an already assigned persona', async t => {
  const { engine } = fixture(t)
  const a = await assign(engine)
  await engine.action('parent', 'save_specialist', { specialist: { id: 'builder', name: 'New builder', mode: 'read', instructions: 'Inspect only' } })
  assert.equal(engine.state('parent').team.tasks[0].specialist.mode, 'write')
  assert.equal(engine.state('parent').specialists.find(s => s.id === 'builder').mode, 'read')
  assert.equal(a.specialist.name, 'Builder')
})

test('restart preserves saved specialists and pauses interrupted and queued work', async t => {
  const { engine, file, adapter, starts } = fixture(t)
  await assign(engine)
  await assign(engine, { files: ['src/a'] })
  const restarted = new TeamEngine({ file, maxActive: 3, maxLimit: 5, adapter })
  t.after(() => restarted.dispose())
  assert.equal(restarted.state('parent').team.paused, true)
  assert.deepEqual(restarted.state('parent').team.tasks.map(t => t.status), ['blocked', 'queued'])
  restarted.live('parent'); await tick()
  assert.equal(starts.length, 1)
  assert.equal(JSON.parse(readFileSync(file)).version, 1)
})

test('rejects invalid persistence and input without starting workers', async t => {
  const { engine, starts, file, adapter } = fixture(t)
  for (const files of [['../escape'], ['C:\\abs'], ['src/*'], ['/root']]) {
    await assert.rejects(assign(engine, { files }), /workspace-relative/)
  }
  await assert.rejects(assign(engine, { files: [] }), /require/)
  await assert.rejects(engine.action('parent', 'configure', { maxActive: 6 }), /maxActive/)
  await assert.rejects(assign(engine, { dependsOn: ['absent'] }), /existing tasks/)
  await assert.rejects(engine.action('parent', 'save_specialist', { specialist: { id: '../x' } }), /Specialist id/)
  assert.equal(starts.length, 0)
  assert.equal(engine.state('parent').team, null, 'rejected commands do not publish an empty team')
  assert.deepEqual(JSON.parse(readFileSync(file)).teams, {})
  writeFileSync(file, '{"version":999}')
  assert.throws(() => new TeamEngine({ file, maxActive: 3, maxLimit: 5, adapter }), /Unsupported/)
})

test('durable parser rejects cyclic dependencies and duplicate worker ownership', async t => {
  const { engine, file, adapter } = fixture(t)
  await assign(engine)
  await assign(engine, { files: ['src/b'] })
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const [a, b] = data.teams.parent.tasks
  a.dependsOn = [b.id]; b.dependsOn = [a.id]
  writeFileSync(file, JSON.stringify(data))
  assert.throws(() => new TeamEngine({ file, maxActive: 3, maxLimit: 5, adapter }), /Cyclic dependencies/)
  a.dependsOn = []; b.dependsOn = []; b.workerId = a.workerId
  writeFileSync(file, JSON.stringify(data))
  assert.throws(() => new TeamEngine({ file, maxActive: 3, maxLimit: 5, adapter }), /Duplicate worker/)
  b.workerId = 'other-worker'
  data.teams.other = { ...structuredClone(data.teams.parent), sessionId: 'other',
    tasks: [{ ...structuredClone(a), workerId: 'third-worker' }] }
  writeFileSync(file, JSON.stringify(data))
  assert.throws(() => new TeamEngine({ file, maxActive: 3, maxLimit: 5, adapter }), /Duplicate task id/)
})

test('cancellation retains reservations until the worker ends', async t => {
  const { engine, starts, stops } = fixture(t)
  const a = await assign(engine)
  await assign(engine)
  await engine.action('parent', 'cancel', { taskId: a.id })
  assert.equal(stops[0].workerId, a.workerId)
  assert.equal(starts.length, 1)
  assert.equal(engine.state('parent').team.tasks[0].status, 'canceling')
  engine.settle(a.workerId, { stopReason: 'aborted', result: '' })
  await tick()
  assert.equal(starts.length, 2)
  assert.equal(engine.state('parent').team.tasks[0].status, 'canceled')
})

test('direct messages cannot bypass active limits or reserved files', async t => {
  const { engine, sends } = fixture(t)
  const a = await assign(engine)
  await assert.rejects(engine.action('parent', 'message', { taskId: a.id, message: 'hello' }), /busy/)
  engine.settle(a.workerId, { stopReason: 'completed', result: 'done' })
  await tick()
  await engine.action('parent', 'message', { taskId: a.id, message: 'Check again' })
  await tick()
  assert.equal(sends[0].message, 'Check again')
  assert.equal(engine.state('parent').team.tasks[0].status, 'working')
})

test('very short starts and follow-ups retain terminal state', async t => {
  let engine
  const f = fixture(t, {
    start: async () => {
      for (let n = 0; n < 20; n++) engine.settle(`unrelated-${n}`, { stopReason: 'completed', result: '' })
      engine.settle('quick', { stopReason: 'completed', result: 'quick answer' })
      return 'quick'
    },
    followup: async () => { engine.settle('quick', { stopReason: 'completed', result: 'follow-up answer' }) },
  })
  engine = f.engine
  const a = await assign(engine)
  assert.equal(a.status, 'done')
  await engine.action('parent', 'message', { taskId: a.id, message: 'Again' })
  await tick()
  assert.equal(engine.state('parent').team.tasks[0].status, 'done')
  assert.equal(engine.state('parent').team.tasks[0].result, 'follow-up answer')
})

test('startup failure releases reservations without automatically replaying the assignment', async t => {
  let calls = 0
  const { engine } = fixture(t, { start: async () => {
    calls++
    if (calls === 1) throw new Error('provider setup failed')
    return 'next-worker'
  } })
  const failed = await assign(engine)
  const next = await assign(engine)
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /provider setup failed/)
  assert.equal(next.status, 'working')
  assert.equal(calls, 2)
})

test('global ceiling applies across coordinator conversations', async t => {
  const { engine, starts } = fixture(t)
  for (let n = 0; n < 8; n++) await assign(engine, { files: [`src/${n}`] }, `parent-${n}`)
  assert.equal(starts.length, 5)
})

test('teardown attempts every worker and reports interruption failures after saving recovery state', async t => {
  const interrupted = []
  const { engine } = fixture(t, { interrupt: async ({ workerId }) => {
    interrupted.push(workerId)
    if (workerId === 'worker-1') throw new Error('first worker failed to stop')
  } })
  await assign(engine)
  await assign(engine, { files: ['src/b'] })
  await assert.rejects(engine.dispose(), /Could not stop every team worker/)
  assert.deepEqual(interrupted, ['worker-1', 'worker-2'])
  assert.equal(engine.state('parent').team.paused, true)
  assert.deepEqual(engine.state('parent').team.tasks.map(t => t.status), ['blocked', 'blocked'])
})

test('queued cancellation never creates a worker and state queries are detached', async t => {
  const { engine, starts } = fixture(t, { available: () => false })
  const task = await assign(engine)
  await engine.action('parent', 'cancel', { taskId: task.id })
  const copy = engine.state('parent')
  copy.team.tasks[0].status = 'working'
  assert.equal(engine.state('parent').team.tasks[0].status, 'canceled')
  assert.equal(starts.length, 0)
  await engine.dispose()
  await assert.rejects(engine.action('parent', 'resume'), /stopping/)
})

test('unavailable coordinator leaves work queued and disposal aborts pending starts', async t => {
  const { engine, adapter } = fixture(t, { available: () => false })
  const a = await assign(engine)
  assert.equal(a.status, 'queued')
  adapter.available = () => true
  adapter.start = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
  engine.live('parent')
  await engine.dispose()
  assert.equal(engine.state('parent').team.paused, true)
  assert.equal(engine.state('parent').team.tasks[0].status, 'canceled')
})
