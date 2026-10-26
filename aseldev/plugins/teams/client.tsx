/**
 * AselDev teams panel, browser half.
 *
 * One `sidebar.launcher` entry under the Brain/Artifacts buttons: a labelled
 * button when the sidebar is wide, an icon on the collapsed rail, and a
 * fixed-position status panel that escapes the sidebar column's overflow
 * clipping (the same technique `Tooltip` and the artifacts window use). The
 * entry is optional: `showLauncher: false` in the plugin row leaves it to the
 * isometric office, which owns the sidebar in the shipped profile.
 *
 * The panel is scoped to one coordinator session: it reads that session's
 * team through the host plugin's JSON API (`GET /aseldev-teams/api/state`),
 * polls while open, and drives every mutating action through
 * `POST /aseldev-teams/api/action`. The host half (`host.ts`) owns the durable
 * team store, the scheduler, and the real subagent workers; this file only
 * renders assignment state and issues commands.
 *
 * Transport rules (mirrored in the host half):
 * - Same-origin JSON, both requests carry the `x-aseldev-teams: 1` header the
 *   host requires; a browser cross-site page cannot send it without a CORS
 *   preflight this route never approves.
 * - Any non-2xx answer is `{ error: string }`; the panel shows that text.
 * - The `state` body is parsed strictly: a missing or mistyped field throws
 *   with the field path instead of silently rendering a wrong team.
 *
 * Copy is localised through the shell's locale service (`aseldev.teams`
 * namespace, zh + en). The exported helper functions below exist so the test
 * harness can exercise the shipped artifact without the shell; they are not a
 * supported API surface — the supported surface is `apply` + `inject`.
 *
 * Local form state (drafts for assign, message, configure, specialist) lives
 * in React state in the launcher component, which stays mounted while the
 * panel opens and closes and is never remounted by a poll — so a refresh
 * never discards what the user typed.
 *
 * Deliberately dependency-free apart from the shared platform modules the
 * shell injects into the frozen module table: `react` and
 * `@deepseek-ai/dsh-client-ui-primitives`. No repo imports, no CSS modules.
 */

import * as React from 'react'
import {
  Button, Input, Pill, StateDot, Tooltip, useDismissOnOutsidePointer,
  IconCheckOutline14, IconChecklistOutline14, IconCloseOutline16, IconPlayOutline16,
  IconPlusOutline16, IconRefreshOutline16, IconSendOutline16, IconStopFill16,
  IconUserOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** Host route root owned by `host.ts`. */
const ENDPOINT = '/aseldev-teams/api'

/** Custom header the host route requires on every request. */
const TRUST_HEADER = 'x-aseldev-teams'

/** Poll period while the panel is open (milliseconds). */
const POLL_MS = 1500

/** Panel geometry. */
const PANEL_WIDTH = 300
const PANEL_GAP = 12
const PANEL_VIEWPORT_PAD = 8

/** Orbit ring geometry: three nodes around the PM core. */
const ORBIT_ANGLE = [-90, 30, 150]
const ORBIT_RADIUS = 84

/** Locale namespace owned by this plugin. */
export const TEAMS_NS = 'aseldev.teams'

// ------------------------------------------------------------------- locale

/** Translate one key with optional `{name}` template params. */
export type Translate = (key: string, params?: Record<string, unknown>) => string

/** Chinese copy (the deployment's product language; also the fallback). */
export const zh = {
  'panel.title': '团队',
  'panel.summaryActive': '{count} 个进行中',
  'panel.summaryQueued': '{count} 个排队',
  'panel.summaryTotal': '{count} 个任务',
  'panel.refresh': '刷新',
  'panel.close': '关闭团队面板',
  'panel.retry': '重试',
  'panel.dismissError': '关闭错误提示',
  'coordinator.label': '协调者会话',
  'coordinator.current': '当前会话',
  'coordinator.open': '打开',
  'coordinator.follow': '先在左侧打开一个会话，面板会跟随当前会话',
  'paused.banner': '团队已暂停：重启后不会自动排程，排队中的任务需要恢复或重试。',
  'paused.resume': '恢复调度',
  'tasks.title': '任务',
  'tasks.limit': '并行上限 {value}',
  'tasks.loading': '正在读取团队状态…',
  'tasks.switching': '正在切换协调者会话…',
  'tasks.openSession': '先打开一个会话，再看它的团队任务。',
  'tasks.unavailable': '暂无团队状态',
  'tasks.empty': '该会话还没有任务。在下面指派第一个 worker。',
  'task.open': '打开会话',
  'task.openHint': '只读查看该 worker 的会话记录；跟进消息请在本面板发送',
  'task.message': '发消息',
  'task.messageClose': '收起消息',
  'task.cancel': '取消',
  'task.retry': '重试',
  'task.running': '· 会话运行中',
  'task.files': '占用 {files}',
  'task.deps': '依赖 {count} 项',
  'message.placeholder': '给这个 worker 追加一条消息（空闲时才会派发）',
  'message.send': '发送',
  'message.hintBusy': '当前进行中：消息会被拒绝，等它空闲或先取消。',
  'message.hintIdle': '从这里发送才会进入调度；直接在该会话的输入框发送会被团队守卫拒绝。',
  'assign.title': '指派任务',
  'assign.specialist': '专家',
  'assign.noSpecialists': '没有可用专家',
  'assign.taskTitle': '标题',
  'assign.taskTitlePlaceholder': '例：排查登录超时',
  'assign.prompt': '任务说明',
  'assign.promptPlaceholder': '写清范围、验收标准与要回报的内容',
  'assign.files': '占用文件（每行一个，整库填 .）',
  'assign.filesPlaceholder': 'packages\\client\\ui-jobs\\.',
  'assign.depends': '前置任务（可选）',
  'assign.submit': '指派',
  'assign.hint': '并行与占用冲突由宿主调度，超出的任务保持排队。',
  'assign.errSpecialist': '请先选择专家',
  'assign.errTitle': '请填写任务标题',
  'assign.errPrompt': '请填写任务说明',
  'assign.errWriteFiles': '写类专家必须占用至少一个文件或目录（整库填 .）',
  'configure.title': '并行上限',
  'configure.hostDefault': '宿主默认值',
  'configure.save': '保存',
  'configure.hint': '只影响这个团队；并行冲突由宿主调度。',
  'specialists.title': '专家',
  'specialists.new': '新建',
  'specialists.idPlaceholder': 'id（小写字母、数字、连字符）',
  'specialists.namePlaceholder': '显示名',
  'specialists.modeRead': '只读（不改文件）',
  'specialists.modeWrite': '可写（必须占用文件）',
  'specialists.instructionsPlaceholder': '这个专家的工作说明',
  'specialists.save': '保存专家',
  'specialists.cancel': '取消',
  'footer.never': '尚未同步',
  'footer.synced': '已同步',
  'footer.updated': '已更新 {time}',
  'footer.busy': '提交中…',
  'footer.noSession': '未选择会话',
  'footer.paused': '已暂停',
  'footer.polling': '自动刷新中',
  'footer.manual': '手动刷新',
  'footer.hidden': '窗口未激活',
  'launcher.label': '团队',
  'launcher.aria': '团队任务面板',
  'launcher.tooltip': '团队任务',
  'role.read': '读',
  'role.write': '写',
  'status.queued': '排队中',
  'status.starting': '启动中',
  'status.working': '进行中',
  'status.canceling': '取消中',
  'status.done': '已完成',
  'status.failed': '失败',
  'status.canceled': '已取消',
  'status.blocked': '受阻',
  'status.unknown': '未知',
  'status.idle': '空闲',
  'orbit.live': '实时',
  'orbit.worker': '打开该角色的会话',
  'orbit.captionIdle': '团队空闲',
  'orbit.captionDone': '全部完成',
  'orbit.captionBusy': '{settled} 项已结算 · {inflight} 项进行中',
  'error.malformed': '团队状态格式不正确：{path} 必须是{expected}',
  'error.transport': '无法连接团队接口：宿主插件可能未加载',
  'error.http': '团队接口失败（HTTP {status}）',
  'error.nonJson': '团队接口返回了非 JSON 响应（HTTP {status}）',
  'error.request': '请求失败',
  'expected.object': '一个对象',
  'expected.string': '一个字符串',
  'expected.nonEmptyString': '非空字符串',
  'expected.number': '一个有限数字',
  'expected.array': '一个数组',
  'expected.mode': '"read" 或 "write"',
  'expected.team': 'null 或一个对象',
  'expected.boolean': '一个布尔值',
  'settings.nav': '团队',
  'settings.title': '团队',
  'settings.pm': '项目经理（协调者）技能',
  'settings.pmHint': 'PM 的编排协议：读取工作区、拆分任务、指派和汇总报告。',
  'settings.roles': '角色技能',
  'settings.skillHint': '保存后对新任务生效；正在运行的 worker 不受影响。',
  'settings.loading': '正在读取团队配置…',
  'settings.error': '读取团队配置失败',
  'settings.save': '保存',
  'settings.saved': '已保存',
  'settings.ponytail': 'Ponytail 等级',
  'settings.autoRounds': '自动续跑轮数',
  'settings.reload': '重新读取',
} as const

/** English copy. */
export const en: Record<keyof typeof zh, string> = {
  'panel.title': 'Team',
  'panel.summaryActive': '{count} running',
  'panel.summaryQueued': '{count} queued',
  'panel.summaryTotal': '{count} task(s)',
  'panel.refresh': 'Refresh',
  'panel.close': 'Close the team panel',
  'panel.retry': 'Retry',
  'panel.dismissError': 'Dismiss the error',
  'coordinator.label': 'Coordinator session',
  'coordinator.current': 'Current session',
  'coordinator.open': 'Open',
  'coordinator.follow': 'Open a session on the left; the panel follows the current one',
  'paused.banner': 'The team is paused: after a restart nothing is scheduled until you resume or retry.',
  'paused.resume': 'Resume',
  'tasks.title': 'Assignments',
  'tasks.limit': 'Parallel limit {value}',
  'tasks.loading': 'Reading team state…',
  'tasks.switching': 'Switching coordinator…',
  'tasks.openSession': 'Open a session to see its team assignments.',
  'tasks.unavailable': 'Team state unavailable',
  'tasks.empty': 'No assignments yet. Assign the first worker below.',
  'task.open': 'Open conversation',
  'task.openHint': 'Read the worker transcript; send follow-ups from this panel',
  'task.message': 'Message',
  'task.messageClose': 'Hide message box',
  'task.cancel': 'Cancel',
  'task.retry': 'Retry',
  'task.running': '· conversation running',
  'task.files': 'Reserves {files}',
  'task.deps': 'Needs {count} prerequisite(s)',
  'message.placeholder': 'Follow-up for this worker (dispatched once it is idle)',
  'message.send': 'Send',
  'message.hintBusy': 'Busy: the host refuses the message until this worker is idle or you cancel it.',
  'message.hintIdle': 'Send from here to stay in the scheduler; typing in that conversation is refused by the team guard.',
  'assign.title': 'Assign',
  'assign.specialist': 'Specialist',
  'assign.noSpecialists': 'No specialists available',
  'assign.taskTitle': 'Title',
  'assign.taskTitlePlaceholder': 'e.g. investigate the login timeout',
  'assign.prompt': 'Instructions',
  'assign.promptPlaceholder': 'Scope, acceptance criteria, and what to report back',
  'assign.files': 'Reservations (one per line; . for the whole workspace)',
  'assign.filesPlaceholder': 'packages\\client\\ui-jobs\\.',
  'assign.depends': 'Prerequisites (optional)',
  'assign.submit': 'Assign',
  'assign.hint': 'The host schedules concurrency and reservations; excess work stays queued.',
  'assign.errSpecialist': 'Choose a specialist first',
  'assign.errTitle': 'A title is required',
  'assign.errPrompt': 'Instructions are required',
  'assign.errWriteFiles': 'A writing specialist needs at least one reservation (. for the whole workspace)',
  'configure.title': 'Parallel limit',
  'configure.hostDefault': 'Host default',
  'configure.save': 'Save',
  'configure.hint': 'Affects this team only; the host arbitrates conflicts.',
  'specialists.title': 'Specialists',
  'specialists.new': 'New',
  'specialists.idPlaceholder': 'id (lowercase letters, digits, dashes)',
  'specialists.namePlaceholder': 'Display name',
  'specialists.modeRead': 'Read-only (no edits)',
  'specialists.modeWrite': 'Can write (reservations required)',
  'specialists.instructionsPlaceholder': 'How this specialist should work',
  'specialists.save': 'Save specialist',
  'specialists.cancel': 'Cancel',
  'footer.never': 'Not synced yet',
  'footer.synced': 'Synced',
  'footer.updated': 'Updated {time}',
  'footer.busy': 'Submitting…',
  'footer.noSession': 'No session selected',
  'footer.paused': 'Paused',
  'footer.polling': 'Auto-refreshing',
  'footer.manual': 'Manual refresh',
  'footer.hidden': 'Tab hidden',
  'launcher.label': 'Team',
  'launcher.aria': 'Team panel',
  'launcher.tooltip': 'Team assignments',
  'role.read': 'read',
  'role.write': 'write',
  'status.queued': 'Queued',
  'status.starting': 'Starting',
  'status.working': 'Running',
  'status.canceling': 'Canceling',
  'status.done': 'Done',
  'status.failed': 'Failed',
  'status.canceled': 'Canceled',
  'status.blocked': 'Blocked',
  'status.unknown': 'Unknown',
  'status.idle': 'Idle',
  'orbit.live': 'live',
  'orbit.worker': 'Open the role conversation',
  'orbit.captionIdle': 'Team idle',
  'orbit.captionDone': 'All done',
  'orbit.captionBusy': '{settled} settled · {inflight} in flight',
  'error.malformed': 'Malformed team state: {path} must be {expected}',
  'error.transport': 'Cannot reach the teams endpoint: the host plugin may not be loaded',
  'error.http': 'The teams endpoint failed (HTTP {status})',
  'error.nonJson': 'The teams endpoint answered with non-JSON content (HTTP {status})',
  'error.request': 'Request failed',
  'expected.object': 'an object',
  'expected.string': 'a string',
  'expected.nonEmptyString': 'a non-empty string',
  'expected.number': 'a finite number',
  'expected.array': 'an array',
  'expected.mode': '"read" or "write"',
  'expected.team': 'null or an object',
  'expected.boolean': 'a boolean',
  'settings.nav': 'Team',
  'settings.title': 'Team',
  'settings.pm': 'Project Manager (coordinator) skill',
  'settings.pmHint': 'The PM protocol: read the shared workspace, split the request, assign, and summarize reports.',
  'settings.roles': 'Role skills',
  'settings.skillHint': 'Applies to new assignments; running workers keep their captured role.',
  'settings.loading': 'Reading team configuration…',
  'settings.error': 'Reading the team configuration failed',
  'settings.save': 'Save',
  'settings.saved': 'Saved',
  'settings.ponytail': 'Ponytail level',
  'settings.autoRounds': 'Auto-continue rounds',
  'settings.reload': 'Reload',
}

/**
 * Resolve one key from a dictionary with `{name}` substitution.
 * @param dictionary - the dictionary to read.
 * @param key - message key.
 * @param params - template values.
 * @returns the interpolated text, or the key itself when the dictionary misses it.
 */
function translateFrom(dictionary: Record<string, string>, key: string, params?: Record<string, unknown>): string {
  const template = dictionary[key]
  if (template === undefined) return key
  if (params === undefined) return template
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/**
 * Chinese translate function, used when the shell provides no locale seat and
 * by the test harness (which renders components directly).
 * @param key - message key.
 * @param params - template values.
 * @returns the Chinese text.
 */
export const zhTranslate: Translate = (key, params) => translateFrom(zh, key, params)

// ---------------------------------------------------------------- data model

/** How a specialist is allowed to touch the workspace. */
export type SpecialistMode = 'read' | 'write'

/** One reusable worker role. */
export interface Specialist {
  id: string
  name: string
  instructions: string
  mode: SpecialistMode
}

/**
 * The role as recorded on an assignment (see {@link TeamTask.specialist}).
 * `instructions` is not projected: a row needs the name and the mode at
 * assignment time, and carrying the prompt text into the browser would leak
 * copy the panel never shows.
 */
export interface TaskSpecialist {
  id: string
  name: string
  /** Mode at assignment time; the live roster's mode may differ since. */
  mode: SpecialistMode
}

/**
 * Assignment lifecycle states the host engine reports. The union is
 * deliberately open at the wire: a host that adds a status before this bundle
 * ships renders it as its literal value rather than as a wrong state.
 */
export type TaskStatus =
  | 'queued' | 'starting' | 'working' | 'canceling'
  | 'done' | 'failed' | 'canceled' | 'blocked'

/** One assignment on a coordinator's team. */
export interface TeamTask {
  id: string
  specialistId: string
  /**
   * The role exactly as it was when this assignment was made (the host stores
   * an immutable copy per task). Preferred over the live roster for the row's
   * label, so renaming a specialist or switching its mode later never
   * rewrites how an existing worker reads. `instructions` is deliberately not
   * carried: rows show the name and mode only.
   */
  specialist?: TaskSpecialist
  title: string
  prompt: string
  /** A known {@link TaskStatus}, or a literal value from a newer host. */
  status: string
  /** Durable worker conversation id, present once a worker exists. */
  workerId?: string
  /** Workspace-relative reservations; `.` means the whole workspace. */
  files: string[]
  /** Task ids that must finish first. */
  dependsOn: string[]
  result?: string
  error?: string
}

/** The selected coordinator's team. */
export interface TeamState {
  sessionId: string
  maxActive: number
  /** True after a harness restart: nothing is scheduled until `resume` or an explicit assign. */
  paused: boolean
  tasks: TeamTask[]
}

/** A coordinator the host knows about (for the picker). */
export interface CoordinatorRef {
  sessionId: string
  label: string
}

/** One `state` answer. */
export interface TeamsSnapshot {
  specialists: Specialist[]
  team: TeamState | null
  coordinators: CoordinatorRef[]
  /** Deployment ceiling on `maxActive`, when the host reports one. */
  maxLimit?: number
}

/** One `action` request body (sessionId is added by the caller). */
export type TeamsAction =
  | { action: 'save_specialist'; specialist: Specialist }
  | { action: 'configure'; maxActive: number }
  | { action: 'assign'; specialistId: string; title: string; prompt: string; files: string[]; dependsOn: string[] }
  | { action: 'cancel'; taskId: string }
  | { action: 'retry'; taskId: string }
  | { action: 'message'; taskId: string; message: string }
  | { action: 'resume' }

/** Durable parent/child address that selects subagent navigation in the client. */
export interface SubagentAddress {
  parentSessionId: string
  childSessionId: string
  mode: 'one-shot' | 'continuable'
}

// ------------------------------------------------------------ wire boundary

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A malformed `state` answer, carrying the field path that failed. */
export class SnapshotError extends Error {
  override readonly name = 'SnapshotError'

  /**
   * @param key - message key describing the failure.
   * @param path - field path inside the payload (`team.tasks[2].mode`).
   * @param expected - localized description of what the field had to be.
   * @param t - translate function for the rendered text.
   */
  constructor(key: string, readonly path: string, expected: string, t: Translate) {
    super(t(key, { path, expected }))
  }
}

function recordAt(value: unknown, path: string, t: Translate): Record<string, unknown> {
  if (!isRecord(value)) throw new SnapshotError('error.malformed', path, t('expected.object'), t)
  return value
}

function stringAt(value: unknown, path: string, t: Translate): string {
  if (typeof value !== 'string') throw new SnapshotError('error.malformed', path, t('expected.string'), t)
  return value
}

function idAt(value: unknown, path: string, t: Translate): string {
  const text = stringAt(value, path, t)
  if (text === '') throw new SnapshotError('error.malformed', path, t('expected.nonEmptyString'), t)
  return text
}

function numberAt(value: unknown, path: string, t: Translate): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SnapshotError('error.malformed', path, t('expected.number'), t)
  }
  return value
}

function arrayAt(value: unknown, path: string, t: Translate): unknown[] {
  if (!Array.isArray(value)) throw new SnapshotError('error.malformed', path, t('expected.array'), t)
  return value
}

function stringListAt(value: unknown, path: string, t: Translate): string[] {
  return arrayAt(value, path, t).map((item, index) => stringAt(item, `${path}[${String(index)}]`, t))
}

function optionalStringAt(value: unknown, path: string, t: Translate): string | undefined {
  return value === undefined ? undefined : stringAt(value, path, t)
}

function modeAt(value: unknown, path: string, t: Translate): SpecialistMode {
  if (value === 'read' || value === 'write') return value
  throw new SnapshotError('error.malformed', path, t('expected.mode'), t)
}

function parseSpecialist(value: unknown, path: string, t: Translate): Specialist {
  const record = recordAt(value, path, t)
  return {
    id: idAt(record.id, `${path}.id`, t),
    name: stringAt(record.name, `${path}.name`, t),
    instructions: stringAt(record.instructions, `${path}.instructions`, t),
    mode: modeAt(record.mode, `${path}.mode`, t),
  }
}

/**
 * Read the per-task role copy when the host sends one.
 *
 * The host records the assignment-time role on each task; older stored teams
 * and hosts without the field simply omit it, so it is optional. Extra keys
 * are ignored on purpose, and `instructions` is not projected — the browser
 * side never shows it.
 * @param value - raw `task.specialist`.
 * @param path - field path for diagnostics.
 * @param t - translate function.
 * @returns the role copy, or undefined when the field is absent.
 * @throws {SnapshotError} when the field is present but malformed.
 */
function optionalTaskSpecialistAt(value: unknown, path: string, t: Translate): TaskSpecialist | undefined {
  if (value === undefined) return undefined
  const record = recordAt(value, path, t)
  return {
    id: idAt(record.id, `${path}.id`, t),
    name: stringAt(record.name, `${path}.name`, t),
    mode: modeAt(record.mode, `${path}.mode`, t),
  }
}

function parseTask(value: unknown, path: string, t: Translate): TeamTask {
  const record = recordAt(value, path, t)
  const task: TeamTask = {
    id: idAt(record.id, `${path}.id`, t),
    specialistId: idAt(record.specialistId, `${path}.specialistId`, t),
    title: stringAt(record.title, `${path}.title`, t),
    prompt: stringAt(record.prompt, `${path}.prompt`, t),
    status: idAt(record.status, `${path}.status`, t),
    files: stringListAt(record.files, `${path}.files`, t),
    dependsOn: stringListAt(record.dependsOn, `${path}.dependsOn`, t),
  }
  const specialist = optionalTaskSpecialistAt(record.specialist, `${path}.specialist`, t)
  if (specialist !== undefined) task.specialist = specialist
  const workerId = optionalStringAt(record.workerId, `${path}.workerId`, t)
  if (workerId !== undefined) task.workerId = idAt(workerId, `${path}.workerId`, t)
  const result = optionalStringAt(record.result, `${path}.result`, t)
  if (result !== undefined) task.result = result
  const error = optionalStringAt(record.error, `${path}.error`, t)
  if (error !== undefined) task.error = error
  return task
}

/**
 * Validate one `state` payload at the wire boundary. Required fields are
 * enforced by name so a host/browser contract drift surfaces as an actionable
 * message instead of a panel that quietly claims every worker is a read-only
 * queued task.
 * @param value - parsed JSON of unknown shape.
 * @param t - translate function for diagnostics.
 * @returns the snapshot.
 * @throws {SnapshotError} naming the first invalid field.
 */
export function parseSnapshot(value: unknown, t: Translate = zhTranslate): TeamsSnapshot {
  const root = recordAt(value, 'body', t)
  const specialists = arrayAt(root.specialists, 'specialists', t)
    .map((item, index) => parseSpecialist(item, `specialists[${String(index)}]`, t))
  const coordinators = arrayAt(root.coordinators, 'coordinators', t)
    .map((item, index) => {
      const path = `coordinators[${String(index)}]`
      const record = recordAt(item, path, t)
      return {
        sessionId: idAt(record.sessionId, `${path}.sessionId`, t),
        label: stringAt(record.label, `${path}.label`, t),
      }
    })
  if (!('team' in root)) throw new SnapshotError('error.malformed', 'team', t('expected.team'), t)
  let team: TeamState | null = null
  if (root.team !== null) {
    const record = recordAt(root.team, 'team', t)
    const tasks = arrayAt(record.tasks, 'team.tasks', t)
      .map((item, index) => parseTask(item, `team.tasks[${String(index)}]`, t))
    team = {
      sessionId: idAt(record.sessionId, 'team.sessionId', t),
      maxActive: numberAt(record.maxActive, 'team.maxActive', t),
      // `paused` is optional in the published contract; when present it must be
      // a boolean, and a host that omits it schedules normally.
      paused: record.paused === undefined
        ? false
        : typeof record.paused === 'boolean'
          ? record.paused
          : (() => { throw new SnapshotError('error.malformed', 'team.paused', t('expected.boolean'), t) })(),
      tasks,
    }
  }
  const snapshot: TeamsSnapshot = { specialists, team, coordinators }
  if (root.maxLimit !== undefined) snapshot.maxLimit = numberAt(root.maxLimit, 'maxLimit', t)
  return snapshot
}

// ----------------------------------------------------------------- transport

/** A host refusal or transport failure with the text to show the user. */
export class TeamsApiError extends Error {
  override readonly name = 'TeamsApiError'

  /**
   * @param message - text for the panel's error line.
   * @param status - HTTP status, 0 for a transport failure.
   */
  constructor(message: string, readonly status: number = 0) {
    super(message)
  }
}

/** The two calls the panel makes. */
export interface TeamsApi {
  /**
   * Read one coordinator's team.
   * @param sessionId - coordinator session id.
   * @param signal - caller cancellation (poll cleanup).
   * @returns the parsed snapshot.
   */
  state(sessionId: string, signal?: AbortSignal): Promise<TeamsSnapshot>
  /**
   * Run one mutating action; the caller re-reads state afterwards.
   * @param sessionId - coordinator session id.
   * @param action - the action body.
   * @param signal - caller cancellation.
   * @returns the host's raw answer (shape is not relied upon).
   */
  action(sessionId: string, action: TeamsAction, signal?: AbortSignal): Promise<unknown>
  /**
   * Read the host's sidebar-launcher flag. A plugin row config does not reach
   * this half, so the host is the only channel.
   * @param signal - caller cancellation.
   * @returns whether this half should register its `sidebar.launcher` entry.
   */
  launcher(signal?: AbortSignal): Promise<boolean>
}

/** Error text for any thrown value ("AbortError" is not a user error). */
export function errorText(error: unknown, t: Translate = zhTranslate): string {
  if (error instanceof TeamsApiError) return error.message
  if (error instanceof DOMException && error.name === 'AbortError') return ''
  if (error instanceof Error) return error.message === '' ? t('error.request') : error.message
  return String(error)
}

/** Whether a rejection is the caller's own cancellation. */
export function isCanceled(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

async function readBody(response: Response, t: Translate): Promise<unknown> {
  const text = await response.text()
  if (text === '') return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    // A non-JSON answer comes from a route that is not mounted (the SPA
    // fallback HTML) or from a proxy — surface the status, not a parse error.
    return { error: t('error.nonJson', { status: response.status }) }
  }
}

async function request(path: string, init: RequestInit, t: Translate, signal?: AbortSignal): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${ENDPOINT}${path}`, {
      ...init,
      headers: { [TRUST_HEADER]: '1', ...init.headers },
      ...signal === undefined ? {} : { signal },
    })
  } catch (error) {
    if (isCanceled(error)) throw error
    throw new TeamsApiError(t('error.transport'))
  }
  const body = await readBody(response, t)
  if (!response.ok) {
    const message = isRecord(body) && typeof body.error === 'string' && body.error !== ''
      ? body.error
      : t('error.http', { status: response.status })
    throw new TeamsApiError(message, response.status)
  }
  if (isRecord(body) && typeof body.error === 'string') throw new TeamsApiError(body.error, response.status)
  return body
}

/**
 * Build the panel's host API client.
 * @param t - translate function for transport diagnostics.
 * @returns the `state`, `action`, and `launcher` calls.
 */
export function createTeamsApi(t: Translate = zhTranslate): TeamsApi {
  return {
    async state(sessionId, signal) {
      const body = await request(`/state?sessionId=${encodeURIComponent(sessionId)}`, { method: 'GET' }, t, signal)
      return parseSnapshot(body, t)
    },
    async action(sessionId, action, signal) {
      return request('/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, ...action }),
      }, t, signal)
    },
    async launcher(signal) {
      const body = await request('/launcher', { method: 'GET' }, t, signal)
      return isRecord(body) && body['showLauncher'] === false ? false : true
    },
  }
}

// ------------------------------------------------------- settings transport

/** One role row the Settings → Teams page renders. */
export interface RoleSkillView {
  id: string
  name: string
  mode: string
  hasSkill: boolean
  content: string
}

/** The Settings → Teams payload. */
export interface TeamsRolesView {
  roles: RoleSkillView[]
  pm: { hasSkill: boolean; content: string }
  settings: { ponytailLevel: string; autoRounds: number; maxActive: number; maxLimit: number }
}

/** The three settings-page calls. */
export interface TeamsSettingsApi {
  /** Read the roles, the PM skill, and the settings. */
  roles(signal?: AbortSignal): Promise<TeamsRolesView>
  /** Save one role skill document. */
  saveSkill(id: string, content: string): Promise<TeamsRolesView>
  /** Save the ponytail level and the auto-continue budget. */
  saveSettings(values: { ponytailLevel?: string; autoRounds?: number }): Promise<TeamsRolesView>
}

/**
 * Build the settings page's host API client.
 * @param t - translate function for transport diagnostics.
 * @returns the `roles`, `saveSkill`, and `saveSettings` calls.
 */
export function createTeamsSettingsApi(t: Translate = zhTranslate): TeamsSettingsApi {
  return {
    async roles(signal) {
      return toRolesView(await request('/roles', { method: 'GET' }, t, signal), t)
    },
    async saveSkill(id, content) {
      return toRolesView(await request('/role-skill', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, content }),
      }, t), t)
    },
    async saveSettings(values) {
      return toRolesView(await request('/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      }, t), t)
    },
  }
}

/** Narrow a raw roles answer; the page renders only what it asked for. */
function toRolesView(body: unknown, t: Translate): TeamsRolesView {
  if (!isRecord(body)) throw new TeamsApiError(t('settings.error'))
  const roles = Array.isArray(body.roles) ? body.roles : []
  const pm = isRecord(body.pm) ? body.pm : {}
  const settings = isRecord(body.settings) ? body.settings : {}
  return {
    roles: roles.filter(isRecord).map(entry => ({
      id: typeof entry.id === 'string' ? entry.id : '',
      name: typeof entry.name === 'string' ? entry.name : '',
      mode: typeof entry.mode === 'string' ? entry.mode : 'read',
      hasSkill: entry.hasSkill === true,
      content: typeof entry.content === 'string' ? entry.content : '',
    })),
    pm: { hasSkill: pm.hasSkill === true, content: typeof pm.content === 'string' ? pm.content : '' },
    settings: {
      ponytailLevel: typeof settings.ponytailLevel === 'string' ? settings.ponytailLevel : 'full',
      autoRounds: typeof settings.autoRounds === 'number' ? settings.autoRounds : 8,
      maxActive: typeof settings.maxActive === 'number' ? settings.maxActive : 0,
      maxLimit: typeof settings.maxLimit === 'number' ? settings.maxLimit : 0,
    },
  }
}

// -------------------------------------------------------------- derivations

/** Presentation of one status value. */
export interface StatusMeta {
  dot: 'done' | 'warning' | 'ongoing' | 'error'
  /** Whether the host engine is currently spending a worker slot on it. */
  active: boolean
  /** Whether the engine accepts `retry` on it. */
  settled: boolean
}

/**
 * Status semantics, including a documented fall-through for a status this
 * build does not know (the host may add one before the browser half ships).
 * @param status - raw status value.
 * @returns dot semantics and the lifecycle flags.
 */
export function statusMeta(status: string): StatusMeta {
  switch (status) {
    case 'queued': return { dot: 'warning', active: false, settled: false }
    case 'starting': return { dot: 'ongoing', active: true, settled: false }
    case 'working': return { dot: 'ongoing', active: true, settled: false }
    case 'canceling': return { dot: 'warning', active: true, settled: false }
    case 'done': return { dot: 'done', active: false, settled: true }
    case 'failed': return { dot: 'error', active: false, settled: true }
    case 'canceled': return { dot: 'warning', active: false, settled: true }
    case 'blocked': return { dot: 'error', active: false, settled: true }
    default: return { dot: 'warning', active: false, settled: false }
  }
}

/**
 * Localised label for one status.
 * @param status - raw status value.
 * @param t - translate function.
 * @returns the known label, or the raw literal for a status this build does not know.
 */
export function statusText(status: string, t: Translate): string {
  switch (status) {
    case 'queued': return t('status.queued')
    case 'starting': return t('status.starting')
    case 'working': return t('status.working')
    case 'canceling': return t('status.canceling')
    case 'done': return t('status.done')
    case 'failed': return t('status.failed')
    case 'canceled': return t('status.canceled')
    case 'blocked': return t('status.blocked')
    default: return status === '' ? t('status.unknown') : status
  }
}

/** Task counts for the panel header. */
export interface TeamSummary {
  total: number
  active: number
  queued: number
  settled: number
  failed: number
}

/**
 * Summarise one team's tasks.
 * @param team - the team, or null before the first assignment.
 * @returns counts by lifecycle group.
 */
export function summarise(team: TeamState | null): TeamSummary {
  const summary: TeamSummary = { total: 0, active: 0, queued: 0, settled: 0, failed: 0 }
  if (team === null) return summary
  for (const task of team.tasks) {
    const meta = statusMeta(task.status)
    summary.total += 1
    if (meta.active) summary.active += 1
    else if (task.status === 'queued') summary.queued += 1
    else summary.settled += 1
    if (meta.dot === 'error') summary.failed += 1
  }
  return summary
}

/**
 * Split a free-text reservation field into file scopes.
 * @param text - newline- and/or comma-separated scopes as typed.
 * @returns trimmed, de-duplicated, non-empty scopes.
 */
export function parseList(text: string): string[] {
  const parts = text.split(/[\n,]/).map(part => part.trim().replace(/\/+$/, '')).filter(part => part !== '')
  return [...new Set(parts)]
}

/** Local state of the assign form. */
export interface AssignDraft {
  specialistId: string
  title: string
  prompt: string
  /** Raw text; parsed by {@link parseList} on submit so the user's typing survives polls. */
  files: string
  dependsOn: string[]
}

/**
 * Pre-check an assignment before the host sees it, so the panel explains the
 * rule instead of surfacing a bare rejection.
 * @param draft - current form values.
 * @param specialists - known roles.
 * @param t - translate function for the message.
 * @returns the message to show, or null when the draft is submittable.
 */
export function validateAssign(
  draft: AssignDraft,
  specialists: readonly Specialist[],
  t: Translate = zhTranslate,
): string | null {
  const specialist = specialists.find(item => item.id === draft.specialistId)
  if (specialist === undefined) return t('assign.errSpecialist')
  if (draft.title.trim() === '') return t('assign.errTitle')
  if (draft.prompt.trim() === '') return t('assign.errPrompt')
  if (specialist.mode === 'write' && parseList(draft.files).length === 0) return t('assign.errWriteFiles')
  return null
}

/** Where a worker conversation can be opened from, and what that requires first. */
export interface WorkerOpenPlan {
  address: SubagentAddress
  /**
   * Whether the caller must refresh the coordinator's child catalog before
   * `openSubagent`, because the address was reconstructed rather than retained
   * from a catalog: `selectSubagent` refuses an address the catalog cannot
   * confirm.
   */
  refreshParent: boolean
}

/**
 * Decide how to open one worker conversation.
 *
 * Team workers are continuable children of the coordinator, so the address is
 * `{ parentSessionId, childSessionId, mode: 'continuable' }`. A retained
 * catalog address wins when the runtime already discovered one; otherwise the
 * caller refreshes the coordinator's catalog first, because `openSubagent`
 * is strict about catalog authority (and `open(childId)` alone rejects an
 * unlisted child).
 * @param parentSessionId - the owning coordinator session.
 * @param childSessionId - the worker session.
 * @param retained - an address the runtime already retained for this child.
 * @returns the address to open and whether a catalog refresh is required first.
 */
export function workerOpenPlan(
  parentSessionId: string,
  childSessionId: string,
  retained: SubagentAddress | undefined,
): WorkerOpenPlan {
  if (retained !== undefined) return { address: retained, refreshParent: false }
  return {
    address: { parentSessionId, childSessionId, mode: 'continuable' },
    refreshParent: true,
  }
}

/** One coordinator's resolved part of a retained `state` answer. */
export interface ScopedTeam {
  /** That coordinator's team, or null while none has been read for it. */
  team: TeamState | null
  /** True when the retained answer belongs to a different coordinator (mid-switch). */
  stale: boolean
}

/**
 * Resolve the coordinator-scoped part of a retained `state` answer.
 *
 * A `state` answer is one coordinator's projection, and the panel keeps the
 * previous answer while the next poll is in flight. Rendering that team under
 * a different coordinator would show tasks whose ids the new coordinator does
 * not know — and whose buttons would post the new coordinator id with old task
 * ids. A `team: null` answer carries no session id of its own, so the answer is
 * attributed to the coordinator it was FETCHED for (`loadedFor`): otherwise a
 * switch would read the old "no assignments yet" as the new coordinator's.
 *
 * The coordinator-wide parts of the answer (specialist roster, coordinator
 * list, `maxLimit`) are not scoped and stay usable through a switch.
 * @param snapshot - the retained answer, possibly for another coordinator.
 * @param coordinatorId - the coordinator currently selected.
 * @param loadedFor - the coordinator that answer was fetched for.
 * @returns that coordinator's team plus whether the answer is stale.
 */
export function scopedTeam(
  snapshot: TeamsSnapshot | null,
  coordinatorId: string | undefined,
  loadedFor: string | undefined,
): ScopedTeam {
  if (snapshot === null || coordinatorId === undefined) return { team: null, stale: false }
  if (loadedFor !== coordinatorId) return { team: null, stale: true }
  const team = snapshot.team
  if (team === null) return { team: null, stale: false }
  // Defensive: a host echoing a different session id must not be rendered.
  if (team.sessionId !== coordinatorId) return { team: null, stale: true }
  return { team, stale: false }
}

/**
 * Whether an in-flight operation still owns the panel.
 *
 * Actions are posted against the coordinator captured at click time; a switch
 * invalidates them so a late resolution cannot close a form, clear a draft, or
 * surface an error on a coordinator the user is now looking at.
 * @param scope - the coordinator the operation was started for.
 * @param coordinatorId - the coordinator currently selected.
 * @param epoch - the operation's generation.
 * @param currentEpoch - the panel's current generation.
 * @returns true only while both identities still match.
 */
export function operationStillApplies(
  scope: string | undefined,
  coordinatorId: string | undefined,
  epoch: number,
  currentEpoch: number,
): boolean {
  return scope !== undefined && scope === coordinatorId && epoch === currentEpoch
}

// ------------------------------------------------------------------ styling

const S: Record<string, React.CSSProperties> = {
  // The launcher shares the sidebar's regionArea with the Brain entry, which
  // reserves the column's inline inset on its own wrapper. Ours must do the
  // same or the wide button overhangs Brain's right edge.
  section: {
    flex: 'none', display: 'flex', flexDirection: 'column', position: 'relative',
    paddingRight: 'var(--dsh-sidebar-inline-padding)', marginBottom: 8,
  },
  sectionRail: { alignItems: 'center', paddingRight: 0 },
  settings: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 760 },
  modeTag: { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 11, marginLeft: 6 },
  buttonDots: { display: 'inline-flex', alignItems: 'center', gap: 3, flex: 'none' },
  buttonDot: { width: 5, height: 5, borderRadius: '50%', background: 'var(--dsw-alias-border-l3, #ccc)' },
  buttonDotOn: { background: 'var(--dsw-alias-state-success-primary, #2a2)' },
  buttonDotWarn: { background: 'var(--dsw-alias-state-error-primary, #d33)' },
  button: {
    display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', font: 'inherit',
    border: '1px solid var(--dsw-alias-border-l2, #e5e5e5)',
    background: 'var(--dsw-alias-bg-module-platform, transparent)',
    color: 'var(--dsw-alias-label-primary, currentColor)',
  },
  buttonWide: { width: '100%', height: 36, padding: '0 12px', borderRadius: 10, fontSize: 14, fontWeight: 500 },
  buttonRail: { justifyContent: 'center', width: 36, height: 36, padding: 0, borderRadius: 10 },
  buttonIcon: { flex: 'none', color: 'var(--dsw-alias-state-business-primary, currentColor)' },
  buttonLabel: { flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', textAlign: 'left' },
  buttonCount: {
    flex: 'none', minWidth: 20, padding: '0 6px', borderRadius: 10, fontSize: 11, fontWeight: 600,
    lineHeight: '18px', textAlign: 'center',
    background: 'var(--dsw-alias-state-business-tertiary, rgba(127,127,127,0.16))',
    color: 'var(--dsw-alias-label-primary-bluish, inherit)',
  },
  panel: {
    position: 'fixed', zIndex: 150, display: 'flex', flexDirection: 'column',
    width: PANEL_WIDTH, maxWidth: `calc(100vw - ${String(PANEL_VIEWPORT_PAD * 2)}px)`,
    overflow: 'hidden', borderRadius: 14, fontSize: 13,
    border: '1px solid var(--dsw-alias-border-l2, #e5e5e5)',
    background: 'var(--dsw-alias-bg-layer-1, #fff)',
    color: 'var(--dsw-alias-label-primary, inherit)',
    boxShadow: '0 12px 32px var(--dsw-alias-bg-mask-drop, rgba(0,0,0,0.18))',
  },
  header: {
    flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
    borderBottom: '1px solid var(--dsw-alias-border-l1, #eee)',
  },
  headerTitle: { flex: 1, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, fontWeight: 600 },
  body: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, padding: 12 },
  footer: {
    flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
    borderTop: '1px solid var(--dsw-alias-border-l1, #eee)',
    color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 11,
  },
  block: { display: 'flex', flexDirection: 'column', gap: 8 },
  blockTitle: {
    display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, fontWeight: 600, letterSpacing: '0.04em',
    textTransform: 'uppercase', color: 'var(--dsw-alias-label-tertiary, #888)',
  },
  empty: { padding: '10px 12px', borderRadius: 10, color: 'var(--dsw-alias-label-tertiary, #888)',
    border: '1px dashed var(--dsw-alias-border-l3, #ddd)' },
  row: {
    display: 'flex', flexDirection: 'column', gap: 6, padding: '9px 10px', borderRadius: 10,
    border: '1px solid var(--dsw-alias-border-l2, #e5e5e5)',
    background: 'var(--dsw-alias-bg-layer-2, transparent)',
  },
  rowTop: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  rowTitle: { flex: 1, minWidth: 0, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowMeta: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 11 },
  rowActions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  error: {
    display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', borderRadius: 10, fontSize: 12,
    border: '1px solid var(--dsw-alias-state-error-primary, #d33)',
    background: 'var(--dsw-alias-bg-layer-2, rgba(211,51,51,0.06))',
    color: 'var(--dsw-alias-state-error-primary, #d33)',
  },
  hint: { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 11 },
  paused: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 10, fontSize: 12,
    border: '1px solid var(--dsw-alias-state-warn-primary, #c90)',
    background: 'var(--dsw-alias-bg-layer-2, rgba(204,153,0,0.08))',
    color: 'var(--dsw-alias-label-primary, inherit)',
  },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  fieldLabel: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #555)' },
  textarea: {
    width: '100%', minHeight: 64, boxSizing: 'border-box', padding: '7px 9px', borderRadius: 8, resize: 'vertical',
    font: 'inherit', color: 'inherit', background: 'var(--dsw-alias-bg-layer-2, transparent)',
    border: '1px solid var(--dsw-alias-border-l2, #e5e5e5)',
  },
  select: {
    width: '100%', height: 30, padding: '0 8px', borderRadius: 8, font: 'inherit', color: 'inherit',
    background: 'var(--dsw-alias-bg-layer-2, transparent)',
    border: '1px solid var(--dsw-alias-border-l2, #e5e5e5)',
  },
  inline: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  deps: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 108, overflowY: 'auto' },
  depRow: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary, #555)' },
  orbit: {
    position: 'fixed', zIndex: 150, display: 'flex', flexDirection: 'column', gap: 8,
    width: 300, maxWidth: 'calc(100vw - 16px)', overflow: 'hidden', borderRadius: 14, fontSize: 13,
    padding: 12, boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l2, #e5e5e5)',
    background: 'var(--dsw-alias-bg-layer-1, #fff)',
    color: 'var(--dsw-alias-label-primary, inherit)',
    boxShadow: '0 12px 32px var(--dsw-alias-bg-mask-drop, rgba(0,0,0,0.18))',
  },
  orbitHead: { display: 'flex', alignItems: 'center', gap: 8 },
  orbitTitle: { fontWeight: 600 },
  orbitLive: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #888)' },
  orbitLiveDot: { width: 5, height: 5, borderRadius: '50%', background: 'var(--dsw-alias-state-success-primary, #2a2)', animation: 'dshteam-breathe 1.6s ease-in-out infinite' },
  orbitSummary: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #888)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  orbitError: {
    display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', borderRadius: 10, fontSize: 12,
    border: '1px solid var(--dsw-alias-state-error-primary, #d33)',
    background: 'var(--dsw-alias-bg-layer-2, transparent)',
    color: 'var(--dsw-alias-state-error-primary, #d33)',
  },
  orbitWrap: {
    position: 'relative', height: 236, borderRadius: 12, overflow: 'hidden',
    background: 'radial-gradient(circle at 50% 50%, var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.04)), transparent 70%)',
  },
  orbitWrapDone: { boxShadow: 'inset 0 0 48px var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.08))' },
  orbitRing: {
    position: 'absolute', left: '50%', top: '50%', width: 168, height: 168, margin: '-84px 0 0 -84px',
    borderRadius: '50%', border: '1px dashed var(--dsw-alias-border-l2, #ccc)',
  },
  orbitCore: {
    position: 'absolute', left: '50%', top: '50%', width: 84, height: 84, margin: '-42px 0 0 -42px',
    borderRadius: '50%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    border: '1px solid var(--dsw-alias-border-l2, #ccc)',
    background: 'var(--dsw-alias-bg-layer-1, #fff)',
    boxShadow: '0 0 0 6px var(--dsw-alias-bg-layer-2, transparent)',
  },
  orbitPm: { fontSize: 8.5, letterSpacing: '0.16em', color: 'var(--dsw-alias-label-tertiary, #888)' },
  orbitCoreBig: { fontSize: 22, fontWeight: 650, lineHeight: 1, fontVariantNumeric: 'tabular-nums' },
  orbitCoreSmall: { fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--dsw-alias-label-tertiary, #888)', marginTop: 2 },
  orbitNode: {
    position: 'absolute', left: '50%', top: '50%', width: 54, height: 54, borderRadius: '50%',
    border: '1px solid var(--dsw-alias-border-l2, #ccc)',
    background: 'var(--dsw-alias-bg-layer-1, #fff)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
  },
  orbitInitial: { fontSize: 15, fontWeight: 650 },
  orbitLabel: {
    position: 'absolute', top: 'calc(100% + 4px)', left: '50%', transform: 'translateX(-50%)',
    display: 'flex', alignItems: 'center', gap: 4, fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase',
    color: 'var(--dsw-alias-label-tertiary, #888)', whiteSpace: 'nowrap', pointerEvents: 'none',
  },
  orbitLabelDot: { width: 4, height: 4, borderRadius: '50%', background: 'var(--dsw-alias-border-l3, #ccc)' },
  orbitLabelDotOn: { background: 'var(--dsw-alias-state-success-primary, #2a2)' },
  orbitLabelDotWarn: { background: 'var(--dsw-alias-state-error-primary, #d33)' },
  orbitLabelDotDone: { background: 'var(--dsw-alias-state-business-primary, #38c)' },
  orbitFoot: { display: 'flex', alignItems: 'center', gap: 8, paddingTop: 4, color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 11 },
}

// ------------------------------------------------------------ small helpers

function clockOf(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
}

/**
 * Fixed-position panel geometry anchored to the launcher button, recomputed on
 * open, resize, and scroll. `position: fixed` is what lets the panel escape the
 * sidebar column's `overflow: hidden`.
 * @param anchor - the launcher button element.
 * @param open - whether the panel is showing.
 * @returns the panel's inline style, or undefined before the first measure.
 */
function useAnchoredStyle(anchor: { readonly current: HTMLElement | null }, open: boolean): React.CSSProperties | undefined {
  const [style, setStyle] = React.useState<React.CSSProperties | undefined>(undefined)
  React.useEffect(() => {
    if (!open) return
    const measure = (): void => {
      const rect = anchor.current?.getBoundingClientRect()
      if (rect === undefined) return
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const width = Math.min(PANEL_WIDTH, viewportWidth - PANEL_VIEWPORT_PAD * 2)
      const toRight = rect.right + PANEL_GAP
      const left = toRight + width <= viewportWidth - PANEL_VIEWPORT_PAD
        ? toRight
        : Math.max(PANEL_VIEWPORT_PAD, rect.left - width - PANEL_GAP)
      const top = Math.min(Math.max(rect.top, PANEL_VIEWPORT_PAD), Math.max(PANEL_VIEWPORT_PAD, viewportHeight - 200))
      setStyle({ left, top, width, maxHeight: Math.max(200, viewportHeight - top - PANEL_VIEWPORT_PAD) })
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [anchor, open])
  return style
}

// ---------------------------------------------------------------- components

/** Injected business face (from the plugin's `apply` closure). */
export interface TeamsInjected {
  api: TeamsApi
  /** Open an ordinary (coordinator) session; rejects when the runtime cannot resolve it. */
  openSession: (sessionId: string) => Promise<void>
  /**
   * Open a worker conversation as a subagent child of its coordinator, which
   * is the only navigation the runtime accepts for a catalog-addressed child.
   */
  openWorker: (parentSessionId: string, childSessionId: string) => Promise<void>
}

/** Props delivered by the `sidebar.launcher` slot. */
export interface TeamsLauncherProps extends TeamsInjected {
  wide: boolean
  expandSidebar: () => void
  useSessions: (selector: (state: unknown) => unknown) => unknown
  /** Framework-injected translate seat; absent when rendered without the locale face. */
  t?: Translate
}

/** The panel's own local form state, kept out of the poll. */
interface Drafts {
  assign: AssignDraft
  configure: string | null
  message: Record<string, string>
  messageOpen: string | null
  specialist: Specialist
  specialistEditing: boolean
}

const EMPTY_SPECIALIST: Specialist = { id: '', name: '', instructions: '', mode: 'read' }

/** One task row. */
function TaskRow(props: {
  task: TeamTask
  specialists: readonly Specialist[]
  workerRunning: boolean | undefined
  messageDraft: string
  messageOpen: boolean
  busy: boolean
  t: Translate
  onOpenWorker: (workerId: string) => void
  onToggleMessage: () => void
  onMessageChange: (text: string) => void
  onSendMessage: () => void
  onCancel: () => void
  onRetry: () => void
}) {
  const { task, specialists, workerRunning, messageDraft, messageOpen, busy, t } = props
  const meta = statusMeta(task.status)
  // The assignment-time role copy wins: a specialist renamed, re-moded, or
  // deleted since must not relabel a worker that already ran under it. The
  // live roster is the fallback for tasks stored before the host sent the copy,
  // and the raw id is the last resort.
  const roster = specialists.find(item => item.id === task.specialistId)
  const roleName = task.specialist?.name ?? roster?.name ?? task.specialistId
  const roleMode = task.specialist?.mode ?? roster?.mode
  const canOpen = task.workerId !== undefined
  return (
    <div style={S.row}>
      <div style={S.rowTop}>
        <StateDot state={meta.dot} />
        <span style={S.rowTitle} title={task.title}>{task.title}</span>
        <Pill>{statusText(task.status, t)}</Pill>
      </div>
      <div style={S.rowMeta}>
        <span>{roleMode === undefined
          ? roleName
          : `${roleName} · ${roleMode === 'write' ? t('role.write') : t('role.read')}`}</span>
        {task.files.length > 0 && <span>{t('task.files', { files: task.files.join(', ') })}</span>}
        {task.dependsOn.length > 0 && <span>{t('task.deps', { count: task.dependsOn.length })}</span>}
        {canOpen && workerRunning === true && <span>{t('task.running')}</span>}
      </div>
      {task.error !== undefined && task.error !== '' && (
        <div style={{ ...S.hint, color: 'var(--dsw-alias-state-error-primary, #d33)' }}>{task.error}</div>
      )}
      {task.result !== undefined && task.result !== '' && (
        <div style={S.hint}>{task.result.length > 320 ? `${task.result.slice(0, 320)}…` : task.result}</div>
      )}
      <div style={S.rowActions}>
        <Button
          size="sm"
          disabled={!canOpen}
          title={t('task.openHint')}
          onClick={() => { if (task.workerId !== undefined) props.onOpenWorker(task.workerId) }}
        >
          {t('task.open')}
        </Button>
        <Button size="sm" disabled={!canOpen || meta.active} onClick={props.onToggleMessage}>
          {messageOpen ? t('task.messageClose') : t('task.message')}
        </Button>
        {meta.active || task.status === 'queued'
          ? <Button size="sm" disabled={busy} icon={<IconStopFill16 />} onClick={props.onCancel}>{t('task.cancel')}</Button>
          : <Button size="sm" disabled={busy || !meta.settled} icon={<IconPlayOutline16 />} onClick={props.onRetry}>{t('task.retry')}</Button>}
      </div>
      {messageOpen && (
        <div style={S.field}>
          <textarea
            style={S.textarea}
            value={messageDraft}
            placeholder={t('message.placeholder')}
            disabled={busy}
            onChange={(event) => { props.onMessageChange(event.target.value) }}
          />
          <div style={S.inline}>
            <Button size="sm" variant="primary" disabled={busy || messageDraft.trim() === ''} icon={<IconSendOutline16 />} onClick={props.onSendMessage}>
              {t('message.send')}
            </Button>
            <span style={S.hint}>{meta.active ? t('message.hintBusy') : t('message.hintIdle')}</span>
          </div>
        </div>
      )}
    </div>
  )
}

/** One error line. `source` decides whether the next successful poll clears it. */
interface PanelError {
  text: string
  /** `poll` — reading state failed (a later success clears it); `action` — a command was refused (it stays until dismissed or the next command). */
  source: 'poll' | 'action'
}

/** The status panel. Exported so a harness can render it without the shell. */
export function TeamsPanel(props: {
  snapshot: TeamsSnapshot | null
  /** The coordinator the retained snapshot was fetched for. */
  snapshotFor: string | undefined
  error: PanelError | null
  busy: boolean
  loadedAt: Date | null
  /** Whether the poll timer is actually running (the panel is open and the tab is visible). */
  pollingVisible?: boolean
  coordinatorId: string | undefined
  coordinatorLabel: string
  currentSessionId: string | undefined
  sessionsById: Record<string, { running?: boolean } | undefined> | undefined
  drafts: Drafts
  t?: Translate
  onDrafts: (update: (drafts: Drafts) => Drafts) => void
  onSelectCoordinator: (sessionId: string) => void
  onRefresh: () => void
  onOpenSession: (sessionId: string) => void
  /** Open one worker conversation (its coordinator is the selected coordinator). */
  onOpenWorker: (workerId: string) => void
  /** Runs one action; `onAccepted` fires only after the host accepted it. */
  onAction: (action: TeamsAction, onAccepted?: () => void) => void
  onDismissError: () => void
  onClose: () => void
  style: React.CSSProperties | undefined
  /** The panel element itself (`RefObject<HTMLDivElement>`, React 18's exact `ref` shape). */
  rootRef: React.RefObject<HTMLDivElement>
}) {
  const t = props.t ?? zhTranslate
  const { snapshot, drafts, busy, coordinatorId } = props
  // The snapshot is one coordinator's answer. After the picker switches it
  // still holds the PREVIOUS coordinator's team until the next poll lands;
  // rendering that under the new coordinator would show stale tasks and let
  // their buttons post the new coordinator id with old task ids. Only the
  // coordinator-wide parts (roster, coordinator list, maxLimit) stay usable.
  const scoped = scopedTeam(snapshot, coordinatorId, props.snapshotFor)
  const team = scoped.team
  /** The retained answer belongs to another coordinator: mid-switch. */
  const switching = scoped.stale
  const specialists = snapshot?.specialists ?? []
  const summary = summarise(team)
  const tasks = team?.tasks ?? []
  // The first role is the default until the user picks one; deriving it here
  // (instead of an effect) keeps the first paint submittable and adds no render.
  const defaultSpecialistId = specialists[0]?.id ?? ''
  const assignDraft = drafts.assign.specialistId === '' && defaultSpecialistId !== ''
    ? { ...drafts.assign, specialistId: defaultSpecialistId }
    : drafts.assign
  const assignError = snapshot === null || coordinatorId === undefined
    ? null
    : validateAssign(assignDraft, specialists, t)

  // Focus the panel so Escape and tab order start inside it.
  React.useEffect(() => {
    props.rootRef.current?.focus()
  }, [props.rootRef])

  const limitLabel = team === null
    ? ''
    : t('tasks.limit', {
      value: snapshot?.maxLimit === undefined
        ? team.maxActive
        : `${String(team.maxActive)} / ${String(snapshot.maxLimit)}`,
    })

  return (
    <div
      ref={props.rootRef}
      style={{ ...S.panel, ...props.style }}
      role="dialog"
      aria-label={t('panel.title')}
      tabIndex={-1}
      onKeyDown={(event) => { if (event.key === 'Escape') props.onClose() }}
    >
      <div style={S.header}>
        <div style={S.headerTitle}>
          <span style={S.buttonIcon}><IconUserOutline16 /></span>
          <span>{t('panel.title')}</span>
          <span style={S.hint}>
            {summary.active > 0
              ? t('panel.summaryActive', { count: summary.active })
              : summary.queued > 0
                ? t('panel.summaryQueued', { count: summary.queued })
                : t('panel.summaryTotal', { count: summary.total })}
          </span>
        </div>
        <Button size="sm" variant="ghost" icon={<IconRefreshOutline16 />} disabled={busy} onClick={props.onRefresh}>
          {t('panel.refresh')}
        </Button>
        <Button size="sm" variant="ghost" icon={<IconCloseOutline16 />} onClick={props.onClose} aria-label={t('panel.close')} />
      </div>

      <div style={S.body}>
        <div style={S.block}>
          <div style={S.inline}>
            <span style={S.fieldLabel}>{t('coordinator.label')}</span>
            <select
              style={{ ...S.select, flex: 1, maxWidth: 260 }}
              value={coordinatorId ?? ''}
              onChange={(event) => { props.onSelectCoordinator(event.target.value) }}
            >
              {props.currentSessionId !== undefined
                && !(snapshot?.coordinators ?? []).some(row => row.sessionId === props.currentSessionId)
                && (
                  <option value={props.currentSessionId}>{t('coordinator.current')}</option>
                )}
              {(snapshot?.coordinators ?? []).map(row => (
                <option key={row.sessionId} value={row.sessionId}>{row.label}</option>
              ))}
              {coordinatorId !== undefined
                && !(snapshot?.coordinators ?? []).some(row => row.sessionId === coordinatorId)
                && coordinatorId !== props.currentSessionId
                && <option value={coordinatorId}>{coordinatorId}</option>}
            </select>
            <Button size="sm" disabled={coordinatorId === undefined} onClick={() => { if (coordinatorId !== undefined) props.onOpenSession(coordinatorId) }}>
              {t('coordinator.open')}
            </Button>
          </div>
          <div style={S.hint}>{props.coordinatorLabel}</div>
        </div>

        {props.error !== null && (
          <div style={S.error} role="alert">
            <span style={{ flex: 1 }}>{props.error.text}</span>
            {props.error.source === 'poll' && (
              <Button size="sm" variant="ghost" onClick={props.onRefresh}>{t('panel.retry')}</Button>
            )}
            <Button size="sm" variant="ghost" onClick={props.onDismissError} aria-label={t('panel.dismissError')}>
              <IconCloseOutline16 />
            </Button>
          </div>
        )}

        {team?.paused === true && (
          <div style={S.paused} role="status">
            <span style={{ flex: 1 }}>{t('paused.banner')}</span>
            <Button size="sm" variant="primary" disabled={busy} icon={<IconPlayOutline16 />} onClick={() => { props.onAction({ action: 'resume' }) }}>
              {t('paused.resume')}
            </Button>
          </div>
        )}

        <div style={S.block}>
          <div style={S.blockTitle}>
            <IconChecklistOutline14 />
            <span>{t('tasks.title')}</span>
            <span style={{ flex: 1 }} />
            {team !== null && <span style={S.hint}>{limitLabel}</span>}
          </div>
          {coordinatorId === undefined
            ? <div style={S.empty}>{t('tasks.openSession')}</div>
            : snapshot === null || switching
              ? <div style={S.empty}>{props.error === null ? t(switching ? 'tasks.switching' : 'tasks.loading') : t('tasks.unavailable')}</div>
              : tasks.length === 0
                ? <div style={S.empty}>{t('tasks.empty')}</div>
                : tasks.map(task => (
                <TaskRow
                  key={task.id}
                  task={task}
                  specialists={specialists}
                  workerRunning={task.workerId === undefined ? undefined : props.sessionsById?.[task.workerId]?.running}
                  messageDraft={drafts.message[task.id] ?? ''}
                  messageOpen={drafts.messageOpen === task.id}
                  busy={busy}
                  t={t}
                  onOpenWorker={(workerId) => { props.onOpenWorker(workerId) }}
                  onToggleMessage={() => { props.onDrafts(current => ({ ...current, messageOpen: current.messageOpen === task.id ? null : task.id })) }}
                  onMessageChange={(text) => { props.onDrafts(current => ({ ...current, message: { ...current.message, [task.id]: text } })) }}
                  onSendMessage={() => {
                    const message = (drafts.message[task.id] ?? '').trim()
                    if (message === '') return
                    // The draft survives a rejection; only an accepted send clears it.
                    props.onAction({ action: 'message', taskId: task.id, message }, () => {
                      props.onDrafts(current => ({
                        ...current,
                        message: { ...current.message, [task.id]: '' },
                        messageOpen: null,
                      }))
                    })
                  }}
                  onCancel={() => { props.onAction({ action: 'cancel', taskId: task.id }) }}
                  onRetry={() => { props.onAction({ action: 'retry', taskId: task.id }) }}
                />
              ))}
        </div>

        <div style={S.block}>
          <div style={S.blockTitle}>
            <IconPlusOutline16 />
            <span>{t('assign.title')}</span>
          </div>
          <div style={S.field}>
            <span style={S.fieldLabel}>{t('assign.specialist')}</span>
            <select
              style={S.select}
              value={assignDraft.specialistId}
              disabled={specialists.length === 0}
              onChange={(event) => {
                const specialistId = event.target.value
                props.onDrafts(current => ({ ...current, assign: { ...current.assign, specialistId } }))
              }}
            >
              {specialists.length === 0 && <option value="">{t('assign.noSpecialists')}</option>}
              {specialists.map(item => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.mode === 'write' ? t('role.write') : t('role.read')})
                </option>
              ))}
            </select>
          </div>
          <div style={S.field}>
            <span style={S.fieldLabel}>{t('assign.taskTitle')}</span>
            <Input
              value={drafts.assign.title}
              placeholder={t('assign.taskTitlePlaceholder')}
              onChange={(event) => {
                const title = event.target.value
                props.onDrafts(current => ({ ...current, assign: { ...current.assign, title } }))
              }}
            />
          </div>
          <div style={S.field}>
            <span style={S.fieldLabel}>{t('assign.prompt')}</span>
            <textarea
              style={S.textarea}
              value={drafts.assign.prompt}
              placeholder={t('assign.promptPlaceholder')}
              onChange={(event) => {
                const prompt = event.target.value
                props.onDrafts(current => ({ ...current, assign: { ...current.assign, prompt } }))
              }}
            />
          </div>
          <div style={S.field}>
            <span style={S.fieldLabel}>{t('assign.files')}</span>
            <textarea
              style={{ ...S.textarea, minHeight: 44 }}
              value={drafts.assign.files}
              placeholder={t('assign.filesPlaceholder')}
              onChange={(event) => {
                const files = event.target.value
                props.onDrafts(current => ({ ...current, assign: { ...current.assign, files } }))
              }}
            />
          </div>
          {tasks.length > 0 && (
            <div style={S.field}>
              <span style={S.fieldLabel}>{t('assign.depends')}</span>
              <div style={S.deps}>
                {tasks.map(task => (
                  <label key={task.id} style={S.depRow}>
                    <input
                      type="checkbox"
                      checked={drafts.assign.dependsOn.includes(task.id)}
                      onChange={(event) => {
                        const checked = event.target.checked
                        props.onDrafts(current => ({
                          ...current,
                          assign: {
                            ...current.assign,
                            dependsOn: checked
                              ? [...current.assign.dependsOn, task.id]
                              : current.assign.dependsOn.filter(id => id !== task.id),
                          },
                        }))
                      }}
                    />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</span>
                    <span style={S.hint}>{statusText(task.status, t)}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          {assignError !== null && <div style={S.hint}>{assignError}</div>}
          <div style={S.inline}>
            <Button
              size="sm"
              variant="primary"
              disabled={busy || coordinatorId === undefined || assignError !== null}
              icon={<IconPlayOutline16 />}
              onClick={() => {
                props.onAction({
                  action: 'assign',
                  specialistId: assignDraft.specialistId,
                  title: assignDraft.title.trim(),
                  prompt: assignDraft.prompt.trim(),
                  files: parseList(assignDraft.files),
                  dependsOn: assignDraft.dependsOn,
                }, () => {
                  // Clear only what was accepted; a rejection keeps the draft.
                  props.onDrafts(current => ({
                    ...current,
                    assign: { ...current.assign, title: '', prompt: '', files: '', dependsOn: [] },
                  }))
                })
              }}
            >
              {t('assign.submit')}
            </Button>
            <span style={S.hint}>{t('assign.hint')}</span>
          </div>
        </div>

        <div style={S.block}>
          <div style={S.blockTitle}>
            <IconUserOutline16 />
            <span>{t('configure.title')}</span>
          </div>
          <div style={S.inline}>
            <Input
              style={{ width: 88 }}
              inputMode="numeric"
              // A team that does not exist yet has NO known limit: the deployment
              // default is host-side configuration (not necessarily 1), so the
              // field says "host default" instead of claiming a number. Only a
              // team the host already reported can show its own maxActive.
              value={drafts.configure ?? (team === null ? '' : String(team.maxActive))}
              placeholder={team === null ? t('configure.hostDefault') : String(team.maxActive)}
              onChange={(event) => {
                const configure = event.target.value
                props.onDrafts(current => ({ ...current, configure }))
              }}
            />
            <Button
              size="sm"
              disabled={busy || coordinatorId === undefined || drafts.configure === null
                || !/^\d+$/.test(drafts.configure) || !Number.isSafeInteger(Number(drafts.configure))
                || Number(drafts.configure) < 1
                || (snapshot?.maxLimit !== undefined && Number(drafts.configure) > snapshot.maxLimit)}
              icon={<IconCheckOutline14 />}
              onClick={() => {
                const maxActive = Number(drafts.configure)
                props.onAction({ action: 'configure', maxActive }, () => {
                  props.onDrafts(current => ({ ...current, configure: null }))
                })
              }}
            >
              {t('configure.save')}
            </Button>
            <span style={S.hint}>{t('configure.hint')}</span>
          </div>
        </div>

        <div style={S.block}>
          <div style={S.blockTitle}>
            <IconChecklistOutline14 />
            <span>{t('specialists.title')}</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {specialists.map(item => (
              <Button
                key={item.id}
                size="sm"
                icon={undefined}
                onClick={() => {
                  props.onDrafts(current => ({
                    ...current,
                    specialistEditing: true,
                    specialist: { ...item },
                  }))
                }}
              >
                {item.name}
              </Button>
            ))}
            <Button
              size="sm"
              variant="ghost"
              icon={<IconPlusOutline16 />}
              onClick={() => {
                props.onDrafts(current => ({ ...current, specialistEditing: true, specialist: { ...EMPTY_SPECIALIST } }))
              }}
            >
              {t('specialists.new')}
            </Button>
          </div>
          {drafts.specialistEditing && (
            <div style={S.field}>
              <Input
                value={drafts.specialist.id}
                placeholder={t('specialists.idPlaceholder')}
                onChange={(event) => {
                  const id = event.target.value
                  props.onDrafts(current => ({ ...current, specialist: { ...current.specialist, id } }))
                }}
              />
              <Input
                value={drafts.specialist.name}
                placeholder={t('specialists.namePlaceholder')}
                onChange={(event) => {
                  const name = event.target.value
                  props.onDrafts(current => ({ ...current, specialist: { ...current.specialist, name } }))
                }}
              />
              <select
                style={S.select}
                value={drafts.specialist.mode}
                onChange={(event) => {
                  const mode = event.target.value === 'write' ? 'write' : 'read'
                  props.onDrafts(current => ({ ...current, specialist: { ...current.specialist, mode } }))
                }}
              >
                <option value="read">{t('specialists.modeRead')}</option>
                <option value="write">{t('specialists.modeWrite')}</option>
              </select>
              <textarea
                style={S.textarea}
                value={drafts.specialist.instructions}
                placeholder={t('specialists.instructionsPlaceholder')}
                onChange={(event) => {
                  const instructions = event.target.value
                  props.onDrafts(current => ({ ...current, specialist: { ...current.specialist, instructions } }))
                }}
              />
              <div style={S.inline}>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(drafts.specialist.id) || drafts.specialist.name.trim() === '' || drafts.specialist.instructions.trim() === ''}
                  icon={<IconCheckOutline14 />}
                  onClick={() => {
                    props.onAction(
                      { action: 'save_specialist', specialist: { ...drafts.specialist, name: drafts.specialist.name.trim() } },
                      () => { props.onDrafts(current => ({ ...current, specialistEditing: false, specialist: { ...EMPTY_SPECIALIST } })) },
                    )
                  }}
                >
                  {t('specialists.save')}
                </Button>
                <Button size="sm" onClick={() => { props.onDrafts(current => ({ ...current, specialistEditing: false, specialist: { ...EMPTY_SPECIALIST } })) }}>
                  {t('specialists.cancel')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={S.footer}>
        <StateDot state={summary.failed > 0 ? 'error' : summary.active > 0 ? 'ongoing' : 'done'} size={8} />
        <span>
          {snapshot === null || switching
            ? t('footer.never')
            : props.loadedAt === null
              ? t('footer.synced')
              : t('footer.updated', { time: clockOf(props.loadedAt) })}
        </span>
        <span style={{ flex: 1 }} />
        {busy && <span>{t('footer.busy')}</span>}
        <span>
          {coordinatorId === undefined
            ? t('footer.noSession')
            : team?.paused === true
              ? t('footer.paused')
              : props.error !== null
                ? t('footer.manual')
                : props.pollingVisible === false
                  ? t('footer.hidden')
                  : t('footer.polling')}
        </span>
      </div>
    </div>
  )
}

// -------------------------------------------------------------- orbit panel

/** One role node on the status ring. */
export interface OrbitRole {
  id: string
  name: string
  mode: SpecialistMode
  state: 'working' | 'queued' | 'done' | 'blocked' | 'idle'
  /** Latest worker conversation for this role, when it has one. */
  workerId?: string
}

const ACTIVE_TASK = new Set(['starting', 'working', 'canceling'])

/**
 * Fold a coordinator's tasks onto its roster: one state per role, so the ring
 * answers "who is working?" without listing assignments.
 * @param team - the coordinator's team, or null before the first assignment.
 * @param specialists - the role roster.
 * @returns one orbit node per role, in roster order.
 */
export function orbitRoles(team: TeamState | null, specialists: readonly Specialist[]): OrbitRole[] {
  return specialists.map(specialist => {
    const tasks = (team?.tasks ?? []).filter(task => task.specialistId === specialist.id)
    let workerId: string | undefined
    for (let index = tasks.length - 1; index >= 0; index--) {
      const candidate = tasks[index]?.workerId
      if (candidate !== undefined) {
        workerId = candidate
        break
      }
    }
    const state = tasks.some(task => ACTIVE_TASK.has(task.status))
      ? 'working'
      : tasks.some(task => task.status === 'queued')
        ? 'queued'
        : tasks.some(task => task.status === 'failed' || task.status === 'blocked')
          ? 'blocked'
          : tasks.some(task => task.status === 'done') ? 'done' : 'idle'
    const role: OrbitRole = { id: specialist.id, name: specialist.name, mode: specialist.mode, state }
    if (workerId !== undefined) role.workerId = workerId
    return role
  })
}

/** Ring motion, kept in one stylesheet element so the inline styles stay static. */
const ORBIT_CSS = `
@keyframes dshteam-breathe { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }
@keyframes dshteam-spin { to { transform: rotate(360deg); } }
.dshteam-orbit-progress { position: absolute; inset: -4px; border-radius: 50%;
  background: conic-gradient(from 0deg, rgba(52,211,153,.9), rgba(52,211,153,.15) 62%, transparent 63%);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2.4px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2.4px));
  animation: dshteam-spin 3.2s linear infinite; }
.dshteam-orbit-halo { position: absolute; inset: -5px; border-radius: 50%;
  border: 1.5px solid rgba(52,211,153,.45); animation: dshteam-breathe 1.9s ease-in-out infinite; pointer-events: none; }
.dshteam-orbit-node[data-state="idle"] { opacity: .72; }
.dshteam-orbit-node[data-clickable="false"] { cursor: default; }
.dshteam-orbit-node[data-clickable="true"]:hover { box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary, rgba(94,234,212,.5)); }
`

/** Launcher chrome matching the Brain entry; inline styles cannot express hover/focus. */
const LAUNCHER_CSS = `
.dshteam-launch { transition: background 150ms ease; }
.dshteam-launch:hover { background: var(--dsw-alias-state-business-tertiary, rgba(127,127,127,0.16)); }
.dshteam-launch:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, currentColor); outline-offset: 1px; }
`

/** The status-only team ring: one node per role around the PM core. */
export function OrbitPanel(props: {
  snapshot: TeamsSnapshot | null
  snapshotFor: string | undefined
  coordinatorId: string | undefined
  error: PanelError | null
  busy: boolean
  loadedAt: Date | null
  t?: Translate
  onRefresh: () => void
  onOpenWorker: (workerId: string) => void
  onDismissError: () => void
  onResume: () => void
  onClose: () => void
  style: React.CSSProperties | undefined
  rootRef: React.RefObject<HTMLDivElement>
}) {
  const t = props.t ?? zhTranslate
  const scoped = scopedTeam(props.snapshot, props.coordinatorId, props.snapshotFor)
  const team = scoped.team
  const switching = scoped.stale
  const roles = orbitRoles(team, props.snapshot?.specialists ?? [])
  const working = roles.filter(role => role.state === 'working').length
  const settled = roles.filter(role => role.state === 'done').length
  const allDone = roles.length > 0 && roles.every(role => role.state === 'done')
  const summary = props.coordinatorId === undefined
    ? t('coordinator.follow')
    : props.snapshot === null || switching
      ? t('tasks.loading')
      : working > 0
        ? t('orbit.captionBusy', { settled, inflight: working })
        : allDone ? t('orbit.captionDone') : t('orbit.captionIdle')

  // Focus the panel so Escape and tab order start inside it. Focus runs now
  // and again on the next frame: the shell's composer restores focus later in
  // the same commit, and the frame callback is what wins that race.
  React.useEffect(() => {
    props.rootRef.current?.focus()
    if (typeof requestAnimationFrame === 'undefined') return
    const frame = requestAnimationFrame(() => { props.rootRef.current?.focus() })
    return () => { cancelAnimationFrame(frame) }
  }, [props.rootRef])

  return (
    <div
      ref={props.rootRef}
      style={{ ...S.orbit, ...props.style }}
      role="dialog"
      aria-label={t('panel.title')}
      tabIndex={-1}
      onKeyDown={(event) => { if (event.key === 'Escape') props.onClose() }}
    >
      <style>{ORBIT_CSS}</style>
      <div style={S.orbitHead}>
        <span style={S.orbitTitle}>{t('panel.title')}</span>
        <span style={S.orbitLive}><span style={S.orbitLiveDot} />{t('orbit.live')}</span>
        <span style={{ flex: 1 }} />
        <span style={S.orbitSummary}>{summary}</span>
        <Button size="sm" variant="ghost" icon={<IconRefreshOutline16 />} aria-label={t('panel.refresh')} disabled={props.busy} onClick={props.onRefresh} />
      </div>

      {props.error !== null && (
        <div style={S.orbitError} role="alert">
          <span style={{ flex: 1 }}>{props.error.text}</span>
          {props.error.source === 'poll' && (
            <Button size="sm" variant="ghost" onClick={props.onRefresh}>{t('panel.retry')}</Button>
          )}
          <Button size="sm" variant="ghost" onClick={props.onDismissError} aria-label={t('panel.dismissError')}>
            <IconCloseOutline16 />
          </Button>
        </div>
      )}

      <div style={{ ...S.orbitWrap, ...(allDone ? S.orbitWrapDone : {}) }}>
        <div style={S.orbitRing} />
        <div style={S.orbitCore}>
          <span style={S.orbitPm}>PM</span>
          <span style={S.orbitCoreBig}>{working}</span>
          <span style={S.orbitCoreSmall}>{working > 0 ? t('status.working') : allDone ? t('status.done') : t('status.idle')}</span>
        </div>
        {roles.map((role, index) => {
          const angle = ((ORBIT_ANGLE[index % ORBIT_ANGLE.length] ?? 0) * Math.PI) / 180
          const x = Math.cos(angle) * ORBIT_RADIUS
          const y = Math.sin(angle) * ORBIT_RADIUS
          return (
            <div
              key={role.id}
              className="dshteam-orbit-node"
              data-state={role.state}
              data-clickable={role.workerId === undefined ? 'false' : 'true'}
              style={{ ...S.orbitNode, transform: `translate(calc(-50% + ${String(x)}px), calc(-50% + ${String(y)}px))` }}
              role={role.workerId === undefined ? undefined : 'button'}
              tabIndex={role.workerId === undefined ? -1 : 0}
              title={role.workerId === undefined ? role.name : t('orbit.worker')}
              aria-label={`${role.name} · ${t(`status.${role.state}`)}`}
              onClick={() => { if (role.workerId !== undefined) props.onOpenWorker(role.workerId) }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                if (role.workerId !== undefined) props.onOpenWorker(role.workerId)
              }}
            >
              {role.state === 'working' && <span className="dshteam-orbit-progress" />}
              {role.state === 'working' && <span className="dshteam-orbit-halo" />}
              <span style={S.orbitInitial}>{role.id.charAt(0).toUpperCase()}</span>
              <span style={S.orbitLabel}>
                <span style={{
                  ...S.orbitLabelDot,
                  ...(role.state === 'working' ? S.orbitLabelDotOn
                    : role.state === 'blocked' ? S.orbitLabelDotWarn
                      : role.state === 'done' ? S.orbitLabelDotDone : {}),
                }} />
                {role.name}
              </span>
            </div>
          )
        })}
      </div>

      <div style={S.orbitFoot}>
        <span>{props.loadedAt === null ? t('footer.synced') : t('footer.updated', { time: clockOf(props.loadedAt) })}</span>
        <span style={{ flex: 1 }} />
        {team?.paused === true && (
          <Button size="sm" variant="primary" disabled={props.busy} onClick={props.onResume}>{t('paused.resume')}</Button>
        )}
      </div>
    </div>
  )
}

/**
 * The sidebar launcher entry plus the status-only team ring.
 * @param props - sidebar owner share, the global session hook, and the plugin's injected face.
 * @returns the launcher button and, while open, the panel.
 */
export function TeamsLauncher(props: TeamsLauncherProps): React.ReactNode {
  const t = props.t ?? zhTranslate
  const { wide, api, openWorker } = props
  const useSessions = props.useSessions as (selector: (state: SessionListLocal) => unknown) => unknown
  const currentSessionId = useSessions(state => state.current) as string | undefined

  const [open, setOpen] = React.useState(false)
  const [snapshot, setSnapshot] = React.useState<TeamsSnapshot | null>(null)
  /** Which coordinator the retained `snapshot` was fetched for (null-team answers carry no id). */
  const [snapshotFor, setSnapshotFor] = React.useState<string | undefined>(undefined)
  const [error, setError] = React.useState<PanelError | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [loadedAt, setLoadedAt] = React.useState<Date | null>(null)

  // `useRef<T>(null)` types as `RefObject<T>` — React 18's exact `ref` shape.
  // `useRef<T | null>(null)` would infer `MutableRefObject<T | null>`, which the
  // DOM `ref` prop rejects (its `current` is invariant across the null union).
  // Two refs: the wrapper contains both the launcher and the open panel, so the
  // outside-pointer hook treats a click on the launcher as inside; the dialog
  // ref is attached only to the panel element, for focus and Escape.
  const containerRef = React.useRef<HTMLDivElement>(null)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const buttonRef = React.useRef<HTMLButtonElement>(null)
  const loadRef = React.useRef<() => Promise<void>>(() => Promise.resolve())
  const pendingRef = React.useRef(false)

  const coordinatorId = currentSessionId ?? snapshot?.coordinators[0]?.sessionId

  // Every in-flight command carries the coordinator it was started for; a
  // switch bumps the generation so a late answer cannot report on the new one.
  const coordinatorRef = React.useRef<string | undefined>(coordinatorId)
  coordinatorRef.current = coordinatorId
  const actionEpoch = React.useRef(0)

  useDismissOnOutsidePointer(containerRef, open, setOpen)

  // Escape closes the panel even when another element holds focus: the shell's
  // composer restores focus after the panel mounts, so the dialog's own keydown
  // is not always reachable.
  React.useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [open])

  // One poll chain per (open, coordinator) pair: it re-reads on open, on an
  // explicit refresh, and on a timer, and aborts its in-flight request on
  // cleanup (close, coordinator switch, unmount).
  React.useEffect(() => {
    if (!open || coordinatorId === undefined) return
    const controller = new AbortController()
    let live = true
    const load = async (): Promise<void> => {
      if (pendingRef.current) return
      pendingRef.current = true
      try {
        const next = await api.state(coordinatorId, controller.signal)
        if (!live) return
        setSnapshot(next)
        setSnapshotFor(coordinatorId)
        // A stale read failure is cleared here; a refused command is not — its
        // text would otherwise vanish a second after the user caused it.
        setError(current => current !== null && current.source === 'action' ? current : null)
        setLoadedAt(new Date())
      } catch (failure) {
        if (!live || isCanceled(failure)) return
        setError({ text: errorText(failure, t), source: 'poll' })
      } finally {
        pendingRef.current = false
      }
    }
    loadRef.current = load
    void load()
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void load()
    }, POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
      controller.abort()
      pendingRef.current = false
      loadRef.current = () => Promise.resolve()
    }
  }, [open, coordinatorId, api, t])

  // A coordinator switch drops its last-read answer and any message about it.
  React.useEffect(() => {
    actionEpoch.current += 1
    setLoadedAt(null)
    setError(null)
    setBusy(false)
  }, [coordinatorId])

  /** Resume the paused scheduler and re-read the board. */
  const resume = React.useCallback((): void => {
    const scope = coordinatorRef.current
    if (scope === undefined) return
    const epoch = ++actionEpoch.current
    const current = (): boolean => operationStillApplies(scope, coordinatorRef.current, epoch, actionEpoch.current)
    setBusy(true)
    void api.action(scope, { action: 'resume' })
      .then(() => { if (current()) return loadRef.current() })
      .catch((failure: unknown) => { if (current()) setError({ text: errorText(failure, t), source: 'action' }) })
      .finally(() => { if (current()) setBusy(false) })
  }, [api, t])

  /**
   * Navigation refusals (an unknowable session) belong on the error line, not
   * in the console. A refusal that lands after the user switched coordinator is
   * dropped like a late command result, so it cannot surface on the new one.
   */
  const openWorkerAndReport = React.useCallback((workerId: string): void => {
    const scope = coordinatorRef.current
    if (scope === undefined) return
    const epoch = actionEpoch.current
    void openWorker(scope, workerId).catch((failure: unknown) => {
      if (operationStillApplies(scope, coordinatorRef.current, epoch, actionEpoch.current)) {
        setError({ text: errorText(failure, t), source: 'action' })
      }
    })
  }, [openWorker, t])

  const panelStyle = useAnchoredStyle(buttonRef, open)
  const scoped = scopedTeam(snapshot, coordinatorId, snapshotFor)
  const roles = orbitRoles(scoped.team, snapshot?.specialists ?? [])
  const working = roles.filter(role => role.state === 'working').length

  const button = (
    <button
      ref={buttonRef}
      type="button"
      className="dshteam-launch"
      style={{ ...S.button, ...(wide ? S.buttonWide : S.buttonRail) }}
      aria-label={t('launcher.aria')}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => { setOpen(current => !current) }}
    >
      <span style={S.buttonIcon}><IconUserOutline16 size={wide ? 16 : 18} /></span>
      {wide && <span style={S.buttonLabel}>{t('launcher.label')}</span>}
      {wide && roles.length > 0 && (
        <span style={S.buttonDots}>
          {roles.slice(0, 3).map(role => (
            <span
              key={role.id}
              style={{
                ...S.buttonDot,
                ...(role.state === 'working' ? S.buttonDotOn
                  : role.state === 'blocked' ? S.buttonDotWarn : {}),
              }}
            />
          ))}
        </span>
      )}
      {wide && working > 0 && <span style={S.buttonCount}>{working}</span>}
    </button>
  )

  return (
    <div ref={containerRef} style={{ ...S.section, ...(wide ? {} : S.sectionRail) }}>
      <style>{LAUNCHER_CSS}</style>
      {wide ? button : <Tooltip label={t('launcher.tooltip')} delayMs={500} side="right">{button}</Tooltip>}
      {open && (
        <OrbitPanel
          snapshot={snapshot}
          snapshotFor={snapshotFor}
          coordinatorId={coordinatorId}
          error={error}
          busy={busy}
          loadedAt={loadedAt}
          t={t}
          onRefresh={() => { void loadRef.current() }}
          onOpenWorker={(workerId) => { openWorkerAndReport(workerId) }}
          onDismissError={() => { setError(null) }}
          onResume={resume}
          onClose={() => { setOpen(false) }}
          style={panelStyle}
          rootRef={rootRef}
        />
      )}
    </div>
  )
}

/** The slice of the client session-list snapshot this panel reads. */
interface SessionListLocal {
  current: string | undefined
  byId: Record<string, { running?: boolean } | undefined>
}

// -------------------------------------------------------------------- settings

/** Injected face of the Settings → Teams section. */
export interface TeamsSettingsInjected {
  api: TeamsSettingsApi
  t?: Translate
}

/** The Settings → Teams page: role skills, the ponytail level, and the auto-continue budget. */
export function TeamsSettingsSection(props: TeamsSettingsInjected): React.ReactNode {
  const t = props.t ?? zhTranslate
  const [view, setView] = React.useState<TeamsRolesView | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState<string | null>(null)
  const [drafts, setDrafts] = React.useState<Record<string, string>>({})
  const [level, setLevel] = React.useState('full')
  const [rounds, setRounds] = React.useState('8')

  React.useEffect(() => {
    let live = true
    void props.api.roles().then(next => {
      if (!live) return
      setView(next)
      setLevel(next.settings.ponytailLevel)
      setRounds(String(next.settings.autoRounds))
      setDrafts({
        pm: next.pm.content,
        ...Object.fromEntries(next.roles.map(role => [role.id, role.content])),
      })
      setError(null)
    }).catch((failure: unknown) => {
      if (live) setError(errorText(failure, t))
    })
    return () => { live = false }
  }, [props.api, t])

  const updateDraft = (id: string, value: string): void => {
    setDrafts(current => ({ ...current, [id]: value }))
  }

  const accept = (next: TeamsRolesView, id: string): void => {
    setView(next)
    setLevel(next.settings.ponytailLevel)
    setRounds(String(next.settings.autoRounds))
    setDrafts({
      pm: next.pm.content,
      ...Object.fromEntries(next.roles.map(role => [role.id, role.content])),
    })
    setSaved(id)
    setError(null)
  }

  const save = (id: string): void => {
    setSaving(id)
    void props.api.saveSkill(id, drafts[id] ?? '')
      .then(next => { accept(next, id) })
      .catch((failure: unknown) => { setError(errorText(failure, t)) })
      .finally(() => { setSaving(null) })
  }

  const saveSettings = (): void => {
    setSaving('settings')
    void props.api.saveSettings({ ponytailLevel: level, autoRounds: Number(rounds) })
      .then(next => { accept(next, 'settings') })
      .catch((failure: unknown) => { setError(errorText(failure, t)) })
      .finally(() => { setSaving(null) })
  }

  return (
    <div style={S.settings}>
      <div style={S.blockTitle}><IconUserOutline16 /><span>{t('settings.title')}</span></div>
      {error !== null && <div style={S.error} role="alert">{error}</div>}
      {view === null && error === null && <div style={S.hint}>{t('settings.loading')}</div>}
      {saved !== null && <div style={S.hint}>{t('settings.saved')}</div>}

      <div style={S.block}>
        <div style={S.fieldLabel}>{t('settings.pm')}</div>
        <div style={S.hint}>{t('settings.pmHint')}</div>
        <textarea
          style={S.textarea}
          aria-label={t('settings.pm')}
          value={drafts.pm ?? ''}
          onChange={event => { updateDraft('pm', event.target.value) }}
        />
        <div style={S.inline}>
          <Button size="sm" variant="primary" disabled={saving !== null} icon={<IconCheckOutline14 />} onClick={() => { save('pm') }}>
            {t('settings.save')}
          </Button>
        </div>
      </div>

      {view !== null && view.roles.map(role => (
        <div key={role.id} style={S.block}>
          <div style={S.fieldLabel}>
            {role.name}
            <span style={S.modeTag}>{role.mode === 'write' ? t('role.write') : t('role.read')}</span>
          </div>
          <textarea
            style={S.textarea}
            aria-label={`${role.name} skill`}
            value={drafts[role.id] ?? ''}
            onChange={event => { updateDraft(role.id, event.target.value) }}
          />
          <div style={S.inline}>
            <Button size="sm" variant="primary" disabled={saving !== null} icon={<IconCheckOutline14 />} onClick={() => { save(role.id) }}>
              {t('settings.save')}
            </Button>
          </div>
        </div>
      ))}

      {view !== null && (
        <div style={S.block}>
          <div style={S.inline}>
            <span style={S.fieldLabel}>{t('settings.ponytail')}</span>
            <select style={S.select} aria-label={t('settings.ponytail')} value={level} onChange={event => { setLevel(event.target.value) }}>
              <option value="lite">lite</option>
              <option value="full">full</option>
              <option value="ultra">ultra</option>
            </select>
            <span style={S.fieldLabel}>{t('settings.autoRounds')}</span>
            <Input
              style={{ width: 72 }}
              inputMode="numeric"
              aria-label={t('settings.autoRounds')}
              value={rounds}
              onChange={event => { setRounds(event.target.value) }}
            />
            <Button size="sm" variant="primary" disabled={saving !== null} icon={<IconCheckOutline14 />} onClick={saveSettings}>
              {t('settings.save')}
            </Button>
          </div>
          <div style={S.hint}>{t('settings.skillHint')}</div>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------- plugin

/** Required client services: slot composition, session navigation, and locale. */
export const inject = ['slots', 'sessions', 'locale']

/** Plugin config this half reads; one row configures both halves of the package. */
export interface Config {
  /**
   * Whether this half registers its `sidebar.launcher` entry. Default true; the
   * AselDev profile sets it false because the office owns that entry.
   */
  showLauncher?: boolean
}

/** The slice of the client locale service this plugin uses. */
interface LocaleLike {
  register: (namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }) => () => void
  bind: (namespace: string) => Translate
}

/** The slice of the client context this plugin uses (no repo types out of tree). */
interface ClientLikeContext {
  slots: {
    inject: (name: string, callback: () => () => void) => () => void
    register: (options: Record<string, unknown>, component: unknown) => () => void
  }
  sessions: {
    open: (sessionId: string) => void
    openSubagent: (address: SubagentAddress) => void
    subagentAddress: (sessionId: string) => SubagentAddress | undefined
    refreshSubagents: (parentSessionId: string) => Promise<void>
  }
  locale: LocaleLike
  effect: (callback: () => () => void, label?: string) => unknown
}

/**
 * Whether this half registers its `sidebar.launcher` entry.
 *
 * An explicit row setting `false` wins outright. Otherwise the host's answer
 * decides, and anything but a firm `false` — including no answer at all —
 * keeps the entry: a host that cannot answer must not make the panel vanish
 * silently.
 * @param config - the plugin row config this half received, when any.
 * @param hostShowLauncher - the host's `showLauncher` answer, if it was read.
 * @returns whether to register the sidebar entry.
 */
export function launcherVisible(config: Config, hostShowLauncher?: boolean): boolean {
  if (config.showLauncher === false) return false
  return hostShowLauncher !== false
}

/**
 * Client plugin body: dictionaries, then one `sidebar.launcher` contribution.
 * The slot is declared by ui-sidebar, so the registration waits on that
 * declaration instead of racing it.
 * @param ctx - client root context.
 * @param config - plugin row config; `showLauncher: false` leaves the sidebar entry to the office.
 */
export function apply(ctx: ClientLikeContext, config: Config = {}): void {
  ctx.effect(() => ctx.locale.register(TEAMS_NS, { zh, en }), 'aseldev-teams: dictionaries')

  const t = ctx.locale.bind(TEAMS_NS)
  const api = createTeamsApi(t)

  const openSession = async (sessionId: string): Promise<void> => {
    ctx.sessions.open(sessionId)
  }

  const openWorker = async (parentSessionId: string, childSessionId: string): Promise<void> => {
    const plan = workerOpenPlan(parentSessionId, childSessionId, ctx.sessions.subagentAddress(childSessionId))
    if (plan.refreshParent) {
      // `selectSubagent` refuses an address its catalog cannot confirm, so make
      // the coordinator's child catalog authoritative before opening.
      await ctx.sessions.refreshSubagents(parentSessionId)
    }
    ctx.sessions.openSubagent(plan.address)
  }

  const injected = (): TeamsInjected => ({ api, openSession, openWorker })

  // The sidebar entry is the office's in the shipped profile. The row config
  // states it directly; otherwise the host answers once, because a plugin row
  // config does not reach the browser. Neither read blocks the other
  // registrations in this apply.
  ctx.effect(() => {
    let dispose: (() => void) | undefined
    let closed = false
    const install = (hostShowLauncher?: boolean): void => {
      if (closed || dispose !== undefined || !launcherVisible(config, hostShowLauncher)) return
      dispose = ctx.slots.inject('sidebar.launcher', () => ctx.slots.register({
        name: 'sidebar.launcher',
        id: 'teams',
        order: 20,
        registrant: '@aseldev/dsh-teams',
        locale: TEAMS_NS,
        inject: injected,
      }, TeamsLauncher))
    }
    if (config.showLauncher === false) install(false)
    // A refused or unreachable route answers no flag, which keeps the entry.
    else void api.launcher().then(install, () => { install() })
    return () => {
      closed = true
      dispose?.()
    }
  }, 'aseldev-teams: sidebar launcher')

  const settingsApi = createTeamsSettingsApi(t)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'teams',
    order: 40,
    label: () => t('settings.nav'),
    inject: (): TeamsSettingsInjected => ({ api: settingsApi, t }),
  }, TeamsSettingsSection))
}
