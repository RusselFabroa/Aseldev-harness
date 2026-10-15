/**
 * AselDev brain access, host half. Enforces the Brain rules in code for every
 * agent in every preset (rules in a prompt are requests; these are not):
 *
 * - Private folders (default `05 - Private`) are off-limits to agents. A
 *   global tool guard refuses ANY tool call (brain tools, file tools, shell,
 *   anything) whose arguments point into a private folder, and tells the
 *   agent to ask Asel instead.
 * - `brain_search` results never list a note inside a private folder: a
 *   `tools/post-execute` listener removes those matches before the model or
 *   the chat card sees them.
 *
 * - The core card (the part of the vault's start guide between the
 *   `core-card:start` / `core-card:end` markers) is added to every agent's
 *   system prompt. It is re-read only when the note changes, so editing it in
 *   Obsidian takes effect on the next message without a rebuild.
 *
 * - `brain_write` is the one way agents write to the vault, and every write
 *   rule is enforced here: create a new note (frontmatter `type` / `status` /
 *   `tags` plus a `Parent:` link) or append under a dated heading; never
 *   overwrite, rename, move or delete; Markdown only; no private folder, no
 *   protected folder (the start guide and Knowledge Base, archive, templates),
 *   nothing outside the vault. Notes in `01 - Inbox` are written straight
 *   away; anywhere else Asel gets a Yes/No approval prompt first.
 *
 * The Brain window in the sidebar is not affected: it is Asel's own view and
 * reads the vault directly, not through agent tools.
 *
 * Loaded from the profile patch by absolute path (aseldev/setup-profile.ps1).
 */

import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'aseldev-brain'

/** Plugin config, set from the profile patch (all optional). */
export interface Config {
  /** Vault-relative folders agents must never touch. Default: ['05 - Private']. */
  privateFolders?: string[]
  /** Vault-relative note holding the core card. Default: the start guide. */
  coreCardNote?: string
  /** Longest core card sent to the model, in characters. Default: 4000. */
  coreCardMaxChars?: number
  /** Turn the `brain_write` tool off. Default: on. */
  writeDisabled?: boolean
  /** Folders `brain_write` may write without asking. Default: ['01 - Inbox']. */
  noApprovalFolders?: string[]
  /** Folders `brain_write` must never write (besides the private ones). */
  protectedFolders?: string[]
  /** Largest single write, in bytes. Default: 200 KB. */
  maxWriteBytes?: number
}

interface ExecutionLike {
  readonly name: string
  readonly arguments: unknown
}

interface ResultLike {
  readonly isError: boolean
  readonly value?: unknown
}

type Decision =
  | { kind: 'accept'; content?: unknown; value?: unknown; additionalContexts?: unknown[] }
  | { kind: 'block'; feedback: unknown[]; additionalContexts?: unknown[] }

type PreDecision = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }

interface ToolsLike {
  guard(guard: (execution: ExecutionLike) => string | undefined): () => void
  register?(definition: unknown): () => void
}

interface SystemPromptLike {
  section(section: { name: string; order: number; text: string | (() => string) }): () => void
}

interface BrainLike {
  status(): { configured: boolean; path?: string }
}

interface ContextLike {
  get(name: string): unknown
  inject(deps: string[], callback: (ctx: ContextLike & { tools: ToolsLike; systemPrompt: SystemPromptLike }) => void): unknown
  on(
    event: 'tools/post-execute',
    listener: (exec: ExecutionLike, result: ResultLike, next: () => Promise<Decision>) => Promise<Decision>,
  ): () => void
  on(
    event: 'tools/pre-execute',
    listener: (exec: ExecutionLike, next: () => Promise<PreDecision>) => Promise<PreDecision>,
  ): () => void
  effect?(fn: () => () => void, label?: string): unknown
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
}

const DEFAULT_PRIVATE = ['05 - Private']
const DEFAULT_CORE_CARD_NOTE = '00 - AI Assistant Start Here/00 - AI Assistant Start Here.md'
const DEFAULT_NO_APPROVAL = ['01 - Inbox']
const DEFAULT_PROTECTED = ['00 - AI Assistant Start Here', '99 - Archive', '_Templates', 'Attachments']
const DEFAULT_MAX_WRITE = 200 * 1024
const INBOX = '01 - Inbox'
const CARD_START = /<!--\s*core-card:start[^>]*-->/i
const CARD_END = /<!--\s*core-card:end\s*-->/i

/**
 * The text between the core-card markers, or undefined when the note or the
 * markers are missing. `{{` is broken up because the prompt renderer treats it
 * as a variable reference and refuses unknown ones.
 */
function extractCoreCard(note: string, maxChars: number): string | undefined {
  const start = CARD_START.exec(note)
  if (start === null) return undefined
  const rest = note.slice(start.index + start[0].length)
  const end = CARD_END.exec(rest)
  if (end === null) return undefined
  let card = rest.slice(0, end.index).trim().replace(/\{\{/g, '{ {')
  if (card === '') return undefined
  if (card.length > maxChars) card = `${card.slice(0, maxChars)}\n[core card truncated]`
  return card
}

/** Regex-escape a folder name, letting runs of spaces/dashes vary ("05 - Private", "05-Private"). */
function folderPattern(folder: string): string {
  return folder
    .trim()
    .split(/[\s-]+/)
    .filter(part => part !== '')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s_-]*')
}

/**
 * Build the matcher for references INTO a private folder: the name as a path
 * segment, i.e. followed by a separator, a quote, whitespace or the end, and
 * preceded by a separator, quote, whitespace or the start. Plain prose that
 * merely mentions the name inside a sentence still matches; that is
 * intentional (better to refuse and ask than to leak).
 */
function privateMatcher(folders: readonly string[]): RegExp {
  const names = folders.map(folderPattern).filter(p => p !== '')
  return new RegExp(`(^|[\\\\/"'\`\\s])(?:${names.join('|')})(?=$|[\\\\/"'\`\\s])`, 'i')
}

/** Every string inside a JSON-like value, for scanning tool arguments. */
function strings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 20) return out
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) strings(item, out, depth + 1)
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key)
      strings(item, out, depth + 1)
    }
  }
  return out
}

/** Whether a vault-relative note path sits inside a private folder. */
function isPrivatePath(path: string, folders: readonly string[]): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
  const first = normalized.split('/')[0] ?? ''
  const squash = (text: string) => text.toLowerCase().replace(/[\s_-]+/g, '')
  return folders.some(folder => squash(first) === squash(folder))
}

// ---------------------------------------------------------------------------
// brain_write
// ---------------------------------------------------------------------------

/** Arguments the model sends (validated by defineTool against the schema). */
interface WriteArgs {
  action: 'create' | 'append'
  folder?: string
  title?: string
  note?: string
  heading?: string
  content: string
  type?: string
  status?: string
  tags?: string[]
  parent?: string
  ifExists?: 'error' | 'append'
}

interface WriteOutput {
  path: string
  action: 'created' | 'appended'
  bytes: number
}

/** What a call would do, worked out before any approval prompt or write. */
interface WritePlan {
  rel: string
  abs: string
  folderRel: string
  exists: boolean
  /** The effective action once `ifExists: "append"` is taken into account. */
  mode: 'create' | 'append'
}

class WriteError extends Error {}

const WRITE_DESCRIPTION = [
  'Write to Asel\'s Brain (the Obsidian vault): create a new Markdown note, or append a section to an existing one.',
  'This is the only way to write to the vault; do not use file or shell tools for it.',
  'action "create": a new note in `folder` (default "01 - Inbox", the place for new captures; the folder must already exist).',
  'In 01 - Inbox the file is named "YYYY-MM-DD - <title>.md"; elsewhere "<title>.md" (follow that folder\'s naming).',
  'Frontmatter (type, status, tags, created) and a "Parent:" link are written for you, so `content` is the body only:',
  'no frontmatter and no top-level "# title". Creating never overwrites: if the note exists the call fails, unless',
  '`ifExists` is "append". action "append": adds `content` under "## YYYY-MM-DD HH:mm · <heading>" at the end of the',
  'existing note `note` (vault-relative path ending in .md, as brain_search returns it); nothing else in it changes.',
  'Notes cannot be edited in place, renamed, moved or deleted. Off-limits: 05 - Private, 00 - AI Assistant Start Here',
  '(the guide and the Knowledge Base), 99 - Archive, _Templates, Attachments, the vault root, hidden folders.',
  'Writes inside 01 - Inbox happen at once; anywhere else Asel is asked to approve first, so prefer the Inbox unless',
  'Asel asked for a project or knowledge note. Never put secrets or credential values in a note.',
  'After writing, tell Asel the note path.',
].join(' ')

/** Lower-case and drop spaces, dashes and underscores, for loose folder matching. */
function squash(text: string): string {
  return text.toLowerCase().replace(/[\s_-]+/g, '')
}

/**
 * Clean a vault-relative path the model sent: forward slashes, no leading
 * "./", and refuse anything that could leave the vault or reach hidden
 * folders (absolute paths, drive letters, "..", empty or dot segments).
 */
function cleanRel(input: string, what: string): string {
  const text = input.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '')
  if (text === '') throw new WriteError(`${what} is empty`)
  if (isAbsolute(text) || /^[a-z]:/i.test(text) || text.startsWith('/') || text.startsWith('~')) {
    throw new WriteError(`${what} must be a path inside the vault, relative to its root (got "${input}")`)
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f<>:"|?*]/.test(text)) throw new WriteError(`${what} contains characters a note path cannot have`)
  const parts = text.split('/')
  for (const part of parts) {
    if (part.trim() === '' || part === '.' || part === '..') throw new WriteError(`${what} has an empty, "." or ".." segment`)
    if (part.startsWith('.')) throw new WriteError(`${what} points into a hidden folder (${part})`)
  }
  return parts.map(part => part.trim()).join('/')
}

/** A file name from a title: no path or Obsidian link characters, one line, at most 120 chars. */
function fileStem(title: string): string {
  const stem = title
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 120)
    .trim()
  if (stem === '') throw new WriteError('title is empty after removing characters a file name cannot have')
  return stem
}

/** Today as YYYY-MM-DD and HH:mm in the computer's own time zone. */
function now(): { date: string; time: string } {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }
}

/** A frontmatter word (type, status): lower-case letters, digits, dashes. */
function word(value: string | undefined, fallback: string): string {
  const clean = (value ?? '').toLowerCase().trim().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '')
  return clean === '' ? fallback : clean.slice(0, 40)
}

/** Obsidian tags: no "#", no spaces, only letters, digits, "-", "_" and "/". */
function cleanTags(tags: readonly string[] | undefined): string[] {
  const out: string[] = []
  for (const tag of tags ?? []) {
    if (typeof tag !== 'string') continue
    const clean = tag.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_/-]/gu, '').slice(0, 60)
    if (clean !== '' && !out.includes(clean)) out.push(clean)
    if (out.length >= 12) break
  }
  return out
}

/** One heading line: no newlines or leading "#", at most 120 chars. */
function headingText(value: string | undefined, fallback: string): string {
  const clean = (value ?? '').replace(/[\r\n]+/g, ' ').replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 120)
  return clean === '' ? fallback : clean
}

/**
 * The note a new note links to as its parent: the folder's own index note
 * (`<folder>/<folder name>.md`, as in `01 - Inbox/01 - Inbox.md`) or its
 * `00 - …` overview, looking one level up when the folder has neither.
 */
function defaultParent(vault: string, folderRel: string): string | undefined {
  let rel = folderRel
  for (let level = 0; level < 2 && rel !== ''; level++) {
    const abs = join(vault, rel)
    const name = rel.split('/').pop() ?? ''
    if (existsSync(join(abs, `${name}.md`))) return name
    try {
      const overview = readdirSync(abs).filter(f => /^00 - .+\.md$/i.test(f)).sort()[0]
      if (overview !== undefined) return overview.replace(/\.md$/i, '')
    } catch { /* unreadable folder: try one level up */ }
    rel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  }
  return undefined
}

/** Whether `child` (absolute) is the same as or inside `root` (absolute). */
function inside(root: string, child: string): boolean {
  const rel = relative(root, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Import a harness package from the profile's node_modules (this file sits
 * outside the workspace, so bare imports would not resolve).
 */
const profileRequire = createRequire(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'aseldev-brain.cjs'))
async function fromProfile(pkg: string): Promise<Record<string, unknown>> {
  const searched = profileRequire.resolve.paths(pkg) ?? []
  const base = searched.find(dir => existsSync(join(dir, pkg, 'package.json')))
  if (base === undefined) throw new Error(`${pkg} not found under ${searched.join(', ')}`)
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

export function apply(ctx: ContextLike, config: Config = {}): void {
  const folders = (config.privateFolders ?? DEFAULT_PRIVATE).filter(f => typeof f === 'string' && f.trim() !== '')
  if (folders.length === 0) {
    ctx.logger.warn('aseldev-brain: no private folders configured; nothing is blocked')
    return
  }
  const matcher = privateMatcher(folders)
  const names = folders.map(folderPattern).filter(p => p !== '').join('|')
  const linkMatcher = new RegExp(`\\[\\[\\s*(?:${names})\\s*(?:[\\\\/|#\\]])|(?:^|[\\s"'\`(<])(?:${names})\\s*[\\\\/]`, 'i')
  const label = folders.map(f => `"${f}"`).join(', ')
  const refusal = `Refused: ${label} in Asel's Brain is off-limits to agents. Do not try another way to reach it. `
    + 'If the task needs something from there, ask Asel for only that specific detail.'

  ctx.inject(['tools'], (tctx) => {
    // Global guard: applies to every agent's calls in every preset, after
    // tools/pre-execute; later listeners cannot turn this denial back.
    tctx.tools.guard((execution) => {
      if (execution.name === 'brain_search') return undefined // results are filtered below
      if (execution.name === 'brain_write') {
        // A note may MENTION the folder (a dev log about this very rule); it
        // may not point into it. Path-like arguments get the full check; the
        // note text only refuses links or paths into the folder.
        const { content, heading, ...rest } = (execution.arguments ?? {}) as Record<string, unknown>
        if (strings(rest).some(text => matcher.test(text))) return refusal
        return strings([content, heading]).some(text => linkMatcher.test(text)) ? refusal : undefined
      }
      return strings(execution.arguments).some(text => matcher.test(text)) ? refusal : undefined
    })

    tctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      if (exec.name !== 'brain_search' || result.isError || decision.kind !== 'accept') return decision
      if (Object.hasOwn(decision, 'content') || Object.hasOwn(decision, 'value')) return decision
      const value = result.value as { configured?: unknown; matches?: unknown } | undefined
      if (value === undefined || !Array.isArray(value.matches)) return decision
      const kept = value.matches.filter((match: unknown) => {
        const path = (match as { path?: unknown } | null)?.path
        return typeof path !== 'string' || !isPrivatePath(path, folders)
      })
      if (kept.length === value.matches.length) return decision
      return { ...decision, value: { ...value, matches: kept } }
    })

    ctx.logger.info(`aseldev-brain: agents are blocked from ${label}`)
  })

  // Core card: read from the vault note, cached until the file changes.
  const noteRel = config.coreCardNote ?? DEFAULT_CORE_CARD_NOTE
  const maxChars = config.coreCardMaxChars ?? 4000
  let cache: { file: string; mtimeMs: number; size: number; text: string } | undefined
  let warned = false
  const coreCard = (): string => {
    const brain = ctx.get('brain') as BrainLike | undefined
    const status = brain?.status()
    if (status?.configured !== true || status.path === undefined) return ''
    const file = join(status.path, noteRel)
    try {
      const stat = statSync(file)
      if (cache === undefined || cache.file !== file || cache.mtimeMs !== stat.mtimeMs || cache.size !== stat.size) {
        const card = extractCoreCard(readFileSync(file, 'utf8'), maxChars)
        cache = {
          file,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          text: card === undefined
            ? ''
            : `# Core card from Asel's Brain\n(Source: \`${noteRel}\` in Asel's Brain. Follow it in every reply.)\n\n${card}`,
        }
        if (card === undefined && !warned) {
          warned = true
          ctx.logger.warn(`aseldev-brain: no core-card markers found in ${file}`)
        }
      }
      return cache.text
    } catch {
      // Note missing or unreadable (vault moved, renamed): the section is
      // simply omitted for this assembly; the next one tries again.
      return ''
    }
  }
  ctx.inject(['systemPrompt'], (pctx) => {
    pctx.systemPrompt.section({ name: 'aseldev:brain-core-card', order: 20, text: coreCard })
  })

  if (config.writeDisabled !== true) registerWrite(ctx, config, folders, noteRel)
}

/** The `brain_write` tool plus its approval gate. */
function registerWrite(ctx: ContextLike, config: Config, privateFolders: readonly string[], coreCardNote: string): void {
  const noApproval = (config.noApprovalFolders ?? DEFAULT_NO_APPROVAL).map(squash)
  const protectedFolders = (config.protectedFolders ?? DEFAULT_PROTECTED).map(f => cleanRel(f, 'protected folder'))
  const protectedNote = cleanRel(coreCardNote, 'core card note').toLowerCase()
  const maxBytes = config.maxWriteBytes ?? DEFAULT_MAX_WRITE

  const vaultPath = (): string => {
    const status = (ctx.get('brain') as BrainLike | undefined)?.status()
    if (status?.configured !== true || status.path === undefined) {
      throw new WriteError('Asel\'s Brain is not set up on this computer (Settings → Plugins → Brain → Vault path)')
    }
    return status.path
  }

  /** Under a folder, compared loosely by path segment ("05-Private" = "05 - Private"). */
  const under = (rel: string, folder: string): boolean => {
    const a = rel.split('/').map(squash)
    const b = folder.split('/').map(squash)
    return b.length <= a.length && b.every((part, i) => part === a[i])
  }

  /** Resolve and check a call without writing anything. Throws WriteError when refused. */
  const plan = (args: WriteArgs): WritePlan => {
    const vault = vaultPath()
    let rel: string
    if (args.action === 'append') {
      if (typeof args.note !== 'string') throw new WriteError('append needs `note`: the vault-relative path of the existing note')
      rel = cleanRel(args.note, 'note')
    } else {
      if (typeof args.title !== 'string') throw new WriteError('create needs `title`')
      const folderRel = cleanRel(args.folder ?? INBOX, 'folder')
      const stem = fileStem(args.title)
      const dated = squash(folderRel) === squash(INBOX) && !/^\d{4}-\d{2}-\d{2} - /.test(stem)
      rel = `${folderRel}/${dated ? `${now().date} - ` : ''}${stem}.md`
    }
    if (!/\.md$/i.test(rel)) throw new WriteError(`only Markdown notes (.md) can be written (got "${rel}")`)
    if (!rel.includes('/')) throw new WriteError('notes go inside a folder, not in the vault root')
    if (isPrivatePath(rel, privateFolders)) throw new WriteError('that folder is off-limits')
    if (rel.toLowerCase() === protectedNote || protectedFolders.some(folder => under(rel, folder))) {
      throw new WriteError(`"${rel}" is protected: agents may not write there. Propose the change to Asel instead`)
    }
    const folderRel = rel.slice(0, rel.lastIndexOf('/'))
    const abs = join(vault, ...rel.split('/'))
    const folderAbs = dirname(abs)
    if (!existsSync(folderAbs) || !statSync(folderAbs).isDirectory()) {
      throw new WriteError(`folder "${folderRel}" does not exist in the vault; use an existing folder (01 - Inbox for new captures)`)
    }
    // Junctions or symlinks must not lead out of the vault.
    if (!inside(realpathSync(vault), realpathSync(folderAbs))) throw new WriteError(`"${folderRel}" leads outside the vault`)
    const exists = existsSync(abs)
    if (exists && !statSync(abs).isFile()) throw new WriteError(`"${rel}" is not a note`)
    if (args.action === 'append' && !exists) {
      throw new WriteError(`"${rel}" does not exist. Use brain_search to find the note, or action "create" for a new one`)
    }
    if (args.action === 'create' && exists && args.ifExists !== 'append') {
      throw new WriteError(`"${rel}" already exists and is never overwritten. To add to it, call brain_write with action "append" and note "${rel}"`)
    }
    return { rel, abs, folderRel, exists, mode: exists ? 'append' : 'create' }
  }

  const needsApproval = (target: WritePlan): boolean => !noApproval.some(folder => under(target.rel, folder))

  const write = (args: WriteArgs): WriteOutput => {
    const target = plan(args)
    const content = args.content.replace(/\r\n?/g, '\n').trim()
    if (content === '') throw new WriteError('content is empty')
    if (/^---\s*\n/.test(content)) throw new WriteError('send the body only: the tool writes the frontmatter')
    const { date, time } = now()
    let text: string
    if (target.mode === 'create') {
      const inInbox = squash(target.folderRel.split('/')[0] ?? '') === squash(INBOX)
      const title = headingText(target.rel.split('/').pop()?.replace(/\.md$/i, '').replace(/^\d{4}-\d{2}-\d{2} - /, ''), 'Note')
      const tags = cleanTags(args.tags)
      if (tags.length === 0 && inInbox) tags.push('inbox')
      const parentName = args.parent !== undefined
        ? headingText(args.parent.replace(/^\[\[|\]\]$/g, '').split('|')[0], '')
        : defaultParent(vaultPath(), target.folderRel)
      const lines = [
        '---',
        ...tags.length > 0 ? ['tags:', ...tags.map(tag => `  - ${tag}`)] : [],
        `type: ${word(args.type, 'note')}`,
        `status: ${word(args.status, inInbox ? 'inbox' : 'active')}`,
        `created: ${date}`,
        'source: aseldev-harness',
        '---',
        '',
        `# ${title}`,
        '',
        ...parentName !== undefined && parentName !== '' ? [`Parent: [[${parentName}]]`, ''] : [],
        ...args.heading !== undefined ? [`## ${date} ${time} · ${headingText(args.heading, 'Note')}`, ''] : [],
        content,
        '',
      ]
      text = lines.join('\n')
    } else {
      const existing = readFileSync(target.abs, 'utf8')
      const lead = existing === '' || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
      text = `${lead}## ${date} ${time} · ${headingText(args.heading, 'Update')}\n\n${content}\n`
    }
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > maxBytes) throw new WriteError(`too large: ${bytes} bytes (limit ${maxBytes})`)
    if (target.mode === 'create') writeFileSync(target.abs, text, { encoding: 'utf8', flag: 'wx' })
    else appendFileSync(target.abs, text, 'utf8')
    return { path: target.rel, action: target.mode === 'create' ? 'created' : 'appended', bytes }
  }

  // Approval: anything outside the no-approval folders asks Asel first. Runs
  // after the other pre-execute policy, so a denial elsewhere stays a denial.
  ctx.inject(['tools'], (tctx) => {
    tctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      if (exec.name !== 'brain_write' || decision.kind !== 'allow') return decision
      let target: WritePlan
      try {
        target = plan(exec.arguments as WriteArgs)
      } catch {
        return decision // the tool itself reports why it refuses
      }
      if (!needsApproval(target)) return decision
      const verb = target.mode === 'append' ? 'Append a section to' : 'Create the note'
      return { kind: 'ask', reason: `Asel's Brain: ${verb} "${target.rel}"` }
    })
  })

  let unloading = false
  ctx.effect?.(() => () => { unloading = true }, 'aseldev-brain: unload guard')
  void fromProfile('@deepseek-ai/dsh-tools').then((tools) => {
    if (unloading) return
    const defineTool = tools.defineTool as (definition: unknown) => unknown
    const definition = defineTool({
      name: 'brain_write',
      description: WRITE_DESCRIPTION,
      parameters: {
        action: { type: 'string', required: true, enum: ['create', 'append'], description: '"create" a new note, or "append" a section to an existing note.' },
        folder: { type: 'string', description: 'create: vault-relative folder that already exists. Default "01 - Inbox".' },
        title: { type: 'string', description: 'create: the note title; also its file name (in 01 - Inbox prefixed with today\'s date).' },
        note: { type: 'string', description: 'append: vault-relative path of the existing note, e.g. "02 - Projects/…/05 - Change Log.md".' },
        heading: { type: 'string', description: 'Short heading for this entry; written as "## YYYY-MM-DD HH:mm · <heading>". Default "Update" when appending.' },
        content: { type: 'string', required: true, description: 'Markdown body to write. No frontmatter, no top-level "# title".' },
        type: { type: 'string', description: 'create: frontmatter type, e.g. note, dev-log, decision, guide. Default "note".' },
        status: { type: 'string', description: 'create: frontmatter status. Default "inbox" in 01 - Inbox, else "active".' },
        tags: { type: 'array', items: { type: 'string' }, description: 'create: frontmatter tags, without "#".' },
        parent: { type: 'string', description: 'create: the parent note to link to (note name). Default: the folder\'s index note.' },
        ifExists: { type: 'string', enum: ['error', 'append'], description: 'create: what to do when the note already exists. Default "error"; "append" adds a dated section instead.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            action: { type: 'string', required: true },
            bytes: { type: 'number', required: true },
          },
        },
        render: (_args: unknown, value: WriteOutput) => [{
          type: 'text',
          text: `${value.action === 'created' ? 'Created' : 'Appended to'} "${value.path}" in Asel's Brain (${value.bytes} bytes). Tell Asel the note path.`,
        }],
        presentationMeta: (_args: unknown, value: WriteOutput) => ({ path: value.path, action: value.action, bytes: value.bytes }),
      },
      async execute(args: WriteArgs) {
        try {
          return write(args)
        } catch (error) {
          if (error instanceof WriteError) throw new Error(`brain_write refused: ${error.message}`)
          throw error
        }
      },
      presentCall: (args: WriteArgs) => ({
        card: 'generic',
        kind: 'edit',
        title: args.action === 'append' ? 'Append to Asel\'s Brain' : 'New note in Asel\'s Brain',
        rawInput: args.action === 'append' ? (args.note ?? '') : `${args.folder ?? INBOX} / ${args.title ?? ''}`,
      }),
    })
    ctx.inject(['tools'], (tctx) => {
      tctx.tools.register?.(definition)
    })
    ctx.logger.info('aseldev-brain: brain_write is available to every agent')
  }).catch((error: unknown) => {
    ctx.logger.warn(`aseldev-brain: brain_write is unavailable: ${error instanceof Error ? error.message : String(error)}`)
  })
}
