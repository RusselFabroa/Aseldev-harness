/**
 * AselDev teams, host half — wiring only. `engine.mjs` owns the store, the
 * scheduler, and the task state machine; this file gives it the three edges it
 * cannot have on its own:
 *
 * 1. A continuable-subagent adapter. Each assignment becomes one durable child
 *    conversation of the coordinating session (`startContinuable`,
 *    `followup`, `interrupt`).
 * 2. Settlement, from `subagent/end` into `engine.settle`.
 * 3. Admission: a per-child `toolFilter` at start and one global tool guard,
 *    because a preset edit cannot be allowed to widen a worker's reach.
 *
 * Model-facing `team_manage` and the panel API:
 *
 *   GET  /aseldev-teams/api/state?sessionId=   → engine.state(sessionId)
 *   POST /aseldev-teams/api/action             → engine.action(...)
 *
 * Both answer only this computer and require `x-aseldev-teams: 1`.
 *
 * Everything here is constructed inside an ASYNC `apply`, so a store that will
 * not open or a tool whose schema is rejected fails the plugin entry instead of
 * mounting a half-working addon.
 *
 * SCOPE: these restrictions coordinate trusted agents; they are not a security
 * boundary. A `write` teammate with a shell can start another harness, and
 * nothing here sandboxes one agent against another. The guard and the per-child
 * tool filters exist so the scheduler's concurrency limits and path reservations
 * keep meaning something — not to hold an adversary out.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'aseldev-teams'

/** The panel needs a web server; workers need the subagent capability. */
export const inject = ['webServer', 'subagents', 'agents']

/** Plugin config; every field is validated before any worker can start. */
export interface Config {
  /** Folder holding `state.json`. Default: $DSH_HOME/teams. */
  dir?: string
  /** Workers one conversation may run at once. Default: 3. */
  maxActive?: number
  /** Workers this store may run at once, across every conversation. Default: 12. */
  maxLimit?: number
  /** Subagent provider carrying a worker conversation. Default: 'spawn'. */
  provider?: string
  /** Route for worker Agents, overriding what they inherit. */
  model?: { provider?: string; model?: string; maxTokens?: number }
  /**
   * `append` (default) sends the specialist role as a `persona`, which shadows
   * the preset persona for that child alone, so the role survives follow-up
   * turns. `inherit` sends none and leaves the preset persona untouched.
   */
  personaMode?: 'append' | 'inherit'
  /**
   * Explicit allow-list for a `read` specialist. Omitted derives it from the
   * registry: every visible tool except the mutating and delegation sets.
   */
  readTools?: string[]
  /** Extra names denied to a `write` specialist. */
  delegationTools?: string[]
  /** How long `interrupt` waits for a stopped worker to become quiet. Default: 15000. */
  interruptWaitMs?: number
}

// ─── engine contract (engine.mjs) ───────────────────────────────────────────

interface TaskLike {
  readonly id: string
  readonly specialistId: string
  readonly title: string
  readonly prompt: string
  readonly status: string
  readonly workerId?: string
  readonly files: readonly string[]
  readonly dependsOn: readonly string[]
  readonly result?: string
  readonly error?: string
  readonly specialist?: SpecialistLike
}

interface SpecialistLike {
  readonly id: string
  readonly name: string
  readonly mode: 'read' | 'write'
  readonly instructions: string
}

interface TeamStateLike {
  readonly specialists: readonly SpecialistLike[]
  readonly team: {
    readonly sessionId: string
    readonly maxActive: number
    readonly paused: boolean
    readonly tasks: readonly TaskLike[]
  } | null
  readonly coordinators: readonly { readonly sessionId: string; readonly label: string }[]
  readonly maxLimit?: number
}

/** The four calls the engine makes into this file. */
interface TeamAdapterLike {
  available(sessionId: string): boolean
  start(input: { sessionId: string; task: TaskLike; specialist: SpecialistLike; signal: AbortSignal }): Promise<string>
  followup(input: { sessionId: string; workerId: string; message: string; signal: AbortSignal }): Promise<void>
  interrupt(input: { sessionId: string; workerId: string }): Promise<void>
}

interface TeamEngineLike {
  state(sessionId: string): TeamStateLike
  action(sessionId: string, action: string, args?: Record<string, unknown>): Promise<TeamStateLike>
  settle(workerId: string, outcome: { stopReason: string; result: string }): void
  worker(workerId: string): { sessionId: string; task: TaskLike } | null
  live(sessionId: string): void
  dispose(): Promise<void>
}

// ─── harness surfaces ───────────────────────────────────────────────────────

interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

interface ToolExecutionLike {
  readonly name: string
  readonly arguments: unknown
  readonly agent?: { readonly id?: unknown }
}

interface ToolRunLike {
  readonly agent?: { readonly id?: unknown }
  readonly signal: AbortSignal
}

interface ToolSchemaLike {
  readonly name?: unknown
}

interface ToolRuntimeLike {
  register(definition: unknown): () => void
  guard(guard: (execution: ToolExecutionLike) => string | undefined): () => void
  /**
   * The model-facing projection for one viewing key. The registry accepts the
   * Agent itself (schemas(agent), see code-mode.ts and the preset mount test),
   * so no scope package is involved and no scope symbol can go stale.
   */
  schemas(view?: unknown): readonly ToolSchemaLike[]
}

interface AgentLike {
  readonly id: string
}

interface AgentLikeWithIdle extends AgentLike {
  whenIdle?(): Promise<void>
}

interface AgentRegistryLike {
  get(id: string): AgentLikeWithIdle | undefined
}

interface ContentTextLike {
  readonly type: 'text'
  readonly text: string
}

interface SubagentRuntimeLike {
  startContinuable(spec: {
    provider: string
    label: string
    request: {
      prompt: ContentTextLike[]
      parent: AgentLike
      agentOptions?: Record<string, unknown>
      persona?: string
      toolFilter?: { allow?: string[]; deny?: string[] }
    }
    signal: AbortSignal
  }): Promise<{ childId: string; messageId: string }>
  followup(
    parent: AgentLike,
    childId: string,
    content: ContentTextLike[],
    options: { source: { kind: 'coordinator'; form: 'relay'; senderSessionId: string }; signal: AbortSignal },
  ): Promise<string>
  interrupt(targetSessionId: string, authority: SubagentInterruptAuthorityLike): void
}

/**
 * Authority for one interrupt: the durable direct-parent address (works while
 * the coordinator is offline) or an exact live ancestor Agent.
 */
type SubagentInterruptAuthorityLike =
  | { readonly kind: 'user'; readonly parentSessionId: string }
  | { readonly kind: 'ancestor'; readonly agent: AgentLike }

/** Only these `subagent/end` fields are read. */
interface SubagentEndLike {
  readonly id?: unknown
  readonly stopReason?: unknown
  readonly lastAssistantMessage?: unknown
}

/** One claimed user-role message. */
interface ClaimedMessageLike {
  readonly id?: unknown
  readonly source?: { readonly kind?: unknown } | undefined
}

interface PreStepPayloadLike {
  readonly agent?: { readonly id?: unknown } | undefined
  readonly messages?: readonly ClaimedMessageLike[] | undefined
}

type PreStepDecisionLike =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: readonly ClaimedMessageLike[] }

interface SystemPromptLike {
  context(entry: {
    name: string
    order: number
    text: string | ((context: { agent?: { id?: unknown }; scope?: unknown }) => string)
  }): () => void
}

interface ContextLike {
  readonly webServer: WebServerLike
  readonly subagents: SubagentRuntimeLike
  readonly agents: AgentRegistryLike
  get(name: string): unknown
  /** `inject` runs the callback once the named service is composed. */
  inject(deps: ['tools'], callback: (ctx: InjectedTools) => void): unknown
  inject(deps: ['systemPrompt'], callback: (ctx: InjectedPrompt) => void): unknown
  on(event: 'subagent/end', listener: (info: SubagentEndLike) => void): () => void
  on(
    event: 'agent/pre-step',
    listener: (payload: PreStepPayloadLike, next: () => Promise<PreStepDecisionLike>) => Promise<PreStepDecisionLike>,
  ): () => void
  on(event: 'agent/created', listener: (payload: { agent?: { id?: unknown } }) => void): () => void
  effect(fn: () => () => void | Promise<void>, label?: string): unknown
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
}

/** Context handed to an `inject(['tools'])` callback: the registry is present. */
interface InjectedTools extends ContextLike {
  readonly tools: ToolRuntimeLike
}

/** Context handed to an `inject(['systemPrompt'])` callback. */
interface InjectedPrompt extends ContextLike {
  readonly systemPrompt: SystemPromptLike
}

// ─── constants ──────────────────────────────────────────────────────────────

const TEAM_TOOL = 'team_manage'

const ACTIONS = ['status', 'save_specialist', 'configure', 'assign', 'cancel', 'retry', 'message', 'resume'] as const
type ActionName = (typeof ACTIONS)[number]

/** Code Mode's presentation transport: `restrict()` refuses to name it. */
const CODE_MODE_TRANSPORT = 'run_code'

/** Delegation, peer messaging, and team control. `subagent_` prefix included. */
const DELEGATION_TOOLS = [
  'subagent',
  'subagent_fork',
  'send_message',
  'interrupt_agent',
  'list_agents',
  'workflow',
  'ralph',
]

const DELEGATION_NAMES = new Set([...DELEGATION_TOOLS, TEAM_TOOL])

/**
 * The inspection-only tools a `read` specialist may use.
 *
 * A POSITIVE list: the allow-list is built by intersecting this with what the
 * conversation can actually see, so a tool composed later — including one that
 * mutates — is absent by default rather than admitted by omission. A deployment
 * that needs a different set supplies `readTools`, which is trusted config.
 */
const INSPECTION_TOOLS = [
  'read',
  'read_image',
  'glob',
  'grep',
  'web_search',
  'brain_read',
  'brain_search',
  'todo_write',
  'ask_user_question',
]

/** The standing coordination instruction, registered on every assembly. */
const COORDINATION_TEXT = 'For multi-agent work in ordinary coordinator conversations, use team_manage and saved specialists rather than ad hoc delegation; start with status; declare file scopes; report actual checks. Team workers only execute own assignment.'

/**
 * Names a read worker may still call although a filter cannot vouch for them:
 * child-scoped tools the restriction layer exempts, and the Code Mode transport
 * the model actually calls. Without these a read worker could not report at all.
 */
const READ_EXEMPT = new Set(['report', 'structured_output', CODE_MODE_TRANSPORT])

/** Statuses during which a worker is legitimately working for the scheduler. */
const CONVERSING_STATUSES = new Set(['starting', 'working'])

/** Message sources that inject context rather than open a scheduled turn. */
const NON_WAKING_SOURCES = new Set(['tool', 'plugin', 'subagent-report', 'subagent-settled'])

const DEFAULT_MAX_ACTIVE = 3
const DEFAULT_MAX_LIMIT = 12
const DEFAULT_PROVIDER = 'spawn'
const DEFAULT_INTERRUPT_WAIT_MS = 15000

/** Engine-delivered message ids remembered per worker. */
const ADMITTED_MAX = 32

/** Bounds on the durable/persisted surface. */
const MAX_BODY_BYTES = 1024 * 1024
const RESULT_MAX_CHARS = 8000
const BOARD_TASK_LIMIT = 40

const ACTIVE_STATUSES = new Set(['starting', 'working', 'canceling'])

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

const TOOL_DESCRIPTION = [
  'Run this conversation\'s team: saved specialists, assignments, and the worker teammates carrying them out.',
  'A specialist is a durable role (id, name, mode "read" or "write", instructions); not a preset, not a session.',
  'An assignment becomes a background teammate conversation that keeps its own history, so a later message continues the same',
  'teammate. Assignments run in parallel up to the configured limit; two writing assignments reserving overlapping paths never',
  'run together, so reserve the exact files or directories each needs. Actions: "status" reads the board; "save_specialist"',
  'creates or replaces a specialist; "assign" queues an assignment; "message" sends a settled teammate more work; "cancel" stops',
  'the current turn; "retry" re-queues a settled assignment; "configure" sets this conversation\'s concurrency; "resume" unpauses.',
  'After a restart every team is paused and anything that was running is blocked: inspect the shared files, then retry deliberately.',
  'You get no result from assign or message; ask for status, and read a teammate transcript only when you need its detail.',
].join(' ')

// ─── helpers ────────────────────────────────────────────────────────────────

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

class HttpError extends Error {
  readonly status: number
  constructor(status: number, text: string) {
    super(text)
    this.status = status
  }
}

/**
 * Whether a tool name is delegation, peer messaging, or team control.
 * @param name - tool name as registered.
 * @returns whether no teammate may call it.
 */
function isDelegationName(name: string): boolean {
  return DELEGATION_NAMES.has(name) || name.startsWith('subagent_')
}

/**
 * Import a harness package.
 *
 * The profile's `node_modules` is the normal source: this plugin lives outside
 * any package tree, so bare imports from here would only reach what the profile
 * installed. A deployment that loads the plugin straight from a checkout instead
 * has no profile install, so plain module resolution from this file is the
 * fallback. Only the tool schema helper is imported — tool visibility is asked
 * with the Agent itself, so no scope package is involved.
 * @param pkg - package specifier.
 * @returns the loaded module namespace.
 */
const profileRequire = createRequire(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'aseldev-teams.cjs'))
async function fromProfile(pkg: string): Promise<Record<string, unknown>> {
  const searched = profileRequire.resolve.paths(pkg) ?? []
  const base = searched.find(dir => existsSync(join(dir, pkg, 'package.json')))
  if (base === undefined) {
    try {
      return await import(pkg) as Record<string, unknown>
    } catch (error: unknown) {
      throw new Error(
        `aseldev-teams: ${pkg} is installed neither in the profile (${searched.join(', ')}) `
        + `nor through this plugin's own resolution (${message(error)})`,
      )
    }
  }
  const manifestPath = join(base, pkg, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { main?: string; exports?: Record<string, unknown> }
  const dot = manifest.exports?.['.']
  const entry = typeof dot === 'string'
    ? dot
    : typeof dot === 'object' && dot !== null
      ? String((dot as Record<string, unknown>).import ?? (dot as Record<string, unknown>).default)
      : manifest.main ?? 'index.js'
  return import(pathToFileURL(join(dirname(manifestPath), entry)).href) as Promise<Record<string, unknown>>
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function hostname(hostHeader: string | undefined): string | undefined {
  if (hostHeader === undefined) return undefined
  return hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0]
}

/** Only this computer, addressed by a local host name, with the trust header. */
function assertApiCaller(req: IncomingMessage): void {
  const remote = req.socket.remoteAddress ?? ''
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  if (!loopback) throw new HttpError(403, 'teams only answer this computer')
  if (!LOCAL_HOSTS.has(hostname(req.headers.host) ?? '')) throw new HttpError(403, 'unexpected Host header')
  const origin = req.headers.origin
  if (origin !== undefined) {
    let originHost: string
    try { originHost = new URL(origin).host } catch { throw new HttpError(403, 'bad Origin header') }
    if (originHost !== req.headers.host) throw new HttpError(403, 'cross-origin request refused')
  }
  if (req.headers['x-aseldev-teams'] !== '1') throw new HttpError(403, 'missing x-aseldev-teams header')
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new HttpError(413, `request body is over ${MAX_BODY_BYTES} bytes`)
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') throw new HttpError(400, 'an empty body has no action')
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new HttpError(400, 'the body is not valid JSON') }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'the body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function requireSessionId(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'sessionId is required')
  const id = value.trim()
  if (id === '' || id.length > 200) throw new HttpError(400, 'sessionId must be a non-empty string under 200 characters')
  return id
}

/** Forward only the argument names the engine documents. */
function engineArgs(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of ['specialistId', 'title', 'prompt', 'taskId', 'message', 'specialist', 'maxActive']) {
    if (input[key] !== undefined) out[key] = input[key]
  }
  for (const key of ['files', 'dependsOn']) {
    const value = input[key]
    if (value !== undefined) out[key] = Array.isArray(value) ? value.map(String) : []
  }
  return out
}

/** Marker appended when a closing message is cut; counted INSIDE the bound. */
const RESULT_TRUNCATED = '\n… [truncated]'

/** The worker's closing message: text leaves only, bounded for the store. */
function resultText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const block of value) {
    if (block === null || typeof block !== 'object') continue
    const record = block as { type?: unknown; text?: unknown }
    if (record.type === 'text' && typeof record.text === 'string' && record.text.trim() !== '') parts.push(record.text)
  }
  const text = parts.join('\n\n').trim()
  if (text.length <= RESULT_MAX_CHARS) return text
  // The marker is part of the retained value, so it is reserved FROM the bound
  // rather than appended past it: the stored result never exceeds the limit.
  return text.slice(0, RESULT_MAX_CHARS - RESULT_TRUNCATED.length) + RESULT_TRUNCATED
}

/**
 * Static standing policy for a worker.
 *
 * Nothing here interpolates caller data. A persona is a STRICT `{{variable}}`
 * template (`packages/core/system-prompt/src/index.ts:205`), so a specialist
 * whose instructions happened to contain `{{something}}` would fail assembly as
 * an unknown variable. The instructions therefore travel in the assignment
 * message instead: plain user text, logged, and needing no escaping.
 */
const PERSONA_BASE = 'You are a coding agent working as one member of a coordinated team, in a working directory shared with the coordinator and other workers.'

const READ_RULE = 'This assignment is read-only: inspect and report. Change no file.'
const WRITE_RULE = 'You may modify files in this assignment. Another worker may be editing a different part of the same directory.'
const NO_DELEGATION = 'You cannot delegate, message other agents, or change this team. A task needing more access than this assignment allows ends with a reported limitation, not a retry.'

/**
 * The mode rule: a fixed string per mode, never caller text.
 * @param mode - the specialist mode.
 * @returns the rule sentence for this assignment.
 */
function modeRule(mode: 'read' | 'write'): string {
  return mode === 'read' ? READ_RULE : WRITE_RULE
}

/**
 * The assignment's role block: the specialist's own instructions, plus the
 * static rules when no persona is being sent to carry them.
 * @param specialist - the role taking this assignment.
 * @param withRules - whether the persona is absent, so the rules ride the prompt.
 * @returns plain text for the first user message.
 */
function roleText(specialist: SpecialistLike, withRules: boolean): string {
  return withRules
    ? [specialist.instructions, modeRule(specialist.mode), NO_DELEGATION].join('\n\n')
    : specialist.instructions
}

/**
 * The worker's first user message. The engine has already composed `task.prompt`
 * with any dependency reports.
 * @param task - the assignment, whose `prompt` is the composed text.
 * @param mode - the specialist mode, which decides the reservation sentence.
 * @param role - the role statement, supplied only when no persona carries it.
 * @returns the message text.
 */
function assignmentText(task: TaskLike, mode: 'read' | 'write', role: string | undefined): string {
  const parts = [`Assignment: ${task.title}`]
  if (role !== undefined) parts.push('', role)
  parts.push('', task.prompt)
  if (task.files.length > 0) {
    parts.push('', `Reserved paths: ${task.files.join(', ')}. Other workers are blocked from overlapping paths; stay inside these, or report that the assignment is wrong rather than widening it.`)
  } else if (mode === 'write') {
    parts.push('', 'Reserved paths: the whole workspace.')
  }
  return parts.join('\n')
}

function labelFor(task: TaskLike, specialist: SpecialistLike): string {
  const label = `${specialist.name}: ${task.title}`
  return label.length <= 120 ? label : `${label.slice(0, 119)}…`
}

/** Compact board for the tool result; the full state is the panel's. */
function board(input: unknown): string {
  if (input === null || typeof input !== 'object') return 'No team state.'
  const state = input as TeamStateLike
  const specialists = Array.isArray(state.specialists) ? state.specialists : []
  const lines = [specialists.length === 0
    ? 'Specialists: none saved yet.'
    : `Specialists: ${specialists.map(s => `${s.id} (${s.mode}) ${s.name}`).join('; ')}`]
  if (state.team === null || state.team === undefined) {
    lines.push('No team yet in this conversation: an "assign" creates one.')
    return lines.join('\n')
  }
  const tasks = Array.isArray(state.team.tasks) ? state.team.tasks : []
  const active = tasks.filter(task => ACTIVE_STATUSES.has(task.status)).length
  lines.push(`Team: ${state.team.paused ? 'paused (ask to resume)' : 'running'}; ${active} of ${state.team.maxActive} slot(s) busy; ${tasks.length} assignment(s).`)
  if (tasks.length === 0) {
    lines.push('No assignments yet.')
    return lines.join('\n')
  }
  const shown = tasks.slice(-BOARD_TASK_LIMIT)
  if (tasks.length > shown.length) lines.push(`(${tasks.length - shown.length} older assignment(s) not shown.)`)
  for (const task of shown) {
    const details = [
      task.specialistId,
      ...(task.files.length > 0 ? [`paths ${task.files.join(', ')}`] : []),
      ...(task.dependsOn.length > 0 ? [`after ${task.dependsOn.join(', ')}`] : []),
    ]
    lines.push(`- [${task.status}] ${task.id} "${task.title}" — ${details.join('; ')}`)
    const outcome = task.error ?? task.result
    if (outcome !== undefined && outcome !== '') lines.push(`    ${outcome.replace(/\s+/g, ' ').slice(0, 400)}`)
  }
  return lines.join('\n')
}

/**
 * Wait for one Agent to reach quiescence, bounded.
 * @param idle - the agent's `whenIdle`, already bound.
 * @param ms - longest accepted wait.
 * @returns whether quiescence was observed inside the bound.
 */
async function quietWithin(idle: () => Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const expired = new Promise<false>((resolve) => {
      timer = setTimeout(() => { resolve(false) }, ms)
    })
    return await Promise.race([idle().then(() => true as const), expired])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function integerInRange(value: unknown, label: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`aseldev-teams: ${label} must be an integer from ${min} to ${max}`)
  }
  return value
}

function toolSet(value: unknown, label: string): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0
    || value.some(entry => typeof entry !== 'string' || entry.trim() === '')) {
    throw new Error(`aseldev-teams: ${label} must be a non-empty list of tool names`)
  }
  return new Set(value.map(entry => (entry as string).trim()))
}

interface Settings {
  readonly dir: string
  readonly file: string
  readonly maxActive: number
  readonly maxLimit: number
  readonly provider: string
  readonly agentOptions: Record<string, unknown> | undefined
  readonly personaMode: 'append' | 'inherit'
  readonly readAllow: ReadonlySet<string> | undefined
  readonly denyExtras: ReadonlySet<string>
  readonly interruptWaitMs: number
}

const NO_EXTRA_DENIES: ReadonlySet<string> = new Set()

function readSettings(config: Config): Settings {
  const maxLimit = integerInRange(config.maxLimit, 'maxLimit', DEFAULT_MAX_LIMIT, 1, 1000)
  const maxActive = integerInRange(config.maxActive, 'maxActive', DEFAULT_MAX_ACTIVE, 1, maxLimit)
  const provider = config.provider ?? DEFAULT_PROVIDER
  if (typeof provider !== 'string' || provider.trim() === '') {
    throw new Error('aseldev-teams: provider must name a registered subagent provider')
  }
  const personaMode = config.personaMode ?? 'append'
  if (personaMode !== 'append' && personaMode !== 'inherit') {
    throw new Error('aseldev-teams: personaMode must be "append" or "inherit"')
  }
  let agentOptions: Record<string, unknown> | undefined
  const model = config.model
  if (model !== undefined) {
    if (typeof model !== 'object' || model === null) throw new Error('aseldev-teams: model must be an object')
    const resolved: Record<string, unknown> = {}
    for (const key of ['provider', 'model'] as const) {
      const value = model[key]
      if (value === undefined) continue
      if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`aseldev-teams: model.${key} must be a non-empty string`)
      }
      resolved[key] = value
    }
    if (model.maxTokens !== undefined) {
      resolved.maxTokens = integerInRange(model.maxTokens, 'model.maxTokens', 0, 1, 2 ** 31 - 1)
    }
    if (Object.keys(resolved).length > 0) agentOptions = resolved
  }
  const dir = resolve(config.dir !== undefined && config.dir.trim() !== ''
    ? config.dir
    : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'teams'))
  return {
    dir,
    // The documented store location: <dsh home>/teams/state.json.
    file: join(dir, 'state.json'),
    maxActive,
    maxLimit,
    provider: provider.trim(),
    agentOptions,
    personaMode,
    readAllow: toolSet(config.readTools, 'readTools'),
    denyExtras: toolSet(config.delegationTools, 'delegationTools') ?? NO_EXTRA_DENIES,
    interruptWaitMs: integerInRange(config.interruptWaitMs, 'interruptWaitMs', DEFAULT_INTERRUPT_WAIT_MS, 0, 600_000),
  }
}

// ─── plugin ─────────────────────────────────────────────────────────────────

/**
 * Wire the store, its tools, and the panel API.
 *
 * Awaits the store and the tool schema: a composition that cannot run this
 * plugin must fail its entry, not log a warning and leave an addon whose tools
 * misbehave.
 * @param ctx - Loader context.
 * @param config - plugin config from the profile patch.
 */
export async function apply(ctx: ContextLike, config: Config = {}): Promise<void> {
  const settings = readSettings(config)
  mkdirSync(settings.dir, { recursive: true })

  /** Admission is closed during teardown; the engine reference is retained so `settle` still runs. */
  let closing = false

  // Retain injected capabilities through teardown, even after registry unpublication.
  const subagents = ctx.subagents
  const agents = ctx.agents
  const webServer = ctx.webServer
  const tools = (): ToolRuntimeLike | undefined => ctx.get('tools') as ToolRuntimeLike | undefined

  /** Engine-delivered message ids per worker; the only wakes a teammate may accept. */
  const admitted = new Map<string, Set<string>>()
  const admit = (workerId: string, messageId: unknown): void => {
    if (typeof messageId !== 'string' || messageId === '') return
    let ids = admitted.get(workerId)
    if (ids === undefined) {
      ids = new Set()
      admitted.set(workerId, ids)
    }
    ids.add(messageId)
    if (ids.size > ADMITTED_MAX) {
      const oldest = ids.values().next().value
      if (oldest !== undefined) ids.delete(oldest)
    }
  }

  /** Read workers' computed allow-lists, so the guard enforces the same set as the filter. */
  const readAllowOf = new Map<string, ReadonlySet<string>>()

  ctx.inject(['systemPrompt'], (pctx) => {
    pctx.systemPrompt.context({
      name: 'teams:coordination',
      order: 118,
      text: COORDINATION_TEXT,
    })
  })

  /**
   * Per-worker gates for a delivery in flight.
   *
   * `followup` returns the message id only AFTER the message is accepted into
   * the worker's inbox, and the loop can claim it through `agent/pre-step` first.
   * A claim that ran then would look unscheduled and be refused, so the listener
   * waits on any open gate for that worker and `followup` closes it once the id
   * is recorded (or once the delivery failed, so the claim is judged on its
   * merits).
   */
  interface Gate { readonly done: Promise<void>; readonly close: () => void }
  const gates = new Map<string, Gate[]>()
  const openGate = (workerId: string): Gate => {
    let release!: () => void
    const done = new Promise<void>((resolve) => { release = resolve })
    let closed = false
    const gate: Gate = {
      done,
      close: () => {
        if (closed) return
        closed = true
        release()
        const open = gates.get(workerId)
        if (open === undefined) return
        const index = open.indexOf(gate)
        if (index >= 0) open.splice(index, 1)
        if (open.length === 0) gates.delete(workerId)
      },
    }
    const open = gates.get(workerId) ?? []
    open.push(gate)
    gates.set(workerId, open)
    return gate
  }
  /** Resolve once every delivery in flight for this worker has recorded its id. */
  const awaitGates = async (workerId: string): Promise<void> => {
    const open = gates.get(workerId)
    if (open === undefined || open.length === 0) return
    await Promise.all(open.map(gate => gate.done))
  }

  const parentOf = (sessionId: string): AgentLike | undefined => agents.get(sessionId)

  const visibleNames = (parent: AgentLike): string[] => {
    const runtime = tools()
    if (runtime === undefined || runtime.schemas === undefined) {
      throw new Error('aseldev-teams: the tool registry cannot report visibility, so a worker cannot be restricted; refusing to start one')
    }
    let schemas: readonly ToolSchemaLike[]
    try {
      schemas = runtime.schemas(parent)
    } catch (error: unknown) {
      throw new Error(`aseldev-teams: the tool registry failed to report visibility (${message(error)}), so a worker cannot be restricted; refusing to start one`)
    }
    if (!Array.isArray(schemas)) throw new Error('aseldev-teams: the tool registry answered no schema list for this conversation')
    return schemas
      .map(schema => (typeof schema?.name === 'string' ? schema.name : undefined))
      .filter((toolName): toolName is string => toolName !== undefined && toolName !== CODE_MODE_TRANSPORT)
  }

  /** The read allow-list for one conversation; throws when it cannot be derived. */
  const readAllowFor = (parent: AgentLike): ReadonlySet<string> => {
    // A positive inspection list intersected with visibility: anything the list
    // does not name is excluded, so an unknown tool composed later stays out.
    const wanted = settings.readAllow ?? new Set(INSPECTION_TOOLS)
    const allow = visibleNames(parent).filter(name => wanted.has(name))
    if (allow.length === 0) {
      throw new Error('aseldev-teams: no inspection tool from the read set is visible to this conversation, so a read worker cannot be restricted; use a write specialist')
    }
    return new Set(allow)
  }

  const filterFor = (parent: AgentLike, specialist: SpecialistLike): { toolFilter?: { allow?: string[]; deny?: string[] }; allow?: ReadonlySet<string> } => {
    if (specialist.mode === 'read') {
      const allow = readAllowFor(parent)
      return { toolFilter: { allow: [...allow] }, allow }
    }
    const deny = visibleNames(parent).filter(name => isDelegationName(name) || settings.denyExtras.has(name))
    return deny.length === 0 ? {} : { toolFilter: { deny } }
  }

  /**
   * The standing policy as a persona; it shadows the preset persona for this
   * child alone. Static text only — see {@link PERSONA_BASE}.
   */
  const personaFor = (specialist: SpecialistLike): string | undefined => {
    if (settings.personaMode === 'inherit') return undefined
    return [PERSONA_BASE, modeRule(specialist.mode), NO_DELEGATION].join('\n\n')
  }

  const engineModule = await import(new URL('./engine.mjs', import.meta.url).href) as {
    TeamEngine: new (options: { file: string; maxActive: number; maxLimit: number; adapter: TeamAdapterLike }) => TeamEngineLike
  }

  /** Assigned after the adapter exists; every adapter method reads it at call time. */
  let engine: TeamEngineLike

  const adapter: TeamAdapterLike = {
    available(sessionId) {
      return agents.get(sessionId) !== undefined
    },

    async start({ sessionId, task, specialist, signal }) {
      const runtime = subagents
      const parent = parentOf(sessionId)
      if (parent === undefined) throw new Error('the coordinating conversation is not live')
      const persona = personaFor(specialist)
      const { toolFilter, allow } = filterFor(parent, specialist)
      const { childId, messageId } = await runtime.startContinuable({
        provider: settings.provider,
        label: labelFor(task, specialist),
        signal,
        request: {
          // The specialist's own instructions always ride the assignment: they
          // must never enter the persona, which is a strict template.
          prompt: [{ type: 'text', text: assignmentText(task, specialist.mode, roleText(specialist, persona === undefined)) }],
          parent,
          ...settings.agentOptions !== undefined ? { agentOptions: settings.agentOptions } : {},
          ...persona !== undefined ? { persona } : {},
          ...toolFilter !== undefined ? { toolFilter } : {},
        },
      })
      admit(childId, messageId)
      // The guard enforces this same set, including for a tool composed later.
      if (allow !== undefined) readAllowOf.set(childId, allow)
      return childId
    },

    async followup({ sessionId, workerId, message, signal }) {
      const runtime = subagents
      const parent = parentOf(sessionId)
      if (parent === undefined) throw new Error('the coordinating conversation is not live')
      // A cold worker has no in-memory allow-list; recompute it so the guard
      // enforces the same set the persisted filter does.
      if (engine.worker(workerId)?.task.specialist?.mode === 'read' && !readAllowOf.has(workerId)) {
        readAllowOf.set(workerId, readAllowFor(parent))
      }
      const gate = openGate(workerId)
      try {
        const messageId = await runtime.followup(parent, workerId, [{ type: 'text', text: message }], {
          source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
          signal,
        })
        admit(workerId, messageId)
      } finally {
        gate.close()
      }
    },

    async interrupt({ sessionId, workerId }) {
      const runtime = subagents
      // The durable direct-parent address, not the live Agent: a worker stays
      // stoppable while its coordinator is offline, which is exactly when a
      // stuck teammate most needs stopping.
      runtime.interrupt(workerId, { kind: 'user', parentSessionId: sessionId as never })
      const agent = agents.get(workerId)
      if (agent?.whenIdle === undefined) return
      if (closing) {
        // Teardown reports real quiescence: a timeout here would let the tree
        // leave a worker behind while claiming it stopped.
        await agent.whenIdle()
        return
      }
      // `interrupt` is fire-and-return; the engine awaits this call to mean the
      // worker stopped, so wait for quiescence on top of the cancel signal.
      const quiet = await quietWithin(agent.whenIdle.bind(agent), settings.interruptWaitMs)
      if (!quiet) {
        ctx.logger.warn(`aseldev-teams: teammate ${workerId} did not become quiet within ${settings.interruptWaitMs}ms of being stopped`)
      }
    },
  }

  engine = new engineModule.TeamEngine({
    file: settings.file,
    maxActive: settings.maxActive,
    maxLimit: settings.maxLimit,
    adapter,
  })
  ctx.logger.info(`aseldev-teams: ${settings.file} (maxActive ${settings.maxActive}, maxLimit ${settings.maxLimit}, provider ${settings.provider})`)

  // Admission: the guard identifies a worker by the calling agent id and refuses
  // what the engine may not offer it. A read worker is denied everything outside
  // its computed allow-list, so a tool composed later cannot widen it. This is
  // coordination hygiene for trusted teammates, not a fence around them.
  ctx.inject(['tools'], (tctx) => {
    tctx.tools.guard((execution) => {
      const workerId = execution.agent?.id
      if (typeof workerId !== 'string') return undefined
      const worker = engine.worker(workerId)
      if (worker === null) return undefined
      if (closing || !CONVERSING_STATUSES.has(worker.task.status)) return 'Refused: this assignment is not accepting tool calls.'
      const name = execution.name
      if (isDelegationName(name)) {
        return `Refused: ${name} would let this teammate delegate, message, or inspect agents. Answer inside your assignment and report instead.`
      }
      if (worker.task.specialist?.mode !== 'read') {
        return settings.denyExtras.has(name) ? `Refused: ${name} is disabled for team workers.` : undefined
      }
      const allow = readAllowOf.get(workerId)
      if (allow === undefined) {
        return `Refused: ${name} is not available because this teammate's read-only allow-list is not loaded. Report the limitation instead.`
      }
      if (allow.has(name) || READ_EXEMPT.has(name)) return undefined
      return `Refused: ${name} is outside this teammate's read-only tool set. Report what should change instead.`
    })
  })

  // Settlement stays live during teardown: the engine awaits `interrupt` and its
  // own drains while these events are still arriving.
  ctx.on('subagent/end', (info) => {
    const workerId = info?.id
    if (typeof workerId !== 'string') return
    try {
      engine.settle(workerId, {
        stopReason: typeof info.stopReason === 'string' ? info.stopReason : 'error',
        result: resultText(info.lastAssistantMessage),
      })
      // Settlement means the worker is quiescent, so its read allow-list can be
      // recomputed on any later delivery. Admitted ids are kept: dropping one
      // that a queued delivery still holds would refuse the worker's next turn.
      readAllowOf.delete(workerId)
    } catch (error: unknown) {
      ctx.logger.warn(`aseldev-teams: could not record the end of teammate ${workerId}: ${message(error)}`)
    }
  })

  // A coordinator that (re)opens resumes its own queued work. `live` re-pumps the
  // team and is a no-op for a paused or still-absent team, so nothing is
  // scheduled that the operator has not unpaused.
  ctx.on('agent/created', (payload) => {
    const sessionId = payload?.agent?.id
    if (typeof sessionId !== 'string' || closing) return
    try { engine.live(sessionId) } catch { /* a store that is closing owes this agent nothing */ }
  })

  // A teammate is an ordinary Session, so its composer can send a message that
  // never touched the scheduler — skipping the busy check and the path
  // reservations a settled assignment no longer holds. Two independent
  // conditions, both required for a message that would wake a worker:
  //   - the assignment is `starting` or `working` (the scheduler sets `starting`
  //     BEFORE delivering, so its own wakes satisfy this);
  //   - the message id is one this plugin itself got accepted, so a coordinator's
  //     `send_message` tool cannot wake a teammate behind the scheduler's back.
  // Injected context and tool-owed continuations are not wakes and pass through.
  // An UNMAPPED id passes: `startContinuable` admits the first message before it
  // returns the id, and that child is already persona- and filter-restricted.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const workerId = payload?.agent?.id
    if (typeof workerId !== 'string') return decision
    let worker = engine.worker(workerId)
    if (worker === null) return decision
    if (closing) return { kind: 'reject' }
    const claimed = decision.messages ?? []
    if (claimed.length === 0) return decision
    const wakes = claimed.filter(item => !NON_WAKING_SOURCES.has(typeof item.source?.kind === 'string' ? item.source.kind : ''))
    if (wakes.length === 0) return decision
    // A delivery in flight has not returned its message id yet; its claim must
    // wait rather than be judged unscheduled. The gate closes once the id is
    // recorded or the delivery rejected.
    await awaitGates(workerId)
    worker = engine.worker(workerId)
    if (closing || worker === null) return { kind: 'reject' }
    if (!CONVERSING_STATUSES.has(worker.task.status)) {
      ctx.logger.warn(
        `aseldev-teams: refused a direct message to teammate ${workerId} (assignment ${worker.task.id} is "${worker.task.status}"). `
        + 'Teammates accept work only through the Team panel or team_manage, which applies concurrency and path reservations.',
      )
      return { kind: 'reject' }
    }
    const ids = admitted.get(workerId)
    const unscheduled = wakes.filter(item => typeof item.id !== 'string' || ids?.has(item.id) !== true)
    if (unscheduled.length === 0) {
      for (const item of wakes) if (typeof item.id === 'string') ids?.delete(item.id)
      return decision
    }
    ctx.logger.warn(
      `aseldev-teams: refused an unscheduled message to teammate ${workerId} (assignment ${worker.task.id}). `
      + 'Use the Team panel or team_manage so concurrency and path reservations still apply.',
    )
    return { kind: 'reject' }
  })

  // Model-facing tool. Built here, in `apply`, so a rejected schema fails the
  // plugin entry instead of leaving an addon with no usable tool.
  const toolsModule = await fromProfile('@deepseek-ai/dsh-tools')
  const defineTool = toolsModule.defineTool as (definition: unknown) => unknown
  const definition = defineTool({
    name: TEAM_TOOL,
    description: TOOL_DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [...ACTIONS],
        description: 'What to do: "status", "save_specialist", "assign", "message", "cancel", "retry", "configure", or "resume".',
      },
      specialist: {
        type: 'object',
        additionalProperties: false,
        description: 'Required for "save_specialist": the complete role. Saving an existing id replaces it for FUTURE assignments only.',
        properties: {
          id: { type: 'string', required: true, description: 'Lowercase letters, digits and hyphens.' },
          name: { type: 'string', required: true, description: 'Short display name.' },
          mode: { type: 'string', required: true, enum: ['read', 'write'], description: '"read" is restricted to a read-only tool set; "write" may change the workspace.' },
          instructions: { type: 'string', required: true, description: 'What this specialist does and how it reports.' },
        },
      },
      specialistId: { type: 'string', description: 'Required for "assign": the saved specialist taking the assignment.' },
      title: { type: 'string', description: 'Required for "assign": a short human title.' },
      prompt: { type: 'string', description: 'Required for "assign": the complete task. The teammate does not see this conversation.' },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Workspace-relative files or directories this assignment reserves, without globs; "." reserves everything. A write assignment needs at least one.',
      },
      dependsOn: {
        type: 'array',
        items: { type: 'string' },
        description: 'Assignment ids that must be done before this one may start.',
      },
      taskId: { type: 'string', description: 'Required for "cancel", "retry" and "message": the assignment id from status.' },
      message: { type: 'string', description: 'Required for "message": the next turn for an already settled teammate.' },
      maxActive: { type: 'integer', description: 'Required for "configure": how many assignments this conversation may run at once.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: board(value) }],
    },
    async execute(args: Record<string, unknown>, exec: ToolRunLike) {
      const sessionId = exec.agent?.id
      if (typeof sessionId !== 'string') throw new Error('team_manage answers for the conversation that calls it, and this call has no agent')
      if (closing) throw new Error('the teams plugin is stopping')
      let worker: { sessionId: string; task: TaskLike } | null
      try { worker = engine.worker(sessionId) } catch { worker = null }
      if (worker !== null) throw new Error('a team worker cannot manage the team; this tool belongs to the coordinating conversation')
      const action = typeof args.action === 'string' ? args.action : ''
      if (!(ACTIONS as readonly string[]).includes(action)) throw new Error(`unknown team action: ${action}`)
      return engine.action(sessionId, action as ActionName, engineArgs(args))
    },
    presentCall: (args: Record<string, unknown>) => ({
      card: 'generic',
      title: `Manage team: ${typeof args.action === 'string' ? args.action : 'status'}`,
      rawInput: typeof args.title === 'string'
        ? args.title
        : typeof args.taskId === 'string'
          ? args.taskId
          : typeof args.specialistId === 'string' ? args.specialistId : '',
    }),
  })
  ctx.inject(['tools'], (tctx) => {
    tctx.tools.register(definition)
  })

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local')
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[1] !== 'api') throw new HttpError(404, 'unknown teams route')
    assertApiCaller(req)

    if (parts[2] === 'state') {
      if (req.method !== 'GET') throw new HttpError(405, 'state is a GET route')
      send(res, 200, engine.state(requireSessionId(url.searchParams.get('sessionId'))))
      return
    }

    if (parts[2] === 'action') {
      if (req.method !== 'POST') throw new HttpError(405, 'action is a POST route')
      const body = await readJson(req)
      const sessionId = requireSessionId(body.sessionId)
      const action = typeof body.action === 'string' ? body.action : ''
      if (!(ACTIONS as readonly string[]).includes(action)) throw new HttpError(400, `unknown team action: ${action}`)
      if (closing) throw new HttpError(503, 'the teams plugin is stopping')
      try {
        send(res, 200, await engine.action(sessionId, action, engineArgs(body)))
      } catch (error: unknown) {
        throw new HttpError(400, message(error))
      }
      return
    }

    throw new HttpError(404, 'unknown teams route')
  }

  ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/aseldev-teams',
      handler: (req, res) => serve(req, res).catch((error: unknown) => {
        const status = error instanceof HttpError ? error.status : 500
        const text = message(error)
        if (status === 500) ctx.logger.warn(`aseldev-teams: ${text}`)
        if (!res.headersSent) send(res, status, { error: text })
      }),
  }), 'aseldev-teams: http routes')

  // Cordis awaits an async effect disposer, so this teardown is quiescent: the
  // engine closes admission, aborts pending starts, interrupts live workers,
  // waits for them, then marks what it could not stop as blocked.
  ctx.effect(() => () => {
    closing = true
    return engine.dispose()
  }, 'aseldev-teams: store')
}
