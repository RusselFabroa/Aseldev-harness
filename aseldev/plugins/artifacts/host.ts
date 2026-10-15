/**
 * AselDev artifacts, host half. Gives every agent one tool, `artifact`, that
 * creates or updates a standalone piece of content (an HTML page, Markdown
 * document, SVG image or Mermaid diagram) and keeps every version on disk:
 *
 *   <dir>/<id>/meta.json   title, type, session, versions
 *   <dir>/<id>/v1.html     one file per version (.html .md .svg .mmd)
 *
 * <dir> defaults to $DSH_HOME/artifacts. It also serves the browser half
 * (package `@deepseek-ai/dsh-client-ui-artifacts`):
 *
 *   GET /aseldev-artifacts/api/list                 → { artifacts: ArtifactMeta[] }
 *   GET /aseldev-artifacts/api/artifact?id=&v=      → { meta, version, content }
 *   GET /aseldev-artifacts/view/<id>/<v>            the page, inside a CSP sandbox
 *   GET /aseldev-artifacts/download/<id>/<v>        the raw file as a download
 *
 * Every page is served with a `Content-Security-Policy: sandbox …` header and
 * WITHOUT allow-same-origin, so it runs in an opaque origin even when opened
 * in its own tab: it cannot read the harness's cookies or storage or call
 * its API. Network access is limited to the CDN hosts in `cdnHosts`.
 *
 * The JSON API answers only this computer and requires the
 * `x-aseldev-artifacts: 1` header (cross-site pages cannot send it). Loaded
 * from the profile patch by absolute path, so it lives outside the harness
 * source; harness packages are imported from $DSH_HOME/profiles/node_modules.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'aseldev-artifacts'

/** Wait for the web server service before apply runs. */
export const inject = ['webServer']

/** Plugin config, set from the profile patch (all optional). */
export interface Config {
  /** Folder that holds the artifacts. Default: $DSH_HOME/artifacts. */
  dir?: string
  /** Largest accepted version, in bytes. Default: 2 MB. */
  maxBytes?: number
  /** Hosts pages may load scripts, styles and fonts from. */
  cdnHosts?: string[]
}

/** Artifact kinds and the file extension each is stored with. */
const TYPES = { html: 'html', markdown: 'md', svg: 'svg', mermaid: 'mmd' } as const
type ArtifactType = keyof typeof TYPES

interface VersionMeta {
  n: number
  createdAt: number
  bytes: number
}

interface ArtifactMeta {
  id: string
  title: string
  type: ArtifactType
  sessionId: string | null
  createdAt: number
  updatedAt: number
  versions: VersionMeta[]
}

interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

interface ToolsLike {
  register(definition: unknown): () => void
}

interface ContextLike {
  get(name: string): unknown
  effect(fn: () => () => void, label?: string): unknown
  inject(deps: string[], callback: (ctx: ContextLike & { tools: ToolsLike }) => void): unknown
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
}

/** Arguments the model sends (validated by defineTool against the schema). */
interface ArtifactArgs {
  action: 'create' | 'update'
  id?: string
  title?: string
  type?: ArtifactType
  content: string
}

interface ArtifactOutput {
  id: string
  version: number
  title: string
  type: ArtifactType
  bytes: number
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_CDN_HOSTS = ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com', 'https://cdn.tailwindcss.com']
const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs'
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

const TOOL_DESCRIPTION = [
  'Create or update an artifact: a standalone piece of content the user opens in a live preview beside the chat,',
  'such as a web page, an interactive tool or game, a chart or dashboard, a diagram, or a long document.',
  'Use it when the output is substantial (roughly 20+ lines) and self-contained, or when the user asks for a page,',
  'app, diagram or document to view, reuse or download. Do not use it for short answers, for snippets meant to be',
  'pasted into the user\'s project, or for files that belong in the workspace (use the file tools for those).',
  'Types: "html" = one complete HTML document with CSS and JavaScript inline; it may load libraries only from',
  'cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com or cdn.tailwindcss.com; it runs in a sandbox, so other network',
  'requests, cookies and localStorage are unavailable. "markdown" = a document. "svg" = one <svg> element.',
  '"mermaid" = Mermaid diagram source. Always send the COMPLETE content. To revise an artifact, call again with',
  'action "update", the id from the earlier result, and the full new content; that saves a new version.',
  'After saving, tell the user briefly what you made; do not repeat the content in your reply.',
].join(' ')

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * Import a harness package from the profile's node_modules (this file sits
 * outside the workspace, so bare imports would not resolve).
 */
const profileRequire = createRequire(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'aseldev-artifacts.cjs'))
async function fromProfile(pkg: string): Promise<Record<string, unknown>> {
  const searched = profileRequire.resolve.paths(pkg) ?? []
  const base = searched.find(dir => existsSync(join(dir, pkg, 'package.json')))
  if (base === undefined) throw new Error(`aseldev-artifacts: ${pkg} not found under ${searched.join(', ')}`)
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

/** Only this computer, addressed by a local host name. */
function assertLocal(req: IncomingMessage): void {
  const remote = req.socket.remoteAddress ?? ''
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  if (!loopback) throw new HttpError(403, 'artifacts only answer this computer')
  if (!LOCAL_HOSTS.has(hostname(req.headers.host) ?? '')) throw new HttpError(403, 'unexpected Host header')
}

/** The JSON API additionally needs a same-origin caller with the custom header. */
function assertApiCaller(req: IncomingMessage): void {
  assertLocal(req)
  const origin = req.headers.origin
  if (origin !== undefined) {
    let originHost: string
    try { originHost = new URL(origin).host } catch { throw new HttpError(403, 'bad Origin header') }
    if (originHost !== req.headers.host) throw new HttpError(403, 'cross-origin request refused')
  }
  if (req.headers['x-aseldev-artifacts'] !== '1') throw new HttpError(403, 'missing x-aseldev-artifacts header')
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Short kebab-case stem from a title, for ids and download names. */
function slug(title: string): string {
  const base = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return base === '' ? 'artifact' : base
}

/** The page a stored version is served as (HTML for every type). */
function pageFor(type: ArtifactType, title: string, content: string): string {
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>`
  switch (type) {
    case 'html':
      return /<html[\s>]|<!doctype/i.test(content) ? content : `<!doctype html><html><head>${head}</head><body>${content}</body></html>`
    case 'svg':
      return `<!doctype html><html><head>${head}<style>html,body{margin:0;height:100%}body{display:grid;place-items:center;background:#fff}svg{max-width:100%;max-height:100vh;height:auto}</style></head><body>${content}</body></html>`
    case 'mermaid':
      return `<!doctype html><html><head>${head}<style>body{margin:0;padding:24px;font-family:system-ui,sans-serif;background:#fff}</style></head><body><pre class="mermaid">${escapeHtml(content)}</pre><script type="module">import mermaid from '${MERMAID_URL}';mermaid.initialize({startOnLoad:true,securityLevel:'strict'});</script></body></html>`
    case 'markdown':
      return `<!doctype html><html><head>${head}<style>body{margin:0;padding:32px;font-family:system-ui,sans-serif;background:#fff;color:#0f1115}pre{white-space:pre-wrap;font:15px/1.6 ui-monospace,Consolas,monospace}</style></head><body><pre>${escapeHtml(content)}</pre></body></html>`
  }
}

export function apply(ctx: ContextLike, config: Config = {}): void {
  const dir = resolve(config.dir !== undefined && config.dir.trim() !== ''
    ? config.dir
    : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'artifacts'))
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES
  const cdnHosts = (config.cdnHosts ?? DEFAULT_CDN_HOSTS).filter(host => /^https:\/\/[a-z0-9.-]+$/i.test(host))
  const cdn = cdnHosts.join(' ')
  const sandboxPolicy = [
    'sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads',
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${cdn}`,
    `style-src 'unsafe-inline' ${cdn} https://fonts.googleapis.com`,
    `font-src data: ${cdn} https://fonts.gstatic.com`,
    'img-src data: blob: https:',
    'media-src data: blob: https:',
    `connect-src ${cdn}`,
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ')
  let unloading = false
  ctx.effect(() => () => { unloading = true }, 'aseldev-artifacts: unload guard')
  mkdirSync(dir, { recursive: true })

  const folderOf = (id: string): string => {
    if (!ID.test(id)) throw new HttpError(400, `invalid artifact id: ${id}`)
    return join(dir, id)
  }

  const readMeta = (id: string): ArtifactMeta | undefined => {
    const file = join(folderOf(id), 'meta.json')
    if (!existsSync(file)) return undefined
    return JSON.parse(readFileSync(file, 'utf8')) as ArtifactMeta
  }

  const writeAtomic = (file: string, text: string): void => {
    const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, file)
  }

  const versionFile = (meta: ArtifactMeta, n: number): string => join(folderOf(meta.id), `v${n}.${TYPES[meta.type]}`)

  const readVersion = (id: string, requested: number | undefined): { meta: ArtifactMeta; version: number; content: string; file: string } => {
    const meta = readMeta(id)
    if (meta === undefined) throw new HttpError(404, `no artifact with id "${id}"`)
    const latest = meta.versions[meta.versions.length - 1]?.n ?? 1
    const version = requested ?? latest
    if (!meta.versions.some(v => v.n === version)) throw new HttpError(404, `artifact "${id}" has no version ${version}`)
    const file = versionFile(meta, version)
    return { meta, version, content: readFileSync(file, 'utf8'), file }
  }

  /** Save one version (the tool's whole effect). Throws a model-readable Error on bad input. */
  const save = (args: ArtifactArgs, sessionId: string | null): ArtifactOutput => {
    const content = args.content
    if (content.trim() === '') throw new Error('artifact content is empty; send the complete content')
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > maxBytes) throw new Error(`artifact content is ${bytes} bytes, over the ${maxBytes}-byte limit; make it smaller`)
    const now = Date.now()
    let meta: ArtifactMeta
    if (args.action === 'create') {
      const title = (args.title ?? '').trim()
      if (title === '') throw new Error('creating an artifact needs a title')
      if (args.type === undefined) throw new Error('creating an artifact needs a type: html, markdown, svg or mermaid')
      if (args.type === 'svg' && !/<svg[\s>]/i.test(content)) throw new Error('an svg artifact must contain an <svg> element')
      let id = `${slug(title)}-${randomBytes(3).toString('hex')}`
      while (existsSync(join(dir, id))) id = `${slug(title)}-${randomBytes(3).toString('hex')}`
      mkdirSync(join(dir, id), { recursive: true })
      meta = { id, title: title.slice(0, 120), type: args.type, sessionId, createdAt: now, updatedAt: now, versions: [] }
    } else {
      const id = (args.id ?? '').trim()
      if (id === '' || !ID.test(id)) throw new Error('updating an artifact needs the id returned when it was created')
      const existing = readMeta(id)
      if (existing === undefined) throw new Error(`no artifact with id "${id}"; use action "create" for a new one`)
      if (args.type !== undefined && args.type !== existing.type) {
        throw new Error(`artifact "${id}" is ${existing.type}; create a new artifact to change its type`)
      }
      if (existing.type === 'svg' && !/<svg[\s>]/i.test(content)) throw new Error('an svg artifact must contain an <svg> element')
      meta = existing
      const title = (args.title ?? '').trim()
      if (title !== '') meta.title = title.slice(0, 120)
      meta.updatedAt = now
    }
    const n = (meta.versions[meta.versions.length - 1]?.n ?? 0) + 1
    writeAtomic(versionFile(meta, n), content)
    meta.versions.push({ n, createdAt: now, bytes })
    writeAtomic(join(folderOf(meta.id), 'meta.json'), JSON.stringify(meta, null, 2))
    ctx.logger.info(`aseldev-artifacts: saved ${meta.id} v${n} (${bytes} bytes)`)
    return { id: meta.id, version: n, title: meta.title, type: meta.type, bytes }
  }

  const list = (): ArtifactMeta[] => {
    const out: ArtifactMeta[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID.test(entry.name)) continue
      try {
        const meta = readMeta(entry.name)
        if (meta !== undefined) out.push(meta)
      } catch {
        // A folder with an unreadable meta.json is skipped; the others still list.
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://local')
    const parts = url.pathname.split('/').filter(Boolean) // ['aseldev-artifacts', area, ...]
    const area = parts[1]
    if (req.method !== 'GET') throw new HttpError(405, 'only GET is supported')

    if (area === 'api') {
      assertApiCaller(req)
      if (parts[2] === 'list') {
        send(res, 200, { dir, artifacts: list() })
        return
      }
      if (parts[2] === 'artifact') {
        const v = url.searchParams.get('v')
        send(res, 200, readVersion(url.searchParams.get('id') ?? '', v === null ? undefined : Number(v)))
        return
      }
    }

    if (area === 'view' || area === 'download') {
      assertLocal(req)
      const id = parts[2] ?? ''
      const version = Number((parts[3] ?? '').replace(/^v/, ''))
      const found = readVersion(id, Number.isInteger(version) && version > 0 ? version : undefined)
      res.statusCode = 200
      res.setHeader('cache-control', 'no-store')
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('content-security-policy', sandboxPolicy)
      res.setHeader('referrer-policy', 'no-referrer')
      if (area === 'view') {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(pageFor(found.meta.type, found.meta.title, found.content))
      } else {
        const ext = TYPES[found.meta.type]
        res.setHeader('content-type', ext === 'html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8')
        res.setHeader('content-disposition', `attachment; filename="${slug(found.meta.title)}-v${found.version}.${ext}"`)
        res.end(found.content)
      }
      return
    }
    throw new HttpError(404, 'unknown artifacts route')
  }

  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (webServer === undefined) {
    ctx.logger.warn('aseldev-artifacts: no web server in this profile; artifacts cannot be viewed')
  } else {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/aseldev-artifacts',
      handler: (req, res) => handle(req, res).catch((error: unknown) => {
        const status = error instanceof HttpError ? error.status : 500
        const message = error instanceof Error ? error.message : String(error)
        if (status === 500) ctx.logger.warn(`aseldev-artifacts: ${message}`)
        if (!res.headersSent) send(res, status, { error: message })
      }),
    }), 'aseldev-artifacts: http routes')
  }

  void fromProfile('@deepseek-ai/dsh-tools').then((tools) => {
    if (unloading) return
    const defineTool = tools.defineTool as (definition: unknown) => unknown
    const definition = defineTool({
      name: 'artifact',
      description: TOOL_DESCRIPTION,
      parameters: {
        action: { type: 'string', required: true, enum: ['create', 'update'], description: '"create" for a new artifact, "update" to save a new version of an existing one.' },
        id: { type: 'string', description: 'Required for "update": the id returned when the artifact was created.' },
        title: { type: 'string', description: 'Required for "create": a short human title. Optional for "update" (renames it).' },
        type: { type: 'string', enum: ['html', 'markdown', 'svg', 'mermaid'], description: 'Required for "create": the content type.' },
        content: { type: 'string', required: true, description: 'The complete content of this version.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            version: { type: 'number', required: true },
            title: { type: 'string', required: true },
            type: { type: 'string', required: true },
            bytes: { type: 'number', required: true },
          },
        },
        render: (_args: unknown, value: ArtifactOutput) => [{
          type: 'text',
          text: `Saved artifact "${value.title}" (id: ${value.id}, version ${value.version}, ${value.type}). `
            + 'The user sees it as a card in the chat and can open it there; do not repeat its content. '
            + `To change it, call artifact with action "update", id "${value.id}" and the full new content.`,
        }],
        presentationMeta: (_args: unknown, value: ArtifactOutput) => ({
          id: value.id, version: value.version, title: value.title, type: value.type, bytes: value.bytes,
        }),
      },
      async execute(args: ArtifactArgs, exec: { agent?: { session?: { id?: unknown } } }) {
        const sessionId = exec.agent?.session?.id
        return save(args, typeof sessionId === 'string' ? sessionId : null)
      },
      presentCall: (args: ArtifactArgs) => ({
        card: 'generic',
        title: args.action === 'update' ? 'Update artifact' : 'Create artifact',
        rawInput: args.title ?? args.id ?? '',
      }),
    })
    // Registration is itself an effect of the calling context (disposed with it).
    ctx.inject(['tools'], (tctx) => {
      tctx.tools.register(definition)
    })
  }).catch((error: unknown) => {
    ctx.logger.warn(`aseldev-artifacts: the artifact tool is unavailable: ${error instanceof Error ? error.message : String(error)}`)
  })
}
