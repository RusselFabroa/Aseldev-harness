/**
 * AselDev office, host half — wiring only. `state.mjs` owns the mapping; this
 * file reads the teams store and serves the result.
 *
 *   GET /aseldev-office/api/state?sessionId=<id>   → the office document
 *   GET /aseldev-office/api/sessions               → every conversation with a team
 *
 * The routes answer only this computer, addressed by a local host name, with
 * the `x-aseldev-office: 1` header — a cross-site page cannot send it.
 *
 * The data source is the teams plugin's persisted store (`<dsh home>/teams/state.json`,
 * the file its `TeamEngine` writes), read fresh on every request. This plugin
 * never constructs that engine — doing so would pause every team and mark
 * running assignments blocked — and keeps no copy of team state, so the office
 * cannot drift from the Team panel. Plain subagents are invisible by
 * construction: only assignments a coordinator created through `team_manage` or
 * the Team panel exist in that store.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'aseldev-office'

/** The office needs the shared web server and nothing else. */
export const inject = ['webServer']

/** Plugin config, set from the profile patch (all optional). */
export interface Config {
  /** Folder holding the teams plugin's `state.json`. Default: $DSH_HOME/teams. */
  teamsDir?: string
  /** Boss display name. Default: this conversation's own title, else "You". */
  bossName?: string
  /** Boss subtitle under the name. Default: "Founder & team owner". */
  bossTitle?: string
  /** Project label above the office. Default: "AselDev Harness". */
  projectName?: string
  /** One-line project objective. Default: "Deliver the current conversation's work with the team." */
  projectObjective?: string
  /** Stations (saved specialists) in one document, in roster order. Default: 24. */
  maxAgents?: number
  /** Conversations in one session list, running and most recent kept. Default: 50. */
  maxSessions?: number
}

// ─── the mapping module (state.mjs) ─────────────────────────────────────────

/** The exports `state.mjs` provides; the file is plain ESM beside the bundle. */
interface OfficeStateModule {
  readonly DEFAULT_MAX_AGENTS: number
  readonly DEFAULT_MAX_SESSIONS: number
  resolveBoss(input: { bossName?: string | undefined; bossTitle?: string | undefined; sessionTitle?: string | undefined }): {
    name: string
    title: string
  }
  resolveProject(input: { projectName?: string | undefined; projectObjective?: string | undefined }): {
    name: string
    objective: string
  }
  officeState(input: {
    sessionId: string
    store: unknown
    boss: { name: string; title: string }
    project: { name: string; objective: string }
    now: string
    maxAgents: number
  }): Record<string, unknown>
  officeSessions(input: {
    store: unknown
    currentSessionId?: string | null
    titles?: Record<string, string>
    now: string
    maxSessions: number
  }): Record<string, unknown>
}

// ─── harness surfaces ───────────────────────────────────────────────────────

interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

interface ContextLike {
  readonly webServer: WebServerLike
  /** Optional services: `sessions` and `sessionTitle` name the boss when present. */
  get(name: string): unknown
  effect(fn: () => () => void, label?: string): unknown
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
}

/** The session store, only as much as naming the boss needs. */
interface SessionsLike {
  get(id: string): unknown
}

/** The session-title service: the conversation's own title. */
interface SessionTitleLike {
  get(session: object): { readonly title?: unknown } | undefined
}

// ─── constants ──────────────────────────────────────────────────────────────

/** The routes this plugin owns. */
const STATE_PATH = '/aseldev-office/api/state'
const SESSIONS_PATH = '/aseldev-office/api/sessions'

/**
 * Header naming the conversation asking for the session list. "Current" is only
 * a hint: the client passes the `sessionId` it wants to the state route.
 */
const SESSION_HEADER = 'x-aseldev-office-session'

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

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
  if (!loopback) throw new HttpError(403, 'the office only answers this computer')
  if (!LOCAL_HOSTS.has(hostname(req.headers.host) ?? '')) throw new HttpError(403, 'unexpected Host header')
  const origin = req.headers.origin
  if (origin !== undefined) {
    let originHost: string
    try { originHost = new URL(origin).host } catch { throw new HttpError(403, 'bad Origin header') }
    if (originHost !== req.headers.host) throw new HttpError(403, 'cross-origin request refused')
  }
  if (req.headers['x-aseldev-office'] !== '1') throw new HttpError(403, 'missing x-aseldev-office header')
}

function requireSessionId(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'sessionId is required')
  const id = value.trim()
  if (id === '' || id.length > 200) throw new HttpError(400, 'sessionId must be a non-empty string under 200 characters')
  return id
}

/**
 * The conversation asking, from the header the shell sends. It is a hint for
 * the session selector, so an absent or blank header answers null instead of
 * failing the list.
 * @param req - the incoming request.
 * @returns the session id, or null when the caller named none.
 */
function askingSessionId(req: IncomingMessage): string | null {
  const raw = req.headers[SESSION_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === undefined) return null
  const id = value.trim()
  if (id === '') return null
  if (id.length > 200) throw new HttpError(400, `the ${SESSION_HEADER} header must name a session id under 200 characters`)
  return id
}

function integerInRange(value: unknown, label: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`aseldev-office: ${label} must be an integer from ${min} to ${max}`)
  }
  return value
}

interface Settings {
  /** The teams plugin's store: `<teamsDir>/state.json`. */
  readonly file: string
  readonly bossName: string | undefined
  readonly bossTitle: string | undefined
  readonly projectName: string | undefined
  readonly projectObjective: string | undefined
  readonly maxAgents: number
  readonly maxSessions: number
}

/**
 * Resolve the configured fields.
 * @param config - plugin config from the profile patch.
 * @param defaults - the node caps used when none is configured.
 * @returns the resolved settings.
 */
function readSettings(config: Config, defaults: { maxAgents: number; maxSessions: number }): Settings {
  const dir = resolve(config.teamsDir !== undefined && config.teamsDir.trim() !== ''
    ? config.teamsDir
    : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'teams'))
  return {
    // The teams plugin documents this exact location for its store.
    file: join(dir, 'state.json'),
    bossName: config.bossName,
    bossTitle: config.bossTitle,
    projectName: config.projectName,
    projectObjective: config.projectObjective,
    maxAgents: integerInRange(config.maxAgents, 'maxAgents', defaults.maxAgents, 1, 500),
    maxSessions: integerInRange(config.maxSessions, 'maxSessions', defaults.maxSessions, 1, 500),
  }
}

/**
 * The parsed teams store, or undefined when no team has been saved yet.
 * A store that exists but cannot be read or parsed is an error, never an empty
 * team: a blank office must mean "nothing assigned", not "the store broke".
 * @param file - absolute `state.json` path.
 * @returns the parsed store, or undefined when the file does not exist.
 */
function readStore(file: string): unknown {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error: unknown) {
    // No file yet: nothing has been assigned in this profile.
    if ((error as { readonly code?: unknown }).code === 'ENOENT') return undefined
    throw new Error(`the teams store at ${file} could not be read: ${message(error)}`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    // Any parse failure is reported; the office never shows a wrong empty team.
    throw new Error(`the teams store at ${file} is not valid JSON`)
  }
}

/**
 * This conversation's own title, when the profile composes the services for it.
 * @param ctx - Loader context.
 * @param sessionId - the coordinating conversation.
 * @returns the title, or undefined when no session or title is available.
 */
function sessionTitleOf(ctx: ContextLike, sessionId: string): string | undefined {
  const session = (ctx.get('sessions') as SessionsLike | undefined)?.get(sessionId)
  if (session === undefined || session === null || typeof session !== 'object') return undefined
  const titles = ctx.get('sessionTitle') as SessionTitleLike | undefined
  if (titles === undefined) return undefined
  let snapshot: { readonly title?: unknown } | undefined
  try {
    snapshot = titles.get(session)
  } catch {
    // A session whose log cannot be folded simply has no title yet.
    return undefined
  }
  const title = snapshot?.title
  return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined
}

/**
 * Every titled conversation in the store, resolved once per request from the
 * sessions service. A conversation the service does not know keeps no entry, so
 * the mapping falls back to its id.
 * @param ctx - Loader context.
 * @param store - the parsed teams store.
 * @returns session id to resolved title.
 */
function sessionTitles(ctx: ContextLike, store: unknown): Record<string, string> {
  const titles: Record<string, string> = {}
  if (store === null || typeof store !== 'object') return titles
  const teams = (store as { readonly teams?: unknown }).teams
  if (teams === null || typeof teams !== 'object' || Array.isArray(teams)) return titles
  for (const id of Object.keys(teams)) {
    const title = sessionTitleOf(ctx, id)
    if (title !== undefined) titles[id] = title
  }
  return titles
}

// ─── plugin ─────────────────────────────────────────────────────────────────

/**
 * Serve the office document for this conversation's team and the session list.
 * @param ctx - Loader context.
 * @param config - plugin config from the profile patch.
 */
export async function apply(ctx: ContextLike, config: Config = {}): Promise<void> {
  const state = await import(new URL('./state.mjs', import.meta.url).href) as OfficeStateModule
  const settings = readSettings(config, {
    maxAgents: state.DEFAULT_MAX_AGENTS,
    maxSessions: state.DEFAULT_MAX_SESSIONS,
  })
  // Validate the configured labels now: a bad profile row fails this plugin's
  // entry instead of answering 500 on every panel poll.
  state.resolveBoss({ bossName: settings.bossName, bossTitle: settings.bossTitle })
  state.resolveProject({ projectName: settings.projectName, projectObjective: settings.projectObjective })

  const webServer = ctx.webServer

  async function serveState(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') throw new HttpError(405, 'the office state route is a GET route')
    assertApiCaller(req)
    const url = new URL(req.url ?? '/', 'http://local')
    const sessionId = requireSessionId(url.searchParams.get('sessionId'))
    send(res, 200, state.officeState({
      sessionId,
      store: readStore(settings.file),
      // Resolved per request: a conversation earns its title after the first turn.
      boss: state.resolveBoss({
        bossName: settings.bossName,
        bossTitle: settings.bossTitle,
        sessionTitle: sessionTitleOf(ctx, sessionId),
      }),
      project: state.resolveProject({
        projectName: settings.projectName,
        projectObjective: settings.projectObjective,
      }),
      now: new Date().toISOString(),
      maxAgents: settings.maxAgents,
    }))
  }

  async function serveSessions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') throw new HttpError(405, 'the office sessions route is a GET route')
    assertApiCaller(req)
    const store = readStore(settings.file)
    send(res, 200, state.officeSessions({
      store,
      currentSessionId: askingSessionId(req),
      titles: sessionTitles(ctx, store),
      now: new Date().toISOString(),
      maxSessions: settings.maxSessions,
    }))
  }

  /**
   * Register one route whose failures answer JSON, never a thrown handler.
   * @param path - exact path to serve.
   * @param handler - the route body.
   * @param label - the effect label, for teardown diagnostics.
   */
  function route(
    path: string,
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
    label: string,
  ): void {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path,
      handler: (req, res) => handler(req, res).catch((error: unknown) => {
        const status = error instanceof HttpError ? error.status : 500
        const text = message(error)
        if (status === 500) ctx.logger.warn(`aseldev-office: ${text}`)
        if (!res.headersSent) send(res, status, { error: text })
      }),
    }), label)
  }

  route(STATE_PATH, serveState, 'aseldev-office: state route')
  route(SESSIONS_PATH, serveSessions, 'aseldev-office: sessions route')

  ctx.logger.info(`aseldev-office: ${STATE_PATH}, ${SESSIONS_PATH} (teams store ${settings.file}, at most ${settings.maxAgents} agents, ${settings.maxSessions} sessions)`)
}
