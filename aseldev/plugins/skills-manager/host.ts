/**
 * AselDev skills manager, host half. Owns ONE personal skills folder:
 *
 * - The folder path is a settings namespace (`aseldev-skills`, field `path`)
 *   layered over the profile's `root`, the same way the brain vault path is,
 *   so Settings → Skills can repoint it without a restart. Blank or unset
 *   means "use `root`". The choice is saved in $DSH_HOME/settings.yaml.
 * - It mounts the skill loader (`dsh-skill-filesystem`, provider `aseldev`)
 *   over the current folder and re-mounts it whenever the folder changes, so
 *   the `/` menu and the agent follow the new folder on their next turn.
 * - It serves a small JSON API for the Settings → Skills page.
 *
 * Loaded from the profile patch by absolute path, so it lives outside the
 * harness source; harness packages are imported from the profile's
 * node_modules ($DSH_HOME/profiles/node_modules).
 *
 * Routes (all under /aseldev-skills/api):
 *   GET    /list                 → { root, skills: SkillSummary[] }
 *   GET    /config               → { path, defaultPath, overridden, configurable }
 *   PUT    /config  {path}       repoint the folder; "" goes back to the default
 *   GET    /skill?name=<name>    → { name, content, files }
 *   POST   /skill  {name,content} create a new skill folder with SKILL.md
 *   PUT    /skill  {name,content} overwrite an existing SKILL.md
 *   DELETE /skill?name=<name>    move the folder to <root>/.trash/
 *
 * Every request must come from the local machine, carry a Host of
 * 127.0.0.1/localhost/[::1], an Origin (when sent) matching that Host, and
 * the custom header `x-aseldev-skills: 1` (cross-site pages cannot send it
 * without a CORS preflight this route never approves).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'aseldev-skills-manager'

/** Wait for the web server service before apply runs. */
export const inject = ['webServer']

/** Plugin config, set from the profile patch. */
export interface Config {
  /** Default absolute path of the skills folder (used until Settings picks another). */
  root: string
}

interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

interface FiberLike {
  dispose(): Promise<void>
}

interface SettingsScopeLike {
  get(): { path?: string }
  watch(callback: (next: { path?: string }) => void): () => void
  update(patch: object): Promise<void>
  replace(section: object): Promise<void>
}

interface SettingsLike {
  register(ns: string, schema: unknown, options: { base: { path: string } }): SettingsScopeLike
}

interface ContextLike {
  get(name: string): unknown
  effect(fn: () => () => void, label?: string): unknown
  inject(deps: string[], callback: (ctx: ContextLike & { settings: SettingsLike }) => void): unknown
  plugin(plugin: unknown, config?: unknown): FiberLike
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
}

/** Settings namespace that stores the chosen folder. */
const SETTINGS_NS = 'aseldev-skills'
/** Skill provider name the loader registers under. */
const PROVIDER_NAME = 'aseldev'

/**
 * Import a harness package from the profile's node_modules (this file sits
 * outside the workspace, so bare imports would not resolve). Picks the ESM
 * entry so the same module instances as the running harness load.
 */
const profileRequire = createRequire(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'aseldev-skills-manager.cjs'))
async function fromProfile(pkg: string): Promise<Record<string, unknown>> {
  const searched = profileRequire.resolve.paths(pkg) ?? []
  const base = searched.find(dir => existsSync(join(dir, pkg, 'package.json')))
  if (base === undefined) throw new Error(`aseldev-skills: ${pkg} not found under ${searched.join(', ')}`)
  const manifestPath = join(base, pkg, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    main?: string
    exports?: Record<string, unknown>
  }
  const dot = manifest.exports?.['.']
  const entry = typeof dot === 'string'
    ? dot
    : typeof dot === 'object' && dot !== null
      ? String((dot as Record<string, unknown>).import ?? (dot as Record<string, unknown>).default)
      : manifest.main ?? 'index.js'
  return import(pathToFileURL(join(dirname(manifestPath), entry)).href) as Promise<Record<string, unknown>>
}

interface HarnessModules {
  /** Schema of the `aseldev-skills` settings section. */
  settingsSchema: unknown
  /** The harness's own skill loader plugin. */
  skillFilesystem: Record<string, unknown>
}

let harnessModules: Promise<HarnessModules> | undefined
/**
 * Load the harness packages once, on first use. Kept out of module top level
 * (no top-level await) because the source launcher may compile this file as
 * CommonJS.
 */
function loadHarness(): Promise<HarnessModules> {
  harnessModules ??= Promise.all([
    fromProfile('@deepseek-ai/schemastery'),
    fromProfile('@deepseek-ai/dsh-skill-filesystem'),
  ]).then(([schemastery, skillFilesystem]) => {
    const z = schemastery.default as {
      object(fields: Record<string, unknown>): unknown
      string(): { default(value: string): unknown }
    }
    return { settingsSchema: z.object({ path: z.string().default('') }), skillFilesystem }
  })
  return harnessModules
}

const BASE = '/aseldev-skills/api'
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/
const MAX_BODY = 256 * 1024
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
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

function assertTrusted(req: IncomingMessage): void {
  const remote = req.socket.remoteAddress ?? ''
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  if (!loopback) throw new HttpError(403, 'skills manager only answers this computer')
  const host = req.headers.host
  if (!LOCAL_HOSTS.has(hostname(host) ?? '')) throw new HttpError(403, 'unexpected Host header')
  const origin = req.headers.origin
  if (origin !== undefined) {
    let originHost: string
    try { originHost = new URL(origin).host } catch { throw new HttpError(403, 'bad Origin header') }
    if (originHost !== host) throw new HttpError(403, 'cross-origin request refused')
  }
  if (req.headers['x-aseldev-skills'] !== '1') throw new HttpError(403, 'missing x-aseldev-skills header')
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY) throw new HttpError(413, 'request body too large')
    chunks.push(buf)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    throw new HttpError(400, 'body must be a JSON object')
  }
}

/** Frontmatter fields the page shows; a tiny reader for the flat keys skills use. */
function frontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const out: Record<string, string> = {}
  if (match === null) return out
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (kv) out[kv[1]] = kv[2].replace(/^(['"])(.*)\1$/, '$2').trim()
  }
  return out
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, base))
    else out.push(relative(base, full).split(sep).join('/'))
  }
  return out.sort()
}

/** Validate SKILL.md text before it is written, so the harness can load it. */
function validateContent(skill: string, content: unknown): string {
  if (typeof content !== 'string' || content.trim().length === 0) throw new HttpError(400, 'SKILL.md content is empty')
  const fm = frontmatter(content)
  if (Object.keys(fm).length === 0) throw new HttpError(400, 'SKILL.md must start with a --- frontmatter block')
  if (fm.name !== skill) throw new HttpError(400, `frontmatter name must be "${skill}" (the folder name)`)
  if ((fm.description ?? '').length === 0) throw new HttpError(400, 'frontmatter needs a description')
  return content.endsWith('\n') ? content : `${content}\n`
}

export function apply(ctx: ContextLike, config: Config): void {
  const defaultRoot = resolve(config.root)
  let root = defaultRoot
  let scope: SettingsScopeLike | undefined
  let loader: FiberLike | undefined
  let mounting: Promise<void> = Promise.resolve()
  let unloading = false
  ctx.effect(() => () => { unloading = true }, 'aseldev-skills: unload guard')

  let mountedFolder: string | undefined
  /**
   * Bring the skill loader in line with `root`, replacing the previous one.
   * Changes run one at a time and always mount the LATEST folder, so a burst
   * of changes (startup default, then the saved setting) mounts once.
   */
  const syncLoader = (): void => {
    mounting = mounting.then(async () => {
      const folder = root
      if (unloading || folder === mountedFolder) return
      const { skillFilesystem } = await loadHarness()
      if (unloading) return
      const previous = loader
      loader = undefined
      mountedFolder = undefined
      if (previous !== undefined) await previous.dispose()
      if (unloading) return
      loader = ctx.plugin(skillFilesystem, {
        providerName: PROVIDER_NAME,
        includeDefaultRoots: false,
        customSkillDirs: [folder],
      })
      mountedFolder = folder
      ctx.logger.info(`aseldev-skills: loading skills from ${folder}`)
    }).catch((error: unknown) => {
      ctx.logger.warn(`aseldev-skills: skill loader failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** Point everything at the stored folder (blank = the profile default). */
  const useFolder = (stored: string | undefined): void => {
    const wanted = (stored ?? '').trim()
    const next = wanted === '' ? defaultRoot : resolve(wanted)
    if (next === root) return
    try {
      mkdirSync(next, { recursive: true })
    } catch (error) {
      ctx.logger.warn(`aseldev-skills: cannot create ${next}: ${error instanceof Error ? error.message : String(error)}`)
    }
    root = next
    syncLoader()
  }

  const configView = () => ({
    path: root,
    defaultPath: defaultRoot,
    overridden: root !== defaultRoot,
    configurable: scope !== undefined,
  })

  mkdirSync(defaultRoot, { recursive: true })

  void loadHarness().then(({ settingsSchema }) => {
    if (unloading) return
    ctx.inject(['settings'], (sctx) => {
      const registered = sctx.settings.register(SETTINGS_NS, settingsSchema, { base: { path: config.root } })
      scope = registered
      useFolder(registered.get().path)
      sctx.effect(() => registered.watch((next) => { if (!unloading) useFolder(next.path) }), 'aseldev-skills: folder setting')
      sctx.effect(() => () => { if (scope === registered) scope = undefined }, 'aseldev-skills: settings detach')
    })
    // Mount after the saved folder (if settings answered right away) is known,
    // so startup mounts once; without settings the default folder is used.
    syncLoader()
  }).catch((error: unknown) => {
    ctx.logger.warn(`aseldev-skills: folder setting unavailable: ${error instanceof Error ? error.message : String(error)}`)
  })

  const skillDir = (skill: unknown): string => {
    if (typeof skill !== 'string' || !NAME.test(skill)) {
      throw new HttpError(400, 'skill name must be kebab-case: lowercase letters, digits, dashes')
    }
    const dir = resolve(root, skill)
    if (relative(root, dir).includes('..')) throw new HttpError(400, 'skill must stay inside the skills folder')
    return dir
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://local')
    const route = url.pathname.slice(BASE.length)
    assertTrusted(req)

    if (route === '/config') {
      if (req.method === 'GET') {
        send(res, 200, configView())
        return
      }
      if (req.method === 'PUT') {
        const current = scope
        if (current === undefined) throw new HttpError(409, 'settings are not available in this profile, so the folder cannot be changed here')
        const body = await readJson(req)
        if (typeof body.path !== 'string') throw new HttpError(400, 'path must be text')
        const wanted = body.path.trim()
        if (wanted === '') {
          await current.replace({})
          useFolder('')
          send(res, 200, configView())
          return
        }
        if (!isAbsolute(wanted)) throw new HttpError(400, 'use a full folder path, for example C:\\AselDev\\my-skills')
        const abs = resolve(wanted)
        if (dirname(abs) === abs) throw new HttpError(400, 'pick a folder, not a whole drive')
        if (existsSync(abs) && !statSync(abs).isDirectory()) throw new HttpError(400, 'that path is a file, not a folder')
        try {
          mkdirSync(abs, { recursive: true })
        } catch (error) {
          throw new HttpError(400, `could not create the folder: ${error instanceof Error ? error.message : String(error)}`)
        }
        await current.update({ path: abs })
        useFolder(abs)
        send(res, 200, configView())
        return
      }
    }

    if (req.method === 'GET' && route === '/list') {
      const skills = readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && NAME.test(entry.name))
        .map((entry) => {
          const file = join(root, entry.name, 'SKILL.md')
          const fm = existsSync(file) ? frontmatter(readFileSync(file, 'utf8')) : {}
          return {
            name: entry.name,
            description: fm.description ?? '',
            hasSkillFile: existsSync(file),
            nameMatches: fm.name === entry.name,
            userInvocable: fm['user-invocable'] !== 'false',
            modelInvocable: fm['disable-model-invocation'] !== 'true',
            updatedAt: existsSync(file) ? statSync(file).mtimeMs : null,
          }
        })
        .sort((a, b) => a.name.localeCompare(b.name))
      send(res, 200, { root, skills })
      return
    }

    if (route === '/skill') {
      if (req.method === 'GET' || req.method === 'DELETE') {
        const skill = url.searchParams.get('name')
        const dir = skillDir(skill)
        if (!existsSync(dir)) throw new HttpError(404, `no skill named "${String(skill)}"`)
        if (req.method === 'GET') {
          const file = join(dir, 'SKILL.md')
          send(res, 200, { name: skill, content: existsSync(file) ? readFileSync(file, 'utf8') : '', files: listFiles(dir) })
          return
        }
        const trash = join(root, '.trash')
        mkdirSync(trash, { recursive: true })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const target = join(trash, `${String(skill)}-${stamp}`)
        renameSync(dir, target)
        ctx.logger.info(`aseldev-skills: moved ${String(skill)} to ${target}`)
        send(res, 200, { deleted: skill, movedTo: target })
        return
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        const body = await readJson(req)
        const dir = skillDir(body.name)
        const content = validateContent(String(body.name), body.content)
        const exists = existsSync(dir)
        if (req.method === 'POST' && exists) throw new HttpError(409, `a skill named "${String(body.name)}" already exists`)
        if (req.method === 'PUT' && !exists) throw new HttpError(404, `no skill named "${String(body.name)}"`)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'SKILL.md'), content, 'utf8')
        send(res, req.method === 'POST' ? 201 : 200, { saved: body.name })
        return
      }
    }
    throw new HttpError(404, 'unknown skills route')
  }

  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (webServer === undefined) {
    ctx.logger.warn('aseldev-skills: no web server in this profile; the Skills page has nothing to talk to')
    return
  }
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: BASE,
    handler: (req, res) => handle(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500
      const message = error instanceof Error ? error.message : String(error)
      if (status === 500) ctx.logger.warn(`aseldev-skills: ${message}`)
      if (!res.headersSent) send(res, status, { error: message })
    }),
  }), 'aseldev-skills: http routes')
}
