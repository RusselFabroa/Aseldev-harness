/**
 * Map one conversation's saved specialists and their TEAM ASSIGNMENTS to the
 * office document the GUI renders: one station per specialist in the roster,
 * each carrying that specialist's assignments in this conversation. Pure: the
 * caller reads the teams store and passes the parsed JSON, so the same input
 * always answers the same document and nothing here touches the disk.
 *
 * The data source is the teams plugin's own persisted store — the
 * `teams/state.json` its `TeamEngine` writes — so the office cannot drift from
 * the Team panel. Plain subagents are absent by construction: only assignments
 * a coordinator created through `team_manage` or the Team panel exist there.
 */

/**
 * A teammate status the isometric scene understands.
 * @typedef {'queued'|'working'|'done'|'blocked'|'idle'|'offline'} OfficeStatus
 */

/** Fallback boss name when neither config nor a session title names one. */
export const DEFAULT_BOSS_NAME = 'You'
/** Fallback boss subtitle. */
export const DEFAULT_BOSS_TITLE = 'Founder & team owner'
/** Fallback project label above the office. */
export const DEFAULT_PROJECT_NAME = 'AselDev Harness'
/** Fallback one-line project objective. */
export const DEFAULT_PROJECT_OBJECTIVE = "Deliver the current conversation's work with the team."
/** Assignments in one document; the most recent are kept. */
export const DEFAULT_MAX_AGENTS = 24
/** Conversations in one session list; the running ones and the most recent are kept. */
export const DEFAULT_MAX_SESSIONS = 50

/** Upper bound on one configured label (boss, project). */
const MAX_LABEL = 200
/** Upper bound on one assignment title line. */
const MAX_TASK = 240
const TRUNCATED = '…'

/**
 * Role table, in match order: the first row with a keyword starting a word in
 * the specialist id or name wins. The accents reuse the AselDev palette.
 */
const ROLES = [
  { role: 'pm', label: 'Project manager', accent: '#73b9ec', keywords: ['project manager', 'product manager', 'program manager', 'manager', 'coordinator', 'pm'] },
  { role: 'backend', label: 'Backend developer', accent: '#83c7b3', keywords: ['backend', 'back-end', 'server', 'api'] },
  { role: 'frontend', label: 'Frontend developer', accent: '#94baff', keywords: ['frontend', 'front-end', 'ui', 'browser', 'client-side'] },
  { role: 'design', label: 'Designer', accent: '#c3a5df', keywords: ['design', 'ux', 'visual', 'artist', 'brand'] },
  { role: 'qa', label: 'QA engineer', accent: '#e6c18a', keywords: ['qa', 'quality', 'test', 'review'] },
  { role: 'devops', label: 'DevOps engineer', accent: '#91b995', keywords: ['devops', 'sre', 'infra', 'platform', 'release', 'ops', 'deploy'] },
  { role: 'data', label: 'Data engineer', accent: '#a7bde5', keywords: ['data', 'database', 'analytics', 'analytic', 'sql', 'etl', 'ml'] },
  { role: 'security', label: 'Security engineer', accent: '#dba0a9', keywords: ['security', 'secops', 'appsec', 'pentest', 'audit'] },
  { role: 'writer', label: 'Writer', accent: '#c1c6ae', keywords: ['writer', 'documentation', 'docs', 'editor', 'copywriter'] },
  { role: 'research', label: 'Researcher', accent: '#9ccbd2', keywords: ['research', 'analyst', 'analysis', 'investigate', 'explore'] },
]

/** The role no keyword claimed. */
const GENERAL = { role: 'general', label: 'Team member', accent: '#9eb2cb' }

const BY_ROLE = new Map([...ROLES, GENERAL].map(row => [row.role, row]))

/** Whole-word matchers per role, compiled once: "api" must not match "capital". */
const CHECKS = new Map(ROLES.map(row => [
  row.role,
  row.keywords.map(keyword => new RegExp(`(?:^|[^a-z0-9])${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)),
]))

/**
 * Assignment statuses, normalized to lower case with spaces and underscores as
 * hyphens, and the office status each one becomes. An unlisted status is
 * `idle`.
 */
const STATUS_ALIASES = new Map([
  ['running', 'working'], ['working', 'working'], ['in-progress', 'working'], ['inprogress', 'working'],
  ['starting', 'working'], ['active', 'working'], ['busy', 'working'],
  ['awaiting', 'done'], ['settled-ok', 'done'], ['settled', 'done'], ['done', 'done'], ['complete', 'done'],
  ['completed', 'done'], ['finished', 'done'], ['success', 'done'], ['succeeded', 'done'], ['ok', 'done'],
  ['queued', 'queued'], ['pending', 'queued'], ['waiting', 'queued'], ['scheduled', 'queued'],
  ['failed', 'blocked'], ['blocked', 'blocked'], ['error', 'blocked'], ['errored', 'blocked'], ['stuck', 'blocked'],
  ['idle', 'idle'], ['none', 'idle'],
  ['stopped', 'offline'], ['offline', 'offline'], ['canceled', 'offline'], ['cancelled', 'offline'],
  ['canceling', 'offline'], ['cancelling', 'offline'], ['terminated', 'offline'],
])

/** Progress to show when the assignment carries no percentage of its own. */
const DERIVED_PROGRESS = { queued: 0, working: 50, done: 100, blocked: 50, idle: 0, offline: 0 }

/** The station task line for a specialist this session has not assigned. */
const NO_ASSIGNMENTS = 'No assignments in this session'

/**
 * Validate one configured label.
 * @param {unknown} value - the configured value, when set.
 * @param {string} fallback - the value used when nothing is configured.
 * @param {string} field - config field name, for the error message.
 * @returns {string} the trimmed label.
 */
export function label(value, fallback, field) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new Error(`aseldev-office: ${field} must be text`)
  const text = value.trim()
  if (text === '') return fallback
  if (text.length > MAX_LABEL) throw new Error(`aseldev-office: ${field} must be at most ${MAX_LABEL} characters`)
  return text
}

/**
 * A conversation title. It is clamped, never validated: a title is not
 * configuration, so an over-long or non-text one has to degrade to `fallback`
 * instead of failing the request that carries it.
 * @param {unknown} value - the conversation's own title, if any.
 * @param {string} fallback - the text used when there is no usable title.
 * @returns {string} the title to show.
 */
function clampedTitle(value, fallback) {
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  if (text === '') return fallback
  // Clamp by code point so a cut never leaves half a surrogate pair.
  return [...text].slice(0, MAX_LABEL).join('')
}

/**
 * The boss card: the configured name, else this conversation's own title
 * (clamped to the label bound), else "You".
 * @param {{bossName?: string, bossTitle?: string, sessionTitle?: string}} [input] - config fields and the session title, if any.
 * @returns {{name: string, title: string}} the boss name and subtitle.
 */
export function resolveBoss({ bossName, bossTitle, sessionTitle } = {}) {
  return {
    name: label(bossName, clampedTitle(sessionTitle, DEFAULT_BOSS_NAME), 'bossName'),
    title: label(bossTitle, DEFAULT_BOSS_TITLE, 'bossTitle'),
  }
}

/**
 * The project card: configured name and objective, else the defaults.
 * @param {{projectName?: string, projectObjective?: string}} [input] - config fields.
 * @returns {{name: string, objective: string}} the project label and objective.
 */
export function resolveProject({ projectName, projectObjective } = {}) {
  return {
    name: label(projectName, DEFAULT_PROJECT_NAME, 'projectName'),
    objective: label(projectObjective, DEFAULT_PROJECT_OBJECTIVE, 'projectObjective'),
  }
}

/** Assignment statuses that mean the conversation still has work in flight. */
const RUNNING_STATUSES = new Set(['queued', 'starting', 'working', 'canceling'])

/**
 * Normalize one raw assignment status for comparison.
 * @param {unknown} status - the raw status from the teams store.
 * @returns {string} lower case with spaces and underscores as hyphens.
 */
function statusKey(status) {
  return typeof status === 'string' ? status.trim().toLowerCase().replace(/[\s_]+/g, '-') : ''
}

/**
 * Normalize one assignment status.
 * @param {unknown} status - the raw status from the teams store.
 * @returns {OfficeStatus} the office status; an unknown status is `idle`.
 */
export function statusOf(status) {
  return STATUS_ALIASES.get(statusKey(status)) ?? 'idle'
}

/**
 * The role a specialist holds, from keywords in its id and name.
 * @param {unknown} specialist - `{ id?, name? }` from the teams store.
 * @returns {string} one of the role table's ids, or `general`.
 */
export function roleOf(specialist) {
  const id = typeof specialist?.id === 'string' ? specialist.id.trim().toLowerCase() : ''
  if (BY_ROLE.has(id)) return id
  const text = [id, typeof specialist?.name === 'string' ? specialist.name.toLowerCase() : ''].join(' ')
  for (const row of ROLES) {
    if (CHECKS.get(row.role).some(check => check.test(text))) return row.role
  }
  return GENERAL.role
}

/**
 * The role's display label ("Backend developer").
 * @param {string} role - a role id from {@link roleOf}.
 * @returns {string} the human label of that role.
 */
export function roleLabel(role) {
  return (BY_ROLE.get(role) ?? GENERAL).label
}

/**
 * The role's stable accent, as a hex colour.
 * @param {string} role - a role id from {@link roleOf}.
 * @returns {string} the `#rrggbb` accent for that role.
 */
export function accentOf(role) {
  return (BY_ROLE.get(role) ?? GENERAL).accent
}

/**
 * Progress for one teammate.
 * @param {unknown} value - the assignment's own percentage, when it exposes one.
 * @param {OfficeStatus} status - the normalized status, used when it does not.
 * @returns {number} an integer from 0 to 100.
 */
export function progressOf(value, status) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(100, Math.max(0, Math.round(value)))
  }
  return DERIVED_PROGRESS[status] ?? 0
}

/** One ISO-8601 timestamp, or undefined when the value is not a date. */
function isoOf(value) {
  const date = typeof value === 'number' ? new Date(value) : typeof value === 'string' && value !== '' ? new Date(value) : undefined
  if (date === undefined || !Number.isFinite(date.getTime())) return undefined
  return date.toISOString()
}

/** The first line of an assignment title, bounded. */
function taskText(value) {
  if (typeof value !== 'string') return ''
  const line = value.split(/\r?\n/, 1)[0].trim()
  return line.length <= MAX_TASK ? line : line.slice(0, MAX_TASK - TRUNCATED.length) + TRUNCATED
}

/** The specialist a task was assigned to, as the store records it. */
function specialistIdOf(task) {
  if (typeof task.specialistId === 'string' && task.specialistId !== '') return task.specialistId
  const own = task.specialist
  return own !== null && typeof own === 'object' && typeof own.id === 'string' ? own.id : ''
}

/**
 * Every conversation that has a teams entry, with its stored team. A store with
 * no team for the conversation, or an untouched profile, answers nothing.
 * @param {unknown} store - parsed `teams/state.json`, or undefined when absent.
 * @param {string} [sessionId] - one conversation to keep, or every conversation.
 * @returns {readonly (readonly [string, object])[]} session id and its team entry.
 */
function teamsOf(store, sessionId) {
  if (store === null || typeof store !== 'object') return []
  const teams = store.teams
  if (teams === null || typeof teams !== 'object' || Array.isArray(teams)) return []
  const rows = []
  for (const [id, team] of Object.entries(teams)) {
    if (sessionId !== undefined && id !== sessionId) continue
    if (team === null || typeof team !== 'object') continue
    rows.push([id, team])
  }
  return rows
}

/**
 * The tasks of one team entry.
 * @param {object} team - a teams store entry.
 * @returns {readonly object[]} its assignments, oldest first.
 */
function teamTasks(team) {
  return Array.isArray(team.tasks) ? team.tasks.filter(task => task !== null && typeof task === 'object') : []
}

/**
 * This conversation's assignments, oldest first.
 * @param {unknown} store - parsed `teams/state.json`, or undefined when absent.
 * @param {string} sessionId - the coordinating conversation.
 * @returns {readonly object[]} the team's tasks.
 */
function tasksOf(store, sessionId) {
  return teamsOf(store, sessionId).flatMap(([, team]) => teamTasks(team))
}

/**
 * The saved roster, in store order. An entry without a usable id is not a
 * specialist, so it can never become a station.
 * @param {unknown} store - parsed `teams/state.json`, or undefined when absent.
 * @returns {readonly object[]} the roster entries that name a specialist.
 */
function rosterOf(store) {
  const roster = store?.specialists
  if (!Array.isArray(roster)) return []
  return roster.filter(entry => entry !== null && typeof entry === 'object'
    && typeof entry.id === 'string' && entry.id !== '')
}

/** One assignment as a station job. */
function jobOf(task, at) {
  const status = statusOf(task.status)
  const startedAt = isoOf(task.createdAt)
  const updatedAt = isoOf(task.finishedAt) ?? startedAt
  return {
    id: typeof task.id === 'string' ? task.id : '',
    title: taskText(task.title),
    status,
    progress: progressOf(task.progress, status),
    startedAt: startedAt ?? at,
    updatedAt: updatedAt ?? at,
  }
}

/**
 * The station status a specialist's jobs add up to: work in flight wins, then
 * queued work, then a failure, then a fully settled history.
 * @param {readonly object[]} jobs - that specialist's jobs, newest first.
 * @returns {OfficeStatus} the aggregate status.
 */
function stationStatus(jobs) {
  if (jobs.some(job => job.status === 'working')) return 'working'
  if (jobs.some(job => job.status === 'queued')) return 'queued'
  if (jobs.some(job => job.status === 'blocked')) return 'blocked'
  if (jobs.length > 0 && jobs.every(job => job.status === 'done')) return 'done'
  return 'idle'
}

/**
 * One station: a saved specialist and this session's assignments to them. The
 * scene draws a station per specialist, never one per assignment.
 * @param {object} specialist - a roster entry from the teams store.
 * @param {readonly object[]} tasks - this session's assignments to that specialist.
 * @param {string} at - document timestamp, used when an assignment holds none.
 * @returns {object} the station.
 */
function stationOf(specialist, tasks, at) {
  const role = roleOf(specialist)
  const name = typeof specialist.name === 'string' && specialist.name.trim() !== ''
    ? specialist.name.trim()
    : roleLabel(role)
  // Newest first: an assignment's creation time is what makes it newer than another.
  const jobs = tasks
    .map(task => jobOf(task, at))
    .sort((a, b) => (a.startedAt === b.startedAt ? 0 : a.startedAt < b.startedAt ? 1 : -1))
  const done = jobs.filter(job => job.status === 'done').length
  return {
    id: specialist.id,
    name,
    role,
    title: roleLabel(role),
    accent: accentOf(role),
    status: stationStatus(jobs),
    progress: jobs.length === 0 ? 0 : Math.min(100, Math.max(0, Math.round((100 * done) / jobs.length))),
    managerId: 'boss',
    specialist: specialist.id,
    task: jobs.length === 0 ? NO_ASSIGNMENTS : jobs[0].title,
    jobs,
  }
}

/**
 * Build the office document for one conversation.
 * @param {{
 *   sessionId: string,
 *   store: unknown,
 *   boss: { name: string, title: string },
 *   project: { name: string, objective: string },
 *   now: string,
 *   maxAgents?: number,
 * }} input - the conversation, the parsed teams store, both cards, the request timestamp, and the station cap.
 * @returns {{sessionId: string, updatedAt: string, boss: object, project: object, agents: object[]}} the office document.
 */
export function officeState({ sessionId, store, boss, project, now, maxAgents = DEFAULT_MAX_AGENTS }) {
  const at = isoOf(now) ?? new Date().toISOString()
  const limit = Number.isSafeInteger(maxAgents) && maxAgents > 0 ? maxAgents : DEFAULT_MAX_AGENTS
  const roster = rosterOf(store)
  const assigned = new Map()
  for (const task of tasksOf(store, sessionId)) {
    const id = specialistIdOf(task)
    // An assignment naming no roster specialist draws nothing: stations come from the roster.
    if (id === '') continue
    const bucket = assigned.get(id)
    if (bucket === undefined) assigned.set(id, [task])
    else bucket.push(task)
  }
  return {
    sessionId,
    updatedAt: at,
    boss,
    project,
    // Roster order, so a station keeps its desk between polls.
    agents: roster.slice(0, limit).map(specialist => stationOf(specialist, assigned.get(specialist.id) ?? [], at)),
  }
}

/**
 * One session-list row: the conversation's team, as the selector needs it.
 * @param {string} id - the coordinating conversation.
 * @param {object} team - its entry in the teams store.
 * @param {string | undefined} title - its resolved title, when the sessions service knows one.
 * @param {string} at - document timestamp, used when the team holds no timestamp of its own.
 * @returns {object} the row.
 */
function sessionOf(id, team, title, at) {
  const tasks = teamTasks(team)
  const keys = tasks.map(task => statusKey(task.status))
  const stamps = tasks.map(task => isoOf(task.finishedAt) ?? isoOf(task.createdAt)).filter(stamp => stamp !== undefined)
  return {
    id,
    title: clampedTitle(title, id),
    // The team's own scheduler state: the store carries no session status.
    status: team.paused === true ? 'paused' : 'active',
    updatedAt: stamps.length === 0 ? at : stamps.reduce((latest, stamp) => (stamp > latest ? stamp : latest)),
    teammates: tasks.length,
    working: keys.filter(key => STATUS_ALIASES.get(key) === 'working').length,
    running: keys.some(key => RUNNING_STATUSES.has(key)),
  }
}

/**
 * The session selector's list for every conversation that has a team: running
 * conversations first, then most recently updated.
 * @param {{
 *   store: unknown,
 *   currentSessionId?: string | null,
 *   titles?: Record<string, string>,
 *   now: string,
 *   maxSessions?: number,
 * }} input - the parsed teams store, the asking conversation, its resolved titles, the request timestamp, and the row cap.
 * @returns {{currentSessionId: string | null, sessions: object[]}} the session list.
 */
export function officeSessions({ store, currentSessionId = null, titles = {}, now, maxSessions = DEFAULT_MAX_SESSIONS }) {
  const at = isoOf(now) ?? new Date().toISOString()
  const limit = Number.isSafeInteger(maxSessions) && maxSessions > 0 ? maxSessions : DEFAULT_MAX_SESSIONS
  const asking = typeof currentSessionId === 'string' && currentSessionId.trim() !== '' ? currentSessionId.trim() : null
  const rows = teamsOf(store).map(([id, team]) => sessionOf(id, team, titles[id], at))
  // Running first, then newest; Array.prototype.sort is stable, so ties keep store order.
  rows.sort((a, b) => (a.running === b.running ? (a.updatedAt === b.updatedAt ? 0 : a.updatedAt < b.updatedAt ? 1 : -1) : a.running ? -1 : 1))
  return { currentSessionId: asking, sessions: rows.slice(0, limit) }
}
