/** Durable team assignments and bounded, advisory file-reservation scheduling. */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const ACTIVE = new Set(['starting', 'working', 'canceling'])
const TERMINAL = new Set(['done', 'failed', 'canceled', 'blocked'])
const STATUSES = new Set(['queued', ...ACTIVE, ...TERMINAL])
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/
const DEFAULT_SPECIALISTS = [
  { id: 'researcher', name: 'Researcher', mode: 'read', instructions: 'Investigate the assignment and cite exact files and evidence. Do not modify files. Return findings and recommendations.' },
  { id: 'builder', name: 'Builder', mode: 'write', instructions: 'Implement only the assigned scope. Respect other workers and existing changes. Report changed files, checks actually run, and remaining risks.' },
  { id: 'reviewer', name: 'Reviewer', mode: 'read', instructions: 'Review independently for defects, regressions, and missing coverage. Do not modify files. Report actionable findings with file locations.' },
]

function text(value, name, max = 32000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be nonempty text, at most ${max} characters`)
  return value.trim()
}
function list(value, name) {
  if (!Array.isArray(value) || value.length > 200 || value.some(v => typeof v !== 'string')) throw new Error(`${name} must be an array of at most 200 strings`)
  return [...new Set(value)]
}
function fileScope(value) {
  const scope = text(value, 'file reservation', 1000).replaceAll('\\', '/').replace(/\/+$/, '')
  if (scope === '.') return scope
  if (scope.startsWith('/') || scope.includes(':') || scope.split('/').some(v => !v || v === '..' || v === '.') || /[*?\[\]]/.test(scope)) {
    throw new Error('File reservations must be workspace-relative files or directories, without globs or parent traversal; use . for the whole workspace')
  }
  return scope
}
function overlaps(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase()
  return a === '.' || b === '.' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}
function specialist(value) {
  if (!value || typeof value !== 'object' || !ID.test(value.id)) throw new Error('Specialist id must contain lowercase letters, digits, or hyphens')
  if (value.mode !== 'read' && value.mode !== 'write') throw new Error('Specialist mode must be read or write')
  return { id: value.id, name: text(value.name, 'specialist name', 120), mode: value.mode, instructions: text(value.instructions, 'instructions') }
}
function limit(value, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`maxActive must be an integer from 1 to ${max}`)
  return value
}

/**
 * Persists owned JSON only. The adapter owns real agents and their authority checks.
 * An assignment covers a complete worker activation, including any directly queued messages.
 */
export class TeamEngine {
  constructor({ file, maxActive, maxLimit, adapter }) {
    this.file = file
    this.maxLimit = limit(maxLimit, 1000)
    this.defaultMax = limit(maxActive, this.maxLimit)
    this.adapter = adapter
    this.closed = false
    this.operations = new Map()
    this.pumping = new Set()
    this.earlyEnds = new Map()
    /** Per-coordinator command chains: concurrent callers must not interleave status transitions. */
    this.actions = new Map()
    this.data = { version: 1, specialists: DEFAULT_SPECIALISTS.map(s => ({ ...s })), teams: {} }
    try { this.data = JSON.parse(readFileSync(file, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    this.validate()
    for (const team of Object.values(this.data.teams)) {
      team.paused = true
      for (const task of team.tasks) {
        if (ACTIVE.has(task.status)) {
          task.status = 'blocked'
          task.error = 'Execution was interrupted by a process or plugin restart. Inspect shared files and explicitly retry; work is not replayed automatically.'
        }
      }
    }
    this.save()
  }

  validate() {
    const data = this.data
    if (data?.version !== 1 || !Array.isArray(data.specialists) || !data.teams || typeof data.teams !== 'object' || Array.isArray(data.teams)) throw new Error('Unsupported or invalid teams store; expected version 1')
    data.specialists = data.specialists.map(specialist)
    if (new Set(data.specialists.map(s => s.id)).size !== data.specialists.length) throw new Error('Duplicate specialist ids in teams store')
    const workers = new Set()
    const taskIds = new Set()
    for (const [id, team] of Object.entries(data.teams)) {
      if (team.sessionId !== id || !Array.isArray(team.tasks) || typeof team.paused !== 'boolean') throw new Error(`Invalid team ${id}`)
      limit(team.maxActive, this.maxLimit)
      const ids = new Set()
      for (const task of team.tasks) {
        text(task.id, 'task id', 100); text(task.title, 'task title', 200); text(task.prompt, 'task prompt')
        if (ids.has(task.id) || !STATUSES.has(task.status)) throw new Error(`Invalid task ${task.id}`)
        if (taskIds.has(task.id)) throw new Error(`Duplicate task id across teams: ${task.id}`)
        ids.add(task.id); taskIds.add(task.id)
        task.specialist = specialist(task.specialist)
        if (task.specialist.id !== task.specialistId) throw new Error(`Invalid specialist for task ${task.id}`)
        task.files = list(task.files, 'files').map(fileScope)
        task.dependsOn = list(task.dependsOn, 'dependsOn')
        if (task.workerId !== undefined) {
          text(task.workerId, 'worker id', 200)
          if (workers.has(task.workerId)) throw new Error(`Duplicate worker ${task.workerId}`)
          workers.add(task.workerId)
        }
        if (task.nextMessage !== undefined) text(task.nextMessage, 'pending message')
        if (task.result !== undefined && typeof task.result !== 'string') throw new Error('Invalid task result')
        if (task.error !== undefined && typeof task.error !== 'string') throw new Error('Invalid task error')
      }
      const checked = new Set(), visiting = new Set()
      const visit = task => {
        if (checked.has(task.id)) return
        if (visiting.has(task.id)) throw new Error(`Cyclic dependencies for ${task.id}`)
        visiting.add(task.id)
        for (const dep of task.dependsOn) {
          if (!ids.has(dep)) throw new Error(`Invalid dependencies for ${task.id}`)
          visit(team.tasks.find(t => t.id === dep))
        }
        visiting.delete(task.id); checked.add(task.id)
      }
      for (const task of team.tasks) visit(task)
    }
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${randomUUID()}.tmp`
    writeFileSync(temp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temp, this.file)
  }

  /** Return detached owned JSON suitable for HTTP and model tool output. */
  state(sessionId) {
    return structuredClone({
      specialists: this.data.specialists,
      team: Object.hasOwn(this.data.teams, sessionId) ? this.data.teams[sessionId] : null,
      coordinators: Object.values(this.data.teams).map(t => ({ sessionId: t.sessionId, label: t.label ?? t.sessionId })),
      maxLimit: this.maxLimit,
    })
  }

  /** Replace the saved roster with the host's merged list (seeded defaults plus custom roles). */
  setRoster(list) {
    this.data.specialists = list.map(specialist)
    this.save()
  }

  team(sessionId) {
    text(sessionId, 'coordinator session id', 200)
    return Object.hasOwn(this.data.teams, sessionId)
      ? this.data.teams[sessionId]
      : { sessionId, maxActive: this.defaultMax, paused: false, tasks: [] }
  }

  /** Validate and commit one explicit command, then consider eligible queued tasks. */
  async action(sessionId, action, args = {}) {
    if (this.closed) throw new Error('Team plugin is stopping')
    // One command at a time per coordinator: two panel tabs, or a tool call
    // racing a panel action, must not interleave a status transition.
    const previous = this.actions.get(sessionId) ?? Promise.resolve()
    const run = previous.then(() => this.perform(sessionId, action, args))
    const settled = run.then(() => undefined, () => undefined)
    this.actions.set(sessionId, settled)
    try { return await run } finally {
      if (this.actions.get(sessionId) === settled) this.actions.delete(sessionId)
    }
  }

  /** Execute one command; only the per-coordinator chain in {@link action} calls this. */
  async perform(sessionId, action, args) {
    if (this.closed) throw new Error('Team plugin is stopping')
    if (action === 'status') return this.state(sessionId)
    if (action === 'save_specialist') {
      const next = specialist(args.specialist)
      const index = this.data.specialists.findIndex(s => s.id === next.id)
      if (index < 0) this.data.specialists.push(next)
      else this.data.specialists[index] = next
      this.save()
      return this.state(sessionId)
    }
    const team = this.team(sessionId)
    if (action === 'configure') team.maxActive = limit(args.maxActive, this.maxLimit)
    else if (action === 'resume') team.paused = false
    else if (action === 'assign') {
      const role = this.data.specialists.find(s => s.id === args.specialistId)
      if (!role) throw new Error('Unknown specialist')
      const title = text(args.title, 'title', 200)
      const prompt = text(args.prompt, 'prompt')
      const files = list(args.files ?? [], 'files').map(fileScope)
      if (role.mode === 'write' && !files.length) throw new Error('Writing assignments require at least one reserved file or directory; use . for the whole workspace')
      const dependsOn = list(args.dependsOn ?? [], 'dependsOn')
      if (dependsOn.some(id => !team.tasks.some(t => t.id === id))) throw new Error('Dependencies must reference existing tasks in this team')
      team.tasks.push({ id: `task-${randomUUID()}`, specialistId: role.id, specialist: { ...role }, title, prompt, files, dependsOn, status: 'queued', createdAt: Date.now() })
    } else if (action === 'retry') {
      const task = this.task(team, args.taskId)
      if (!TERMINAL.has(task.status)) throw new Error('Only a settled task can be retried')
      if (team.tasks.some(t => t.dependsOn.includes(task.id) && ACTIVE.has(t.status))) throw new Error('Stop active dependent assignments before retrying this task')
      task.status = 'queued'; delete task.error; delete task.result
      team.paused = false
    } else if (action === 'cancel') {
      const task = this.task(team, args.taskId)
      if (task.status === 'queued') task.status = 'canceled'
      else if (ACTIVE.has(task.status)) {
        task.status = 'canceling'
        this.save()
        this.operations.get(task.id)?.controller.abort()
        if (task.workerId) await this.adapter.interrupt({ sessionId, workerId: task.workerId })
      } else throw new Error('Task is already settled')
    } else if (action === 'message') {
      const task = this.task(team, args.taskId)
      const message = text(args.message, 'message')
      if (!task.workerId) throw new Error('This task does not have a worker conversation yet')
      if (ACTIVE.has(task.status)) throw new Error('Worker is busy. Stop or wait for it before sending a direct message; this prevents bypassing concurrency and file reservations.')
      // Direct follow-ups take the same reservations and scheduler path as assignments.
      task.nextMessage = message
      task.status = 'queued'; delete task.error; delete task.result
      team.paused = false
    } else throw new Error(`Unknown team action: ${action}`)
    if (!Object.hasOwn(this.data.teams, sessionId)) {
      Object.defineProperty(this.data.teams, sessionId, { configurable: true, enumerable: true, writable: true, value: team })
    }
    this.save()
    this.pump(sessionId)
    return this.state(sessionId)
  }

  task(team, id) {
    const task = team.tasks.find(t => t.id === id)
    if (!task) throw new Error('Unknown task in this coordinator conversation')
    return task
  }

  /** Return an owned worker assignment for admission guards, or null for unrelated agents. */
  worker(workerId) {
    for (const team of Object.values(this.data.teams)) {
      const task = team.tasks.find(t => t.workerId === workerId)
      if (task) return structuredClone({ sessionId: team.sessionId, task })
    }
    return null
  }

  /** Reconsider queued tasks when the owning coordinator becomes available. */
  live(sessionId) { this.pump(sessionId) }

  pump(sessionId) {
    if (this.closed || this.pumping.has(sessionId)) return
    const team = Object.hasOwn(this.data.teams, sessionId) ? this.data.teams[sessionId] : undefined
    if (!team || team.paused || !this.adapter.available(sessionId)) return
    this.pumping.add(sessionId)
    try {
      for (const task of team.tasks) {
        if (task.status !== 'queued') continue
        const deps = task.dependsOn.map(id => this.task(team, id))
        if (deps.some(t => ['failed', 'canceled', 'blocked'].includes(t.status))) {
          task.status = 'blocked'; task.error = 'A dependency did not complete successfully. Resolve it, then explicitly retry this task.'
          this.save(); continue
        }
        if (deps.some(t => t.status !== 'done')) continue
        const active = Object.values(this.data.teams).flatMap(t => t.tasks).filter(t => ACTIVE.has(t.status))
        if (active.length >= this.maxLimit || team.tasks.filter(t => ACTIVE.has(t.status)).length >= team.maxActive) break
        // Global declared path reservations conservatively serialize equal paths across workspaces too.
        // Readers participate so a review cannot race a declared overlapping writer.
        if (active.some(t => (t.specialist.mode === 'write' || task.specialist.mode === 'write')
          && (t.files.length ? t.files : ['.']).some(a => (task.files.length ? task.files : ['.']).some(b => overlaps(a, b))))) continue
        task.status = 'starting'; this.save()
        const controller = new AbortController()
        const operation = { controller, done: null }
        this.operations.set(task.id, operation)
        operation.done = this.launch(team, task, controller).finally(() => {
          if (this.operations.get(task.id) === operation) this.operations.delete(task.id)
          if (!this.operations.size) this.earlyEnds.clear()
        })
      }
    } finally { this.pumping.delete(sessionId) }
  }

  async launch(team, task, controller) {
    try {
      const reports = task.dependsOn.map(id => {
        const dependency = this.task(team, id)
        return `${dependency.title} (${dependency.id}):\n${dependency.result || '(No final text; inspect the worker transcript when needed.)'}`
      })
      const prompt = (task.nextMessage ?? task.prompt) + (reports.length ? `\n\nDependency reports:\n\n${reports.join('\n\n')}` : '')
      if (task.workerId) {
        await this.adapter.followup({ sessionId: team.sessionId, workerId: task.workerId,
          message: prompt, signal: controller.signal })
      } else {
        task.workerId = await this.adapter.start({ sessionId: team.sessionId, task: { ...structuredClone(task), prompt }, specialist: { ...task.specialist }, signal: controller.signal })
      }
      delete task.nextMessage
      // A resident follow-up can settle synchronously during inbox admission.
      if (TERMINAL.has(task.status)) return
      if (controller.signal.aborted || this.closed || task.status === 'canceling') {
        task.status = 'canceling'; this.save()
        await this.adapter.interrupt({ sessionId: team.sessionId, workerId: task.workerId })
      } else { task.status = 'working'; this.save() }
      const early = this.earlyEnds.get(task.workerId)
      if (early) { this.earlyEnds.delete(task.workerId); this.settle(task.workerId, early) }
    } catch (error) {
      task.status = controller.signal.aborted ? 'canceled' : 'failed'
      task.error = String(error?.message ?? error)
      this.save()
      queueMicrotask(() => this.pumpAll())
    }
  }

  /** A real subagent terminal event releases the assignment's reservations. */
  settle(workerId, outcome) {
    for (const team of Object.values(this.data.teams)) {
      const task = team.tasks.find(t => t.workerId === workerId && ACTIVE.has(t.status))
      if (!task) continue
      task.status = task.status === 'canceling' || outcome.stopReason === 'aborted' ? 'canceled' : outcome.stopReason === 'completed' ? 'done' : 'failed'
      task.result = typeof outcome.result === 'string' ? outcome.result : ''
      if (task.status === 'failed') task.error = `Worker ended with ${outcome.stopReason}`
      task.finishedAt = Date.now()
      this.save()
      queueMicrotask(() => this.pumpAll())
      return
    }
    // An extremely short worker may settle before startContinuable publishes its id.
    if (this.operations.size) this.earlyEnds.set(workerId, { stopReason: outcome.stopReason, result: outcome.result })
  }

  pumpAll() { for (const id of Object.keys(this.data.teams)) this.pump(id) }

  /** Close admission before aborting starts and awaiting worker interruption. */
  async dispose() {
    this.closed = true
    for (const op of this.operations.values()) op.controller.abort()
    const errors = []
    for (const team of Object.values(this.data.teams)) {
      team.paused = true
      for (const task of team.tasks.filter(t => ACTIVE.has(t.status))) {
        task.status = 'canceling'
        if (task.workerId) {
          try { await this.adapter.interrupt({ sessionId: team.sessionId, workerId: task.workerId }) }
          catch (error) { errors.push(error) }
        }
      }
    }
    await Promise.allSettled([...this.operations.values()].map(op => op.done))
    for (const team of Object.values(this.data.teams)) for (const task of team.tasks) {
      if (ACTIVE.has(task.status)) { task.status = 'blocked'; task.error = 'Team plugin stopped. Inspect files before retrying.' }
    }
    this.save()
    if (errors.length) throw new AggregateError(errors, 'Could not stop every team worker')
  }
}
