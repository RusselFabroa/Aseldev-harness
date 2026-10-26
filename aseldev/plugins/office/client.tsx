/**
 * AselDev AI HQ office panel, browser half.
 *
 * One `sidebar.launcher` entry that opens a large fixed overlay: the isometric
 * office from `./scene` — one station per saved specialist of this
 * conversation's roster — and a detail modal listing that specialist's jobs,
 * running and done. The sidebar column is far too narrow for the scene, which
 * is why the panel is a viewport-level overlay rather than a popover anchored
 * to the launcher.
 *
 * The panel reads one coordinator session through the host plugin's JSON API
 * (`GET /aseldev-office/api/state?sessionId=…`) every {@link POLL_MS}. The
 * request carries the `x-aseldev-office: 1` header the host requires and stays
 * same-origin; a cross-site page cannot send that header without a CORS
 * preflight this route never approves.
 *
 * The header's session selector chooses which conversation's office is drawn,
 * and `GET /aseldev-office/api/sessions` (every {@link SESSIONS_POLL_MS}) fills
 * its options. The two routes are polled by separate chains, so a failed
 * session list keeps the last options and never interrupts the office itself.
 *
 * A job row in the detail modal is the way into that job's own conversation:
 * the host sends the worker session id, which goes straight to the injected
 * `sessions.open` navigation, and a refusal falls back to the teams panel's
 * worker path (load the coordinator's child catalog, then open the child
 * through its parent address). The overlay steps aside once either path lands;
 * a refusal of both is reported in the same header chip and never thrown at the
 * shell.
 *
 * A failed poll keeps the last good snapshot and names the failure in the
 * header (the host answers `{ error }` for a corrupt teams store or a refused
 * header): the office is a read-only view of assignment state, so
 * stale-but-labelled beats a blank panel, and nothing here throws into the shell.
 *
 * Copy is localised through the shell's locale service (`aseldev.office`
 * namespace, zh + en). The exported helpers exist so the test harness can
 * exercise the shipped artifact without the shell; the supported surface is
 * `apply` + `inject`.
 *
 * `OFFICE_CSS` is the text of `office.css`, which the panel injects as one
 * `<style>` element on open: a tsdown browser bundle in this package family
 * cannot import a `.css` file (no `@tsdown/css`), and the shell's module system
 * attributes factory-injected style tags to the plugin. `client.test.mjs`
 * fails when the two copies drift apart.
 *
 * Deliberately dependency-free apart from `react`: no repo imports, no CSS
 * modules, no network library.
 */

import * as React from 'react'
import {
  JOB_STATUS, OfficeScene, TeammatePortrait, isEmptyOffice, jobStatusOf, statusMeta,
  type OfficeAgent, type OfficeJob, type OfficeJobStatus, type OfficeStatus,
} from './scene'

// Shipped-artifact surface for `client.test.mjs`; the parts `apply` re-exports
// are the pure helpers the test asserts, not a supported business API.
export {
  GLOW, HEAD_TOP_Z, JOB_STATUS, MONITOR_TOP_Z, PLATE_ANCHOR_Y, PLATE_ANCHOR_Z, PLATE_BOTTOM_Z,
  PLATE_HEIGHT, STATUS, statusMeta, calculateLayout, stationSlots, isEmptyOffice, jobStatusOf,
} from './scene'
export type {
  OfficeAgent, OfficeJob, OfficeJobStatus, OfficeSceneState, OfficeStatus, StationSlot,
} from './scene'

/** Host route root owned by `host.ts`. */
const ENDPOINT = '/aseldev-office/api'

/** Custom header the host route requires on every request. */
const TRUST_HEADER = 'x-aseldev-office'

/** Header naming the conversation asking for the session list, so the host can say which is current. */
const SESSION_HEADER = 'x-aseldev-office-session'

/** Poll period while the panel is open (milliseconds). */
const POLL_MS = 2000

/** The session list changes with the conversation, not with every assignment. */
const SESSIONS_POLL_MS = 10_000

/** Zoom range of the viewport slider, as a percentage of the fit scale. */
const ZOOM_MIN = 70
const ZOOM_MAX = 250

/** Locale namespace owned by this plugin. */
export const OFFICE_NS = 'aseldev.office'

// ------------------------------------------------------------------- locale

/** Translate one key with optional `{name}` template params. */
export type Translate = (key: string, params?: Record<string, unknown>) => string

/** Chinese copy (the deployment's product language; also the fallback). */
export const zh = {
  'brand.name': 'ASELDEV AI HQ',
  'brand.tagline': '你的方向 · 你的团队 · 你的办公室',
  'launcher.label': '办公室',
  'launcher.aria': 'AI 办公室：团队工位全景',
  'panel.title': 'AI 总部',
  'panel.close': '关闭办公室',
  'panel.subtitle': '01 层 · {title}',
  'select.label': '会话',
  'select.this': '（本会话）',
  'select.option': '{title} — {working} 位工作中',
  'select.running': '运行中',
  'metric.teammates': '队友',
  'metric.working': '工作中',
  'metric.needs': '需要你',
  'hint.view': '选择工位 · 拖动探索',
  'state.loading': '正在连接办公室…',
  'state.unavailable': '办公室不可用',
  'empty.agents': '还没有团队任务——给队友分配工作后就会出现在这里',
  'control.zoom': '缩放',
  'control.fit': '适配',
  'control.labels': '标签',
  'control.lines': '汇报线',
  'control.motion': '动画',
  'control.desk': '你的工位',
  'status.working': '工作中',
  'status.review': '等待你审批',
  'status.blocked': '受阻',
  'status.queued': '排队中',
  'status.idle': '空闲',
  'status.done': '已完成',
  'status.offline': '离线',
  'status.running': '运行中',
  'status.failed': '失败',
  'modal.close': '关闭详情',
  'modal.jobs': '任务',
  'modal.noJobs': '本会话暂无任务',
  'job.open': '打开会话',
  'modal.progress': '进度',
  'modal.reportsTo': '汇报给',
  'modal.started': '开始',
  'modal.updated': '更新',
  'modal.you': '你',
  'modal.deskChip': '人类 · 指挥中',
  'modal.summary': '团队概况',
  'modal.summaryLine': '{teammates} 位队友 · {working} 位工作中 · {needs} 位需要你',
  'modal.project': '项目',
  'modal.objective': '目标',
  'modal.pending': '等待分配',
}

/** English copy. */
export const en: Record<keyof typeof zh, string> = {
  'brand.name': 'ASELDEV AI HQ',
  'brand.tagline': 'Your direction. Your team. Your office.',
  'launcher.label': 'Office',
  'launcher.aria': 'AI office: team floor plan',
  'panel.title': 'AI HQ',
  'panel.close': 'Close the office',
  'panel.subtitle': 'Floor 01 · {title}',
  'select.label': 'Session',
  'select.this': '(this session)',
  'select.option': '{title} — {working} working',
  'select.running': 'running',
  'metric.teammates': 'Teammates',
  'metric.working': 'Working',
  'metric.needs': 'Needs you',
  'hint.view': 'Select a station · drag to explore',
  'state.loading': 'Connecting to the office…',
  'state.unavailable': 'Office unavailable',
  'empty.agents': 'No team assignments yet — assign work to a teammate to see them here',
  'control.zoom': 'Zoom',
  'control.fit': 'Fit',
  'control.labels': 'Labels',
  'control.lines': 'Reporting lines',
  'control.motion': 'Motion',
  'control.desk': 'Your desk',
  'status.working': 'Working',
  'status.review': 'Needs your approval',
  'status.blocked': 'Blocked',
  'status.queued': 'Queued',
  'status.idle': 'Idle',
  'status.done': 'Done',
  'status.offline': 'Offline',
  'status.running': 'Running',
  'status.failed': 'Failed',
  'modal.close': 'Close teammate details',
  'modal.jobs': 'Jobs',
  'modal.noJobs': 'No assignments in this session',
  'job.open': 'open conversation',
  'modal.progress': 'Progress',
  'modal.reportsTo': 'Reports to',
  'modal.started': 'Started',
  'modal.updated': 'Updated',
  'modal.you': 'You',
  'modal.deskChip': 'Human · in command',
  'modal.summary': 'Team summary',
  'modal.summaryLine': '{teammates} teammates · {working} working · {needs} need you',
  'modal.project': 'Project',
  'modal.objective': 'Objective',
  'modal.pending': 'Waiting for an assignment.',
}

/**
 * Fill `{name}` placeholders from `params`.
 * @param dictionary - the active copy table.
 * @param key - locale key; an unknown key renders as itself.
 * @param params - template values.
 * @returns the translated text.
 */
function translateFrom(dictionary: Record<string, string>, key: string, params?: Record<string, unknown>): string {
  const template = dictionary[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}

/** Chinese translate function, used when the shell provides no locale seat. */
export const zhTranslate: Translate = (key, params) => translateFrom(zh, key, params)

/**
 * Localised label for a status from the wire: a status this build does not
 * know falls back to its scene label instead of rendering the raw key.
 * @param t - active translate function.
 * @param status - raw status value.
 * @returns the reader-facing label.
 */
export function statusText(t: Translate, status: string): string {
  const key = `status.${status}`
  const label = t(key)
  return label === key ? statusMeta(status).label : label
}

// ---------------------------------------------------------------- data model

/** One coordinator's live office state as the host reports it. */
export interface OfficeState {
  readonly sessionId: string
  readonly updatedAt: string
  readonly boss: { readonly name: string; readonly title: string }
  readonly project: { readonly name: string; readonly objective: string }
  readonly agents: readonly OfficeAgent[]
}

/** One row of the host's session list. */
export interface OfficeSession {
  readonly id: string
  /** The conversation title as the host resolved it; empty when it has none yet. */
  readonly title: string
  readonly working: number
  readonly running: boolean
}

/** The session selector's source: this conversation plus the host's own list. */
export interface SessionList {
  readonly currentSessionId: string | null
  readonly sessions: readonly OfficeSession[]
}

/** The two calls the panel makes. */
export interface OfficeApi {
  /**
   * Read the current office state.
   * @param sessionId - the coordinator conversation to scope the answer to.
   * @param signal - aborts the request when the panel closes.
   * @returns the parsed state; rejects on transport or shape failure.
   */
  state: (sessionId: string, signal: AbortSignal) => Promise<OfficeState>
  /**
   * Read the sessions the selector offers.
   * @param currentSessionId - this conversation's id, which the host marks as current.
   * @param signal - aborts the request when the panel closes.
   * @returns the parsed list; rejects on transport or shape failure.
   */
  sessions: (currentSessionId: string | null, signal: AbortSignal) => Promise<SessionList>
}

// ------------------------------------------------------------ wire boundary

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOf(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function optionalTextOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function timestampOf(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  return null
}

function statusOf(value: unknown): OfficeStatus {
  return typeof value === 'string' && Object.hasOwn(statusMetaTable, value) ? value as OfficeStatus : 'idle'
}

const statusMetaTable: Record<OfficeStatus, true> = {
  working: true, review: true, blocked: true, queued: true, idle: true, done: true, offline: true,
}

function percentOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

/**
 * Read one job row, or null when it carries no usable identity. Jobs are what
 * many-per-specialist; an unknown status folds to {@link jobStatusOf}'s safe
 * default instead of dropping the job.
 */
function parseJob(value: unknown): OfficeJob | null {
  if (!isRecord(value)) return null
  const id = optionalTextOf(value['id'])
  if (id === null) return null
  return {
    id,
    title: textOf(value['title'], ''),
    status: jobStatusOf(value['status']),
    progress: percentOf(value['progress']),
    startedAt: timestampOf(value['startedAt']),
    updatedAt: timestampOf(value['updatedAt']),
  }
}

/** Newest first: latest update, then latest start, then id so ties are stable. */
function newestFirst(a: OfficeJob, b: OfficeJob): number {
  const left = a.updatedAt ?? a.startedAt ?? ''
  const right = b.updatedAt ?? b.startedAt ?? ''
  if (left === right) return a.id.localeCompare(b.id)
  return left < right ? 1 : -1
}

/** A specialist's jobs, newest first; a missing or unreadable list is no jobs. */
function jobsOf(value: unknown): readonly OfficeJob[] {
  if (!Array.isArray(value)) return []
  return value.map(parseJob).filter((job): job is OfficeJob => job !== null).sort(newestFirst)
}

/**
 * Read one agent row — one saved specialist of the roster, carrying its jobs —
 * or null when it has no usable identity. A host that adds fields or a status
 * this build does not know still renders: the extra fields are ignored and an
 * unknown status falls back to idle.
 */
function parseAgent(value: unknown): OfficeAgent | null {
  if (!isRecord(value)) return null
  const id = optionalTextOf(value['id'])
  if (id === null) return null
  return {
    id,
    name: textOf(value['name'], id),
    role: textOf(value['role'], 'general'),
    title: textOf(value['title'], ''),
    status: statusOf(value['status']),
    progress: percentOf(value['progress']),
    managerId: textOf(value['managerId'], 'boss'),
    accent: textOf(value['accent'], ''),
    specialist: optionalTextOf(value['specialist']),
    jobs: jobsOf(value['jobs']),
  }
}

/**
 * Narrow one `state` answer. A missing session, boss, or agent array is a
 * contract failure, not an empty office: it throws so the panel keeps its last
 * good snapshot instead of claiming the team is gone.
 * @param value - parsed JSON body.
 * @returns the office state.
 */
export function parseState(value: unknown): OfficeState {
  if (!isRecord(value)) throw new Error('state: expected an object')
  const agentsRaw = value['agents']
  if (!Array.isArray(agentsRaw)) throw new Error('state.agents: expected an array')
  const bossRaw = isRecord(value['boss']) ? value['boss'] : {}
  const projectRaw = isRecord(value['project']) ? value['project'] : {}

  return {
    sessionId: textOf(value['sessionId'], ''),
    updatedAt: timestampOf(value['updatedAt']) ?? '',
    boss: {
      name: textOf(bossRaw['name'], ''),
      title: textOf(bossRaw['title'], ''),
    },
    project: {
      name: textOf(projectRaw['name'], ''),
      objective: textOf(projectRaw['objective'], ''),
    },
    agents: agentsRaw.map(parseAgent).filter((agent): agent is OfficeAgent => agent !== null),
  }
}

function countOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.round(value))
}

/** One session row, or null when it carries no usable identity. */
function parseSession(value: unknown): OfficeSession | null {
  if (!isRecord(value)) return null
  const id = optionalTextOf(value['id'])
  if (id === null) return null
  return {
    id,
    title: textOf(value['title'], ''),
    working: countOf(value['working']),
    running: value['running'] === true,
  }
}

/**
 * Narrow one `sessions` answer. The host owns the running-first order and the
 * cap, so the list is kept as sent; a missing list throws so the panel keeps
 * its last good options instead of claiming no session exists.
 * @param value - parsed JSON body.
 * @returns the session list.
 */
export function parseSessions(value: unknown): SessionList {
  if (!isRecord(value)) throw new Error('sessions: expected an object')
  const rowsRaw = value['sessions']
  if (!Array.isArray(rowsRaw)) throw new Error('sessions.sessions: expected an array')
  return {
    currentSessionId: optionalTextOf(value['currentSessionId']),
    sessions: rowsRaw.map(parseSession).filter((session): session is OfficeSession => session !== null),
  }
}

// ---------------------------------------------------------------- transport

/** Error text for any thrown value. */
export function errorText(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return 'state request failed'
}

/** Whether a rejection is the panel's own cancellation. */
export function isCanceled(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * The reason a host route refused a request. The host answers `{ error }` with
 * its own reason (a corrupt teams store, a refused header); that text is what
 * the status chip shows.
 * @param response - the non-ok response.
 * @param route - route name used when the body carries no reason.
 * @returns the reader-facing failure text.
 */
async function failureText(response: Response, route: string): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined)
  const reason = isRecord(body) ? optionalTextOf(body['error']) : null
  return reason ?? `${route} request failed: ${String(response.status)}`
}

/**
 * Build the panel's host client. Same-origin JSON only; the trusted header and
 * `sessionId` query are what the host route checks.
 * @returns the client the launcher polls through.
 */
export function createOfficeApi(): OfficeApi {
  return {
    async state(sessionId, signal) {
      const response = await fetch(`${ENDPOINT}/state?sessionId=${encodeURIComponent(sessionId)}`, {
        method: 'GET',
        headers: { [TRUST_HEADER]: '1' },
        credentials: 'same-origin',
        signal,
      })
      if (!response.ok) throw new Error(await failureText(response, 'state'))
      return parseState(await response.json())
    },
    async sessions(currentSessionId, signal) {
      const response = await fetch(`${ENDPOINT}/sessions`, {
        method: 'GET',
        headers: currentSessionId === null
          ? { [TRUST_HEADER]: '1' }
          : { [TRUST_HEADER]: '1', [SESSION_HEADER]: currentSessionId },
        credentials: 'same-origin',
        signal,
      })
      if (!response.ok) throw new Error(await failureText(response, 'sessions'))
      return parseSessions(await response.json())
    },
  }
}

// -------------------------------------------------------------- derivations

/** Counts for the three header metrics. */
export interface OfficeStats {
  readonly teammates: number
  readonly working: number
  readonly needs: number
}

/** Counts a null state as an empty team, so the header renders before the first poll. */
export function statsOf(state: { readonly agents: readonly OfficeAgent[] } | null): OfficeStats {
  const agents = state?.agents ?? []
  return {
    teammates: agents.length,
    working: agents.filter(agent => agent.status === 'working').length,
    needs: agents.filter(agent => agent.status === 'review' || agent.status === 'blocked').length,
  }
}

/**
 * Whether two answers draw the same office. The host stamps a fresh
 * `updatedAt` on every answer, so comparing whole documents would repaint the
 * ~1.2k-node scene every poll; the scene, the subtitle, and the modal read only
 * the session id, the cards, and the agents (whose own timestamps stay in the
 * comparison).
 * @param a - the retained snapshot, or null before the first answer.
 * @param b - the answer just read.
 * @returns true when nothing the panel draws changed.
 */
export function sameScene(a: OfficeState | null, b: OfficeState): boolean {
  if (a === null) return false
  return sceneKey(a) === sceneKey(b)
}

function sceneKey(state: OfficeState): string {
  // Two sessions can hold the same team; the subtitle still names the one on
  // screen, so the id belongs in the comparison.
  return JSON.stringify({ sessionId: state.sessionId, boss: state.boss, project: state.project, agents: state.agents })
}

/**
 * Local time for a host timestamp, in the reader's own zone.
 * @param value - ISO timestamp or null.
 * @returns a short local stamp, or an em dash when absent or unparseable.
 */
export function formatLocal(value: string | null): string {
  if (value === null) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * The window one specialist's work covers: its earliest start and its latest
 * update. The modal's two stamp rows read this instead of one job's stamps.
 * @param jobs - that specialist's jobs.
 * @returns both stamps, or null when no job carries one.
 */
export function jobSpan(jobs: readonly OfficeJob[]): { readonly startedAt: string | null; readonly updatedAt: string | null } {
  let startedAt: string | null = null
  let updatedAt: string | null = null
  for (const job of jobs) {
    if (job.startedAt !== null && (startedAt === null || job.startedAt < startedAt)) startedAt = job.startedAt
    if (job.updatedAt !== null && (updatedAt === null || job.updatedAt > updatedAt)) updatedAt = job.updatedAt
  }
  return { startedAt, updatedAt }
}

/** Count header of the modal's job list, e.g. "2 running · 5 done". */
export function jobCounts(jobs: readonly OfficeJob[], t: Translate): string {
  const order: readonly OfficeJobStatus[] = ['running', 'done', 'queued', 'failed', 'blocked']
  return order
    // Job states are single words in both shipped locales, so the count line
    // can lower-case the chip label.
    .map(status => ({ status, count: jobs.filter(job => job.status === status).length }))
    .filter(entry => entry.count > 0)
    .map(entry => `${String(entry.count)} ${t(`status.${entry.status}`).toLowerCase()}`)
    .join(' · ')
}

// ---------------------------------------------------------- session selector

/** One localised option of the session selector. */
export interface SessionOption {
  readonly value: string
  readonly label: string
}

/**
 * Options of the session selector: `(this session)` bound to this
 * conversation first, then every other session in the host's own order
 * (running sessions grouped first, list capped by the host). A session whose
 * title is empty shows its id, and a running one says so.
 * @param list - the last good sessions answer, or null before the first one.
 * @param thisSessionId - this conversation's id, as the shell or the host knows it.
 * @param t - active translate function.
 * @returns the option list, already localised.
 */
export function sessionOptions(list: SessionList | null, thisSessionId: string | null, t: Translate): SessionOption[] {
  const options: SessionOption[] = thisSessionId === null
    ? []
    : [{ value: thisSessionId, label: t('select.this') }]
  for (const session of list?.sessions ?? []) {
    if (session.id === thisSessionId) continue
    const title = session.title === '' ? session.id : session.title
    const label = t('select.option', { title, working: session.working })
    options.push({ value: session.id, label: session.running ? `${label} · ${t('select.running')}` : label })
  }
  return options
}

/**
 * The title the panel subtitle shows for the session on screen.
 * @param list - the last good sessions answer, or null before the first one.
 * @param sessionId - the session id the drawn snapshot belongs to.
 * @returns the title, the id when the host gave none, or null when unknown.
 */
export function sessionTitle(list: SessionList | null, sessionId: string): string | null {
  if (list === null || sessionId === '') return null
  const session = list.sessions.find(entry => entry.id === sessionId)
  return session === undefined || session.title === '' ? sessionId : session.title
}

// ------------------------------------------------------------------- control

/** Camera and toggle state of the viewport. */
export interface CameraState {
  readonly zoom: number
  readonly pan: { readonly x: number; readonly y: number }
  readonly labels: boolean
  readonly links: boolean
  readonly motion: boolean
}

/** Which teammate the detail modal is showing; `boss` is the command desk. */
export type ModalTarget = { readonly kind: 'boss' } | { readonly kind: 'agent'; readonly id: string }

/** Whether the reader asked the platform for reduced motion. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// ---------------------------------------------------------------- components

/**
 * Launcher chrome matching the other sidebar entries; inline styles cannot
 * express hover/focus. These are the only global selectors this plugin ships,
 * and they carry the `.aseldev-office-launch` allowlisted prefix.
 */
export const LAUNCHER_CSS = `
.aseldev-office-launch { transition: background .15s, border-color .15s; }
.aseldev-office-launch:hover { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12)); }
.aseldev-office-launch:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #37bfff); outline-offset: 2px; }
`

const LAUNCH_SECTION: React.CSSProperties = {
  // The launcher shares the sidebar's regionArea with the other entries, which
  // reserve the column's inline inset on their own wrapper; ours must too.
  flex: 'none', display: 'flex', flexDirection: 'column', position: 'relative',
  paddingRight: 'var(--dsh-sidebar-inline-padding)', marginBottom: 8,
}
const LAUNCH_SECTION_RAIL: React.CSSProperties = { alignItems: 'center', paddingRight: 0 }
const LAUNCH_BUTTON: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', font: 'inherit',
  border: '1px solid var(--dsw-alias-border-l2, #e5e5e5)',
  background: 'var(--dsw-alias-bg-module-platform, transparent)',
  color: 'var(--dsw-alias-label-primary, currentColor)',
}
const LAUNCH_BUTTON_WIDE: React.CSSProperties = { width: '100%', height: 36, padding: '0 12px', borderRadius: 10, fontSize: 14, fontWeight: 500 }
const LAUNCH_BUTTON_RAIL: React.CSSProperties = { justifyContent: 'center', width: 36, height: 36, padding: 0, borderRadius: 10 }
const LAUNCH_MARK: React.CSSProperties = {
  display: 'grid', flex: 'none', placeItems: 'center', width: 18, height: 18, borderRadius: 5,
  background: 'var(--dsw-alias-state-business-tertiary, rgba(55,191,255,0.18))',
}
const LAUNCH_LABEL: React.CSSProperties = {
  flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', textAlign: 'left',
}
const LAUNCH_COUNT: React.CSSProperties = {
  flex: 'none', minWidth: 20, padding: '0 6px', borderRadius: 10, fontSize: 11, fontWeight: 600,
  lineHeight: '18px', textAlign: 'center',
  background: 'var(--dsw-alias-state-business-tertiary, rgba(127,127,127,0.16))',
  color: 'var(--dsw-alias-label-primary-bluish, inherit)',
}

/** The office "A" mark; drawn inline so the bundle needs no asset. */
function BrandMark(props: { size: number }): React.ReactElement {
  return (
    <svg viewBox="0 0 28 28" width={props.size} height={props.size} aria-hidden="true" focusable="false">
      <path d="M3 24 12 4h5l8 20h-6l-5-13-5 13Z" fill="#37bfff" />
      <path d="M10 18h9v4h-9z" fill="#b6e7ff" />
    </svg>
  )
}

/** Props the `sidebar.launcher` slot delivers plus the injected business face. */
export interface OfficeInjected {
  readonly api: OfficeApi
  /**
   * Open one job's conversation. A job id is usually a worker session the
   * runtime neither lists nor addresses yet, so this tries the plain open and
   * then the worker path below the coordinator. Rejects only when both fail,
   * which the panel reports in its chip.
   * @param jobId - the job id, which the host sends as the worker session id.
   * @param parentSessionId - the coordinator session whose office is on screen.
   */
  readonly openConversation: (jobId: string, parentSessionId: string) => Promise<void>
}

/** Props delivered by the `sidebar.launcher` slot. */
export interface OfficeLauncherProps extends OfficeInjected {
  readonly wide: boolean
  readonly useSessions: (selector: (state: unknown) => unknown) => unknown
  /** Framework-injected translate seat; absent when rendered without the locale face. */
  readonly t?: Translate
}

/** The slice of the client session-list snapshot this panel reads. */
interface SessionListLocal {
  current: string | undefined
}

/** Props of the overlay panel itself, so a harness can render it without the shell. */
export interface OfficePanelProps {
  readonly state: OfficeState | null
  /** The last poll failed; the reason the host (or the transport) gave. */
  readonly error: string | null
  /** The last good sessions answer, source of the selector's options. */
  readonly sessions: SessionList | null
  /** The session the panel is polling; null while none is known. */
  readonly polledId: string | null
  readonly selectedId: string | null
  readonly target: ModalTarget | null
  readonly camera: CameraState
  readonly t: Translate
  readonly panelRef: React.RefObject<HTMLDivElement>
  readonly onClose: () => void
  readonly onSelect: (id: string) => void
  readonly onSelectSession: (id: string) => void
  readonly onCloseModal: () => void
  /** Open one job's conversation from its row in the detail modal. */
  readonly onOpenJob: (jobId: string) => void
  readonly onCamera: (next: Partial<CameraState>) => void
  readonly onFit: () => void
}

/**
 * One specialist's details, or the owner's command desk. A specialist's row
 * lists every job it holds in this session, each one a button that opens that
 * job's own conversation; the stamps below the rows span that whole workload.
 * Native `<dialog>` gives Escape handling, the backdrop, and the focus trap; the
 * caller restores focus to the station that opened it.
 */
function TeammateModal(props: {
  readonly agent: OfficeAgent | null
  readonly state: OfficeState
  readonly t: Translate
  readonly onClose: () => void
  /** Open one job's conversation; the caller closes this view and navigates. */
  readonly onOpenJob: (jobId: string) => void
}): React.ReactElement {
  const { agent, state, t, onClose, onOpenJob } = props
  const dialogRef = React.useRef<HTMLDialogElement>(null)

  React.useEffect(() => {
    // React 18 types a ref's `current` as non-null; the DOM node can still be gone.
    const dialog: HTMLDialogElement | null = dialogRef.current
    if (dialog === null || dialog.open) return
    dialog.showModal()
    return () => { if (dialog.open) dialog.close() }
  }, [])

  const stats = statsOf(state)
  const meta = agent === null ? null : statusMeta(agent.status)
  const chipColor = meta?.color ?? '#ffcb85'
  const chipLabel = agent === null ? t('modal.deskChip') : statusText(t, agent.status)
  const manager = agent === null || agent.managerId === 'boss'
    ? null
    : state.agents.find(candidate => candidate.id === agent.managerId) ?? null
  const reportsTo = agent === null
    ? ''
    : agent.managerId === 'boss'
      ? (state.boss.name === '' ? t('modal.you') : state.boss.name)
      : (manager === null ? t('modal.you') : `${manager.name} · ${manager.title !== '' ? manager.title : manager.specialist ?? ''}`)
  const span = agent === null ? { startedAt: null, updatedAt: null } : jobSpan(agent.jobs)

  return (
    <dialog
      ref={dialogRef}
      className="office-modal"
      aria-labelledby="office-modal-title"
      onCancel={event => { event.preventDefault(); onClose() }}
      onClick={event => {
        // The dialog's own box includes its padding, so compare coordinates
        // instead of relying on the click target to identify the backdrop.
        const dialog: HTMLDialogElement | null = dialogRef.current
        if (dialog === null) return
        const rect = dialog.getBoundingClientRect()
        const outside = event.clientX < rect.left || event.clientX > rect.right
          || event.clientY < rect.top || event.clientY > rect.bottom
        if (outside) onClose()
      }}
    >
      <div className="office-modal-id">
        <span className="office-portrait-frame">
          <TeammatePortrait agent={agent} />
        </span>
        <div className="office-modal-copy">
          <h2 id="office-modal-title">{agent === null ? state.boss.name : agent.name}</h2>
          <p className="office-modal-role">
            {agent === null ? state.boss.title : (agent.title !== '' ? agent.title : agent.specialist ?? '')}
          </p>
          <span className="office-chip" style={{ color: chipColor }}>{chipLabel}</span>
        </div>
        <button type="button" className="office-btn office-close office-modal-close" aria-label={t('modal.close')} onClick={onClose}>
          ✕
        </button>
      </div>

      <dl className="office-rows">
        {agent === null ? (
          <>
            <div className="office-row">
              <dt>{t('modal.summary')}</dt>
              <dd>{t('modal.summaryLine', { teammates: stats.teammates, working: stats.working, needs: stats.needs })}</dd>
            </div>
            <div className="office-row">
              <dt>{t('modal.project')}</dt>
              <dd>{state.project.name === '' ? t('modal.pending') : state.project.name}</dd>
            </div>
            <div className="office-row">
              <dt>{t('modal.objective')}</dt>
              <dd>{state.project.objective === '' ? t('modal.pending') : state.project.objective}</dd>
            </div>
          </>
        ) : (
          <>
            <div className="office-row">
              <dt>{t('modal.jobs')}</dt>
              <dd>
                {agent.jobs.length === 0 ? (
                  // One station means one specialist: an idle roster entry has
                  // no work in this session, and says so instead of a blank row.
                  <p className="office-job-empty">{t('modal.noJobs')}</p>
                ) : (
                  <>
                    <p className="office-job-count">{jobCounts(agent.jobs, t)}</p>
                    <ul className="office-jobs" role="list">
                      {agent.jobs.map(job => {
                        const info = JOB_STATUS[job.status]
                        // A job the host never titled still names itself.
                        const title = job.title === '' ? job.id : job.title
                        const open = (): void => { onOpenJob(job.id) }
                        return (
                          <li key={job.id}>
                            <button
                              type="button"
                              className="office-job"
                              data-status={job.status}
                              aria-label={`${title}, ${statusText(t, job.status)}, ${t('job.open')}`}
                              onClick={open}
                              onKeyDown={event => {
                                // A real button already activates on Enter/Space;
                                // doing it here keeps one navigation per press
                                // (the preventDefault suppresses the click).
                                if (event.key !== 'Enter' && event.key !== ' ') return
                                event.preventDefault()
                                open()
                              }}
                            >
                              <span className="office-job-head">
                                <span className="office-chip office-job-chip" style={{ color: info.color }}>
                                  {statusText(t, job.status)}
                                </span>
                                <span className="office-job-pct">{`${String(job.progress)}%`}</span>
                                <span className="office-job-go" aria-hidden="true">›</span>
                              </span>
                              <span className="office-job-title">{title}</span>
                              <span
                                className="office-track"
                                role="progressbar"
                                aria-label={`${title} — ${t('modal.progress')}`}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={job.progress}
                              >
                                <span style={{ width: `${String(job.progress)}%`, background: info.color }} />
                              </span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </>
                )}
              </dd>
            </div>
            <div className="office-row">
              <dt>{t('modal.progress')}</dt>
              <dd>
                <div className="office-progress-meta">
                  <span>{t('modal.progress')}</span>
                  <span>{`${String(agent.progress)}%`}</span>
                </div>
                <div
                  className="office-track"
                  role="progressbar"
                  aria-label={t('modal.progress')}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={agent.progress}
                >
                  <span style={{ width: `${String(agent.progress)}%`, background: chipColor }} />
                </div>
              </dd>
            </div>
            <div className="office-row">
              <dt>{t('modal.reportsTo')}</dt>
              <dd>{reportsTo}</dd>
            </div>
          </>
        )}
      </dl>

      {agent === null ? null : (
        <p className="office-meta">
          <span>{`${t('modal.started')} ${formatLocal(span.startedAt)}`}</span>
          <span>{`${t('modal.updated')} ${formatLocal(span.updatedAt)}`}</span>
        </p>
      )}
    </dialog>
  )
}

/**
 * The office overlay: brand header with the session selector, the connection
 * status, three metrics, the scene viewport with its controls, and the
 * teammate modal.
 * @param props - the snapshot, last failure, sessions, selection, camera, and callbacks.
 * @returns the fixed overlay.
 */
export function OfficePanel(props: OfficePanelProps): React.ReactElement {
  const { state, error, sessions, polledId, selectedId, target, camera, t, panelRef, onClose, onSelect, onSelectSession, onCloseModal, onOpenJob, onCamera, onFit } = props
  const stats = statsOf(state)
  const empty = isEmptyOffice(state)
  const selectedAgent = state === null || target === null || target.kind === 'boss'
    ? null
    : state.agents.find(agent => agent.id === target.id) ?? null
  const unavailable = error === null ? null : `${t('state.unavailable')} — ${error}`
  const options = sessionOptions(sessions, sessions?.currentSessionId ?? polledId, t)
  // A controlled select with a value no option carries renders blank; the
  // fallback window is the moment a selected session has just disappeared.
  const optionValue = options.some(option => option.value === polledId) ? polledId ?? '' : options[0]?.value ?? ''
  // The subtitle names the session the drawn snapshot belongs to, so it stays
  // truthful while a newly picked session's first answer is in flight.
  const shownTitle = state === null ? null : sessionTitle(sessions, state.sessionId)

  return (
    <div
      className="aseldev-office"
      data-motion={camera.motion ? 'on' : 'off'}
      onClick={event => { if (event.target === event.currentTarget) onClose() }}
    >
      <style>{OFFICE_CSS}</style>
      <div className="office-panel" role="dialog" aria-label={t('panel.title')} ref={panelRef}>
        <header className="office-head">
          <div className="office-brand">
            <span className="office-brand-mark" aria-hidden="true"><BrandMark size={20} /></span>
            <span className="office-brand-copy">
              <strong>{t('brand.name')}</strong>
              <small>{shownTitle === null ? t('brand.tagline') : t('panel.subtitle', { title: shownTitle })}</small>
            </span>
          </div>
          {options.length > 0 && (
            <label className="office-session">
              <span>{t('select.label')}</span>
              <select className="office-select" value={optionValue} onChange={event => { onSelectSession(event.target.value) }}>
                {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          )}
          <div className="office-metrics">
            <div className="office-metric"><strong>{stats.teammates}</strong><span>{t('metric.teammates')}</span></div>
            <div className="office-metric"><strong>{stats.working}</strong><span>{t('metric.working')}</span></div>
            <div className="office-metric office-metric-needs"><strong>{stats.needs}</strong><span>{t('metric.needs')}</span></div>
          </div>
          {unavailable !== null && (
            <span className="office-live office-live-error" role="status" title={error ?? undefined}>
              <i aria-hidden="true" />
              {unavailable}
            </span>
          )}
          <button type="button" className="office-btn office-close" aria-label={t('panel.close')} onClick={onClose}>✕</button>
        </header>

        <div className="office-stage">
          {state !== null && (
            <OfficeScene
              state={state}
              zoom={camera.zoom}
              pan={camera.pan}
              showLabels={camera.labels}
              showLinks={camera.links}
              selectedId={selectedId}
              statusLabel={status => statusText(t, status)}
              onSelect={onSelect}
              onPan={pan => { onCamera({ pan }) }}
            />
          )}
          {state === null && (
            <p className="office-empty" role="status">
              <span>{unavailable ?? t('state.loading')}</span>
            </p>
          )}
          {empty && (
            // The room stays visible; the message is what the viewport says.
            <p className="office-empty" role="status">
              <span>{t('empty.agents')}</span>
            </p>
          )}
          {state !== null && !empty && <p className="office-hint" aria-hidden="true">{t('hint.view')}</p>}
        </div>

        <footer className="office-foot">
          <div className="office-tools">
            <div className="office-zoom">
              <span aria-hidden="true">{t('control.zoom')}</span>
              <input
                type="range"
                min={ZOOM_MIN}
                max={ZOOM_MAX}
                step={5}
                value={Math.round(camera.zoom * 100)}
                aria-label={t('control.zoom')}
                onChange={event => { onCamera({ zoom: Number(event.target.value) / 100 }) }}
              />
              <output>{`${String(Math.round(camera.zoom * 100))}%`}</output>
            </div>
            <button type="button" className="office-btn" onClick={onFit}>{t('control.fit')}</button>
            <button type="button" className="office-btn" aria-pressed={camera.labels} onClick={() => { onCamera({ labels: !camera.labels }) }}>
              {t('control.labels')}
            </button>
            <button type="button" className="office-btn" aria-pressed={camera.links} onClick={() => { onCamera({ links: !camera.links }) }}>
              {t('control.lines')}
            </button>
            <button type="button" className="office-btn" aria-pressed={camera.motion} onClick={() => { onCamera({ motion: !camera.motion }) }}>
              {t('control.motion')}
            </button>
          </div>
          <button type="button" className="office-btn" onClick={() => { onSelect('boss') }}>{t('control.desk')}</button>
        </footer>

        {state !== null && target !== null && (target.kind === 'boss' || selectedAgent !== null) && (
          <TeammateModal agent={selectedAgent} state={state} t={t} onClose={onCloseModal} onOpenJob={onOpenJob} />
        )}
      </div>
    </div>
  )
}

/**
 * The sidebar launcher entry plus the office overlay. Polls only while the
 * panel is open, keeps the last good snapshot on a failed poll, and preserves
 * the selection across polls. The header's session selector switches which
 * conversation's office is drawn.
 * @param props - sidebar owner share, the global session hook, and the injected API.
 * @returns the launcher button and, while open, the overlay.
 */
export function OfficeLauncher(props: OfficeLauncherProps): React.ReactNode {
  const t = props.t ?? zhTranslate
  const { wide, api, openConversation } = props
  const useSessions = props.useSessions as (selector: (state: SessionListLocal) => unknown) => unknown
  const sessionId = useSessions(state => state.current) as string | undefined

  const [open, setOpen] = React.useState(false)
  const [state, setState] = React.useState<OfficeState | null>(null)
  /** The last failure's reason; null while the office is answering. */
  const [error, setError] = React.useState<string | null>(null)
  /** The sessions route's own failure, so neither poll clears the other's. */
  const [sessionsError, setSessionsError] = React.useState<string | null>(null)
  const [sessions, setSessions] = React.useState<SessionList | null>(null)
  /** The session the reader picked; null means this conversation. */
  const [picked, setPicked] = React.useState<string | null>(null)
  const [target, setTarget] = React.useState<ModalTarget | null>(null)
  const [camera, setCamera] = React.useState<CameraState>(() => ({
    zoom: 1,
    pan: { x: 0, y: 0 },
    labels: true,
    links: false,
    motion: !prefersReducedMotion(),
  }))

  const panelRef = React.useRef<HTMLDivElement>(null)
  const targetRef = React.useRef<ModalTarget | null>(null)
  targetRef.current = target
  /** The session the drawn snapshot belongs to; a job row's coordinator. */
  const shownSessionRef = React.useRef('')
  shownSessionRef.current = state?.sessionId ?? ''

  const polledId = picked ?? sessionId

  // One poll chain per (open, session) pair: it reads on open and on a timer,
  // skips hidden tabs, and aborts its in-flight request on cleanup.
  React.useEffect(() => {
    if (!open || polledId === undefined) return
    const controller = new AbortController()
    let live = true
    let pending = false
    const load = async (): Promise<void> => {
      if (pending) return
      pending = true
      try {
        const next = await api.state(polledId, controller.signal)
        if (!live) return
        // Keep the retained snapshot when only the host's `updatedAt` stamp
        // moved: the scene redraw is ~1.2k SVG nodes, the stamp is not drawn.
        setState(current => (sameScene(current, next) ? current : next))
        setError(null)
      } catch (failure) {
        if (!live || isCanceled(failure)) return
        // A refusal (an unreadable teams store, a refused header) is reported
        // with the host's own reason; the last good scene stays on screen.
        setError(errorText(failure))
      } finally {
        pending = false
      }
    }
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return
      void load()
    }, POLL_MS)
    return () => {
      live = false
      window.clearInterval(timer)
      controller.abort()
    }
  }, [open, polledId, api])

  // The session list refreshes on its own slower cadence and never touches the
  // state snapshot: a failed list keeps the last options and the scene.
  React.useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    let live = true
    let pending = false
    const load = async (): Promise<void> => {
      if (pending) return
      pending = true
      try {
        const next = await api.sessions(sessionId ?? null, controller.signal)
        if (!live) return
        setSessions(next)
        setSessionsError(null)
        // A pick this host no longer lists falls back to this conversation;
        // the snapshots on screen stay until the next answer replaces them.
        setPicked(current => (current === null || current === next.currentSessionId
          || next.sessions.some(session => session.id === current) ? current : null))
      } catch (failure) {
        if (!live || isCanceled(failure)) return
        setSessionsError(errorText(failure))
      } finally {
        pending = false
      }
    }
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return
      void load()
    }, SESSIONS_POLL_MS)
    return () => {
      live = false
      window.clearInterval(timer)
      controller.abort()
    }
  }, [open, sessionId, api])

  // A session switch drops the previous conversation's office and selection.
  React.useEffect(() => {
    setState(null)
    setError(null)
    setTarget(null)
    setPicked(null)
  }, [sessionId])

  React.useEffect(() => {
    if (!open) setTarget(null)
  }, [open])

  const closeModal = React.useCallback((): void => {
    const current = targetRef.current
    setTarget(null)
    if (current === null) return
    const id = current.kind === 'boss' ? 'boss' : current.id
    // The dialog owns focus while open; hand it back to the station that
    // opened it once React unmounts the dialog.
    window.setTimeout(() => {
      // Focusable station bodies only: the label layer carries `data-station`
      // for pointer selection but is not a focus target.
      const nodes = panelRef.current?.querySelectorAll<SVGGElement>('[data-station][tabindex]')
      if (nodes === undefined) return
      for (const node of nodes) {
        if (node.dataset['station'] === id) {
          node.focus()
          return
        }
      }
    }, 0)
  }, [])

  // Escape closes the panel; the open modal owns Escape through its own cancel
  // event, so a modal keypress must not also close the whole office.
  React.useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || targetRef.current !== null) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [open])

  // A teammate that leaves the team closes its own detail view.
  React.useEffect(() => {
    if (target === null || target.kind !== 'agent' || state === null) return
    if (!state.agents.some(agent => agent.id === target.id)) setTarget(null)
  }, [target, state])

  const select = React.useCallback((id: string): void => {
    setTarget(id === 'boss' ? { kind: 'boss' } : { kind: 'agent', id })
  }, [])

  const pickSession = React.useCallback((id: string): void => {
    setPicked(id)
  }, [])

  /**
   * Open one job's conversation. The job id is the worker session id and the
   * shown office's session is its coordinator, which the worker path needs; a
   * landed navigation closes this overlay so the reader sees the conversation,
   * and one that fails both ways keeps the overlay up with the reason in the
   * chip.
   */
  const openJob = React.useCallback((jobId: string): void => {
    void openConversation(jobId, shownSessionRef.current).then(() => {
      setTarget(null)
      setOpen(false)
    }, (failure: unknown) => {
      setError(errorText(failure))
    })
  }, [openConversation])

  const updateCamera = React.useCallback((next: Partial<CameraState>): void => {
    setCamera(current => ({ ...current, ...next }))
  }, [])

  const fit = React.useCallback((): void => {
    setCamera(current => ({ ...current, zoom: 1, pan: { x: 0, y: 0 } }))
  }, [])

  const selectedId = target === null ? null : target.kind === 'boss' ? 'boss' : target.id
  const teammates = state?.agents.length ?? 0

  const button = (
    <button
      type="button"
      className="aseldev-office-launch"
      style={{ ...LAUNCH_BUTTON, ...(wide ? LAUNCH_BUTTON_WIDE : LAUNCH_BUTTON_RAIL) }}
      aria-label={t('launcher.aria')}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={wide ? undefined : t('launcher.label')}
      onClick={() => { setOpen(current => !current) }}
    >
      <span style={LAUNCH_MARK} aria-hidden="true"><BrandMark size={12} /></span>
      {wide && <span style={LAUNCH_LABEL}>{t('launcher.label')}</span>}
      {wide && teammates > 0 && <span style={LAUNCH_COUNT}>{teammates}</span>}
    </button>
  )

  return (
    <div style={{ ...LAUNCH_SECTION, ...(wide ? {} : LAUNCH_SECTION_RAIL) }}>
      <style>{LAUNCHER_CSS}</style>
      {button}
      {open && (
        <OfficePanel
          state={state}
          error={error ?? sessionsError}
          sessions={sessions}
          polledId={polledId ?? null}
          selectedId={selectedId}
          target={target}
          camera={camera}
          t={t}
          panelRef={panelRef}
          onClose={() => { setOpen(false) }}
          onSelect={select}
          onSelectSession={pickSession}
          onCloseModal={closeModal}
          onOpenJob={openJob}
          onCamera={updateCamera}
          onFit={fit}
        />
      )}
    </div>
  )
}

// ------------------------------------------------------------------- plugin

/** Required client services: slot composition, session navigation, and locale. */
export const inject: string[] = ['slots', 'sessions', 'locale']

/** The slice of the client locale service this plugin uses. */
interface LocaleLike {
  register: (namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }) => () => void
  bind: (namespace: string) => Translate
}

/** A worker conversation's address under its coordinator session. */
interface SubagentAddressLike {
  readonly parentSessionId: string
  readonly childSessionId: string
  readonly mode: 'continuable'
}

/** The slice of the client sessions service this plugin uses: navigation only. */
interface SessionsLike {
  /** Select a listed or retained catalog-addressed session; throws when unknown. */
  open: (sessionId: string) => void
  /** Open a catalog-confirmed child through its direct-parent address. */
  openSubagent: (address: SubagentAddressLike) => void
  /** The address the runtime already retained for a child, if any. */
  subagentAddress: (sessionId: string) => SubagentAddressLike | undefined
  /** Load one coordinator's direct-child catalog. */
  refreshSubagents: (parentSessionId: string) => Promise<void>
}

/** The slice of the client context this plugin uses (no repo types out of tree). */
interface ClientLikeContext {
  slots: {
    inject: (name: string, callback: () => () => void) => () => void
    register: (options: Record<string, unknown>, component: unknown) => () => void
  }
  sessions: SessionsLike
  locale: LocaleLike
  effect: (callback: () => () => void, label?: string) => unknown
}

/**
 * Run one navigation that can refuse a session id.
 * @param open - the navigation to attempt.
 * @returns the thrown reason, or null when the runtime accepted the id.
 */
function refusalOf(open: () => void): unknown {
  try {
    open()
  } catch (failure) {
    // `sessions.open` refuses an id it has neither listed nor addressed, and a
    // job id is exactly that until its coordinator's worker catalog is loaded.
    // The reason is returned, not dropped: the caller reports it when the worker
    // path refuses as well.
    return failure
  }
  return null
}

/**
 * Client plugin body: dictionaries, then one `sidebar.launcher` contribution.
 * The slot is declared by ui-sidebar, so the registration waits on that
 * declaration instead of racing it.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientLikeContext): void {
  ctx.effect(() => ctx.locale.register(OFFICE_NS, { zh, en }), 'aseldev-office: dictionaries')

  const api = createOfficeApi()

  /**
   * Open one job's conversation, the way the teams panel opens a worker.
   *
   * A listed session opens directly. A job that is a worker session is a
   * continuable child of the coordinator whose office is on screen, so the
   * fallback opens it through that parent address — refreshing the parent
   * catalog first when the runtime has not retained one, because `openSubagent`
   * only accepts an address the catalog confirms. When the worker path refuses
   * as well, its refusal is what rejects, and the panel shows it in its chip.
   * @param jobId - the job id, which the host sends as the worker session id.
   * @param parentSessionId - the coordinator session whose office is on screen.
   */
  const openConversation = async (jobId: string, parentSessionId: string): Promise<void> => {
    const refusal = refusalOf(() => { ctx.sessions.open(jobId) })
    if (refusal === null) return
    // Without a coordinator there is no address to build.
    if (parentSessionId === '') throw refusal
    const retained = ctx.sessions.subagentAddress(jobId)
    const address: SubagentAddressLike = retained
      ?? { parentSessionId, childSessionId: jobId, mode: 'continuable' }
    if (retained === undefined) await ctx.sessions.refreshSubagents(parentSessionId)
    ctx.sessions.openSubagent(address)
  }

  ctx.slots.inject('sidebar.launcher', () => ctx.slots.register({
    name: 'sidebar.launcher',
    id: 'office',
    order: 30,
    registrant: '@aseldev/dsh-office',
    locale: OFFICE_NS,
    inject: (): OfficeInjected => ({ api, openConversation }),
  }, OfficeLauncher))
}

/** The office stylesheet, injected as one `<style>` element while the panel is open. */
export const OFFICE_CSS = `/*
 * ASELDEV AI HQ office panel.
 *
 * Every rule is scoped under the .aseldev-office root class (the fixed overlay)
 * so the dsh web shell is untouched; the panel's palette is the reference's
 * dark pixel-art office, kept as local custom properties instead of shell
 * tokens.
 *
 * The plugin bundle cannot import CSS (a tsdown browser bundle without
 * @tsdown/css rejects a .css import), so this file is the maintainable source
 * and client.tsx carries the same text as OFFICE_CSS, injected as one <style>
 * element on open. client.test.mjs fails when the two drift apart.
 */

.aseldev-office {
  --o-bg: #0a0e14;
  --o-line: #283241;
  --o-text: #e8eef6;
  --o-muted: #9aa9bc;
  --o-cyan: #37bfff;
  --o-amber: #ffcb85;
  --o-red: #f2929c;

  position: fixed;
  inset: 0;
  z-index: 150;
  display: grid;
  place-items: center;
  padding: 8px;
  background: rgb(5 10 18 / 78%);
  color: var(--o-text);
  font-family: "Segoe UI", system-ui, sans-serif;
  color-scheme: dark;
}

.aseldev-office *,
.aseldev-office *::before,
.aseldev-office *::after { box-sizing: border-box; }

.aseldev-office .office-panel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: min(96vw, 1500px);
  height: min(92vh, 980px);
  overflow: hidden;
  border: 1px solid var(--o-line);
  border-radius: 12px;
  background: var(--o-bg);
  box-shadow: 0 30px 100px rgb(0 0 0 / 60%);
}

/* ---------------------------------------------------------------- header */

.aseldev-office .office-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 16px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--o-line);
  background: #111822;
}

.aseldev-office .office-brand {
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 0;
}

.aseldev-office .office-brand-mark {
  display: grid;
  flex: none;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1px solid #2c4b62;
  border-radius: 9px;
  background: #142535;
}

.aseldev-office .office-brand-mark svg { width: 20px; height: 20px; }

.aseldev-office .office-brand-copy { min-width: 0; }
.aseldev-office .office-brand-copy strong { display: block; font-size: 13px; letter-spacing: .09em; }
.aseldev-office .office-brand-copy small { display: block; margin-top: 2px; color: var(--o-muted); font-size: 10.5px; }

.aseldev-office .office-metrics {
  display: flex;
  gap: 22px;
  margin-left: auto;
}

.aseldev-office .office-metric { min-width: 0; }
.aseldev-office .office-metric strong {
  display: block;
  font-size: 19px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.aseldev-office .office-metric span {
  display: block;
  margin-top: 2px;
  color: var(--o-muted);
  font-size: 9.5px;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.aseldev-office .office-metric-needs strong { color: var(--o-amber); }

/* ------------------------------------------------------- session selector */

.aseldev-office .office-session {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.aseldev-office .office-session span {
  color: var(--o-muted);
  font: 9.5px/1.4 Consolas, monospace;
  letter-spacing: .12em;
  text-transform: uppercase;
}

.aseldev-office .office-session select {
  min-width: 0;
  max-width: 30ch;
  padding: 5px 8px;
  border: 1px solid var(--o-line);
  border-radius: 7px;
  background: #19222e;
  color: #d9e3ef;
  font: inherit;
  font-size: 11px;
  text-overflow: ellipsis;
  cursor: pointer;
}
.aseldev-office .office-session select:hover { border-color: #46596f; background: #243143; }
.aseldev-office .office-session select:focus-visible { outline: 2px solid var(--o-cyan); outline-offset: 2px; }

.aseldev-office .office-live {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--o-muted);
  font-size: 10px;
  white-space: nowrap;
}
.aseldev-office .office-live i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--o-amber);
  animation: office-pulse 1.6s steps(2, end) infinite;
}

/* A refused poll names the reason the host gave; a steady dot, not a pulse. */
.aseldev-office .office-live-error {
  max-width: 38ch;
  overflow: hidden;
  color: var(--o-red);
  text-overflow: ellipsis;
}
.aseldev-office .office-live-error i {
  flex: none;
  background: var(--o-red);
  animation: none;
}

/* --------------------------------------------------------------- viewport */

.aseldev-office .office-stage {
  position: relative;
  min-height: 0;
  overflow: hidden;
  background: radial-gradient(ellipse at 48% 52%, #1c2837 0%, #111a25 44%, #0d131c 76%);
}

.aseldev-office .office-svg {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.aseldev-office .office-svg.office-dragging { cursor: grabbing; }

.aseldev-office .office-hint {
  position: absolute;
  top: 11px;
  left: 13px;
  margin: 0;
  color: #94a6bd;
  font: 10px/1.7 Consolas, monospace;
  pointer-events: none;
}

.aseldev-office .office-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  margin: 0;
  padding: 24px;
  pointer-events: none;
}
.aseldev-office .office-empty span {
  max-width: 36ch;
  padding: 13px 17px;
  border: 1px dashed var(--o-line);
  border-radius: 8px;
  background: rgb(10 14 20 / 85%);
  color: var(--o-muted);
  font-size: 13px;
  line-height: 1.7;
  text-align: center;
}

/* ----------------------------------------------------------- scene states */

.aseldev-office .office-pixels { shape-rendering: crispEdges; }
.aseldev-office .office-station { cursor: pointer; outline: none; }
.aseldev-office .office-station .office-selection { opacity: 0; transition: opacity .15s; }
.aseldev-office .office-station:hover .office-selection { opacity: .45; }
.aseldev-office .office-station.office-selected .office-selection,
.aseldev-office .office-station:focus-visible .office-selection { opacity: 1; }
.aseldev-office .office-station[data-status="offline"] .office-equipment { opacity: .5; }

/* Plates live in their own layer above every desk, so label feedback is
   styled on the plate itself rather than through the station's state. */
.aseldev-office .office-label { cursor: pointer; }
.aseldev-office .office-label:hover .office-nameplate { stroke: #8fd8ff; }

.aseldev-office .office-typing { animation: office-typing .8s steps(2, end) infinite; }
.aseldev-office .office-signal { animation: office-signal 3.3s steps(2, end) infinite; }
.aseldev-office .office-route { stroke-dasharray: 4 8; animation: office-route 4s linear infinite; }
/* Active work: the floor pool, desk wash, and monitor halo of a working station. */
.aseldev-office .office-glow { animation: office-glow 2.8s ease-in-out infinite; }

.aseldev-office[data-motion="off"] .office-typing,
.aseldev-office[data-motion="off"] .office-signal,
.aseldev-office[data-motion="off"] .office-route,
.aseldev-office[data-motion="off"] .office-glow,
.aseldev-office[data-motion="off"] .office-live i,
.aseldev-office[data-motion="off"] .office-track span { animation: none; transition: none; }

@keyframes office-typing {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-1px); }
}
@keyframes office-signal {
  0%, 100% { opacity: .45; }
  50% { opacity: 1; }
}
/* Either end is a readable static glow, so motion off keeps the light. */
@keyframes office-glow {
  0%, 100% { opacity: .62; }
  50% { opacity: 1; }
}
@keyframes office-route {
  to { stroke-dashoffset: -48; }
}
@keyframes office-pulse {
  0%, 100% { opacity: .45; }
  50% { opacity: 1; }
}

/* ---------------------------------------------------------------- footer */

.aseldev-office .office-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 9px 12px;
  border-top: 1px solid var(--o-line);
  background: #111822;
}

.aseldev-office .office-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.aseldev-office .office-btn {
  padding: 7px 10px;
  border: 1px solid var(--o-line);
  border-radius: 7px;
  background: #19222e;
  color: #d9e3ef;
  font: inherit;
  font-size: 11px;
  line-height: 1.35;
  white-space: nowrap;
  cursor: pointer;
  transition: background .15s, border-color .15s;
}
.aseldev-office .office-btn:hover { border-color: #46596f; background: #243143; }
.aseldev-office .office-btn[aria-pressed="true"] {
  border-color: #37779a;
  background: #173144;
  color: #bce8ff;
}
.aseldev-office .office-btn:focus-visible,
.aseldev-office .office-zoom input:focus-visible {
  outline: 2px solid var(--o-cyan);
  outline-offset: 2px;
}

.aseldev-office .office-close { padding: 5px 9px; font-size: 13px; line-height: 1; }

.aseldev-office .office-zoom {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-right: 4px;
}
.aseldev-office .office-zoom span {
  color: var(--o-muted);
  font: 10px Consolas, monospace;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.aseldev-office .office-zoom input { width: 74px; accent-color: var(--o-cyan); cursor: pointer; }
.aseldev-office .office-zoom output { min-width: 32px; color: var(--o-muted); font: 10px Consolas, monospace; }

/* ------------------------------------------------------------ detail modal */

.aseldev-office .office-modal {
  width: min(560px, calc(100vw - 24px));
  max-height: min(88dvh, 720px);
  overflow: auto;
  overscroll-behavior: contain;
  padding: 20px;
  border: 1px solid #405168;
  border-radius: 14px;
  background: #141d28;
  color: var(--o-text);
  font-family: "Segoe UI", system-ui, sans-serif;
}
.aseldev-office .office-modal::backdrop {
  background: rgb(5 10 18 / 78%);
  backdrop-filter: blur(4px);
}

.aseldev-office .office-modal-id {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}

.aseldev-office .office-portrait-frame {
  display: grid;
  flex: none;
  place-items: center;
  width: 96px;
  height: 108px;
  overflow: hidden;
  border: 1px solid #344457;
  border-radius: 10px;
  background: linear-gradient(180deg, #1f2f40, #17222f);
}
.aseldev-office .office-portrait { display: block; width: 86px; height: 96px; }

.aseldev-office .office-modal-copy { min-width: 0; }
.aseldev-office .office-modal-copy h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -.02em;
  overflow-wrap: anywhere;
}
.aseldev-office .office-modal-role {
  margin: 5px 0 0;
  color: var(--o-muted);
  font-size: 11.5px;
  line-height: 1.6;
}

.aseldev-office .office-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 9px;
  padding: 4px 8px;
  border: 1px solid currentColor;
  border-radius: 5px;
  font-size: 10.5px;
  white-space: nowrap;
}
.aseldev-office .office-chip::before {
  content: "";
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}

.aseldev-office .office-modal-close { margin-left: auto; flex: none; }

.aseldev-office .office-rows {
  display: flex;
  flex-direction: column;
  margin: 16px 0 0;
}
.aseldev-office .office-row { padding: 11px 0; border-top: 1px solid var(--o-line); }
.aseldev-office .office-row dt {
  margin: 0;
  color: var(--o-muted);
  font: 9.5px/1.5 Consolas, monospace;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.aseldev-office .office-row dd {
  margin: 5px 0 0;
  font-size: 12.5px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.aseldev-office .office-progress-meta {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
  font-size: 11px;
}
.aseldev-office .office-track {
  display: block;
  height: 4px;
  overflow: hidden;
  border-radius: 4px;
  background: #263345;
}
.aseldev-office .office-track span { display: block; height: 100%; transition: width .25s; }

/* -------------------------------------------------------------- job list */

.aseldev-office .office-job-count {
  margin: 0 0 9px;
  color: var(--o-muted);
  font: 10px/1.5 Consolas, monospace;
  letter-spacing: .03em;
}

.aseldev-office .office-job-empty {
  margin: 0;
  color: var(--o-muted);
  font-size: 12.5px;
  line-height: 1.7;
}

.aseldev-office .office-jobs {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* A job row is the way into that job's conversation, so it is a real button. */
.aseldev-office .office-job {
  display: block;
  width: 100%;
  box-sizing: border-box;
  padding: 9px 10px;
  border: 1px solid var(--o-line);
  border-radius: 8px;
  background: #182130;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background .15s, border-color .15s;
}
.aseldev-office .office-job:hover { border-color: #46596f; background: #21303f; }
.aseldev-office .office-job:focus-visible { outline: 2px solid var(--o-cyan); outline-offset: 2px; }

.aseldev-office .office-job-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.aseldev-office .office-job-chip { margin-top: 0; padding: 2px 6px; font-size: 9.5px; }

.aseldev-office .office-job-pct {
  flex: none;
  color: var(--o-muted);
  font: 10px Consolas, monospace;
  font-variant-numeric: tabular-nums;
}

.aseldev-office .office-job-go {
  flex: none;
  color: var(--o-muted);
  font-size: 13px;
  line-height: 1;
}
.aseldev-office .office-job:hover .office-job-go { color: #bce8ff; }

/* Two lines of title, then a clamp, so a long job title cannot push the bar
   out of the row or widen the dialog on a 360 px screen. */
.aseldev-office .office-job-title {
  display: -webkit-box;
  overflow: hidden;
  margin: 6px 0 8px;
  font-size: 12px;
  line-height: 1.55;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}

.aseldev-office .office-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin: 14px 0 0;
  padding-top: 12px;
  border-top: 1px solid var(--o-line);
  color: #7b8a9d;
  font: 10px/1.6 Consolas, monospace;
}
.aseldev-office .office-meta span { white-space: nowrap; }

/* -------------------------------------------------------------- narrow */

@media (max-width: 820px) {
  .aseldev-office .office-metrics {
    order: 3;
    justify-content: space-between;
    width: 100%;
    margin-left: 0;
  }
  .aseldev-office .office-hint { display: none; }
  .aseldev-office .office-head { gap: 10px; }
}

@media (max-width: 460px) {
  .aseldev-office { padding: 6px; }
  .aseldev-office .office-panel { width: min(100vw - 12px, 1500px); height: min(94vh, 980px); }
  .aseldev-office .office-brand-copy small { display: none; }
  .aseldev-office .office-metric strong { font-size: 17px; }
  .aseldev-office .office-zoom input { width: 58px; }
  .aseldev-office .office-session select { max-width: 44vw; }
  .aseldev-office .office-foot { padding: 8px 10px; }
  .aseldev-office .office-modal { padding: 16px; }
  .aseldev-office .office-modal-id { gap: 10px; }
  .aseldev-office .office-portrait-frame { width: 72px; height: 82px; }
  .aseldev-office .office-portrait { width: 64px; height: 72px; }
  .aseldev-office .office-modal-copy h2 { font-size: 17px; }
}

@media (prefers-reduced-motion: reduce) {
  .aseldev-office *,
  .aseldev-office *::before,
  .aseldev-office *::after { animation: none !important; transition: none !important; }
}
`
