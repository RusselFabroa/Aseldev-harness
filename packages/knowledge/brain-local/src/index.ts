/**
 * Local-filesystem implementation of the brain seam (`ctx.brain`): walks one
 * read-only directory of Markdown notes, serves its folder/note tree, a
 * bounded case-insensitive full-text search, and single-note reads. The vault
 * path is a settings namespace (`brain`) layered over the composition entry,
 * so the Web configuration surface can repoint it without a restart.
 *
 * @module @deepseek-ai/dsh-brain-local
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readFile, readdir } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import {
  BrainError,
  BrainService,
} from '@deepseek-ai/dsh-brain'
import type {
  BrainSearchMatch,
  BrainStatus,
  BrainTreeNode,
} from '@deepseek-ai/dsh-brain'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'brain-local'

/** Settings namespace carrying the vault path and scan bounds. */
export const BRAIN_SETTINGS_NAMESPACE = settingsNamespace('brain')

/** Default result/scan bounds; deployment-varying, so configurable. */
const DEFAULT_MAX_RESULTS = 100
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024
const DEFAULT_MAX_SNIPPET_CHARS = 200

/** Plugin config (all optional — `apply` fills the defaults). */
export interface Config {
  /** Absolute path of the Markdown vault. Empty means unconfigured. */
  path?: string
  /** Maximum search matches returned. */
  maxResults?: number
  /** Maximum bytes read from one note while searching. */
  maxFileBytes?: number
  /** Maximum characters in one search snippet. */
  maxSnippetChars?: number
}

export const Config: z<Config> = z.object({
  path: z.string().default(''),
  maxResults: z.number().step(1).min(1).default(DEFAULT_MAX_RESULTS),
  maxFileBytes: z.number().step(1).min(1).default(DEFAULT_MAX_FILE_BYTES),
  maxSnippetChars: z.number().step(1).min(1).default(DEFAULT_MAX_SNIPPET_CHARS),
})

/** A `.md` note file (case-insensitive extension). */
function isMarkdown(name: string): boolean {
  return /\.md$/i.test(name)
}

/** Strip the `.md` extension for a note's display name. */
function noteName(name: string): string {
  return name.replace(/\.md$/i, '')
}

/** Case-insensitive name sort for stable tree order. */
function byName(a: { name: string }, b: { name: string }): number {
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
}

/** One flat note discovered while walking the vault. */
interface WalkedNote {
  /** Absolute host path. */
  abs: string
  /** Vault-relative `/`-separated path including the extension. */
  rel: string
}

/** The local vault provider. */
class LocalBrainService extends BrainService {
  /**
   * @param ctx - plugin context.
   * @param pathSource - thunk returning the currently authoritative vault path.
   * @param config - resolved scan bounds.
   */
  constructor(
    ctx: Context,
    private readonly pathSource: () => string,
    private readonly config: Required<Omit<Config, 'path'>>,
  ) {
    super(ctx)
  }

  /** The resolved vault root, or undefined when unconfigured. */
  private root(): string | undefined {
    const configured = this.pathSource().trim()
    return configured === '' ? undefined : resolve(configured)
  }

  status(): BrainStatus {
    const root = this.root()
    return root === undefined ? { configured: false } : { configured: true, path: root }
  }

  async list(signal?: AbortSignal): Promise<BrainTreeNode[]> {
    const root = this.root()
    if (root === undefined) return []
    return walkTree(root, '', signal)
  }

  async search(query: string, signal?: AbortSignal): Promise<BrainSearchMatch[]> {
    const trimmed = query.trim()
    if (trimmed === '') return []
    const root = this.root()
    if (root === undefined) return []
    const needle = trimmed.toLowerCase()
    const matches: BrainSearchMatch[] = []
    for await (const note of walkNotes(root, '', signal)) {
      if (matches.length >= this.config.maxResults) break
      const title = noteName(basename(note.rel))
      let content: string
      try {
        content = await readFile(note.abs, 'utf8')
      } catch {
        continue
      }
      const haystack = `${title}\n${content}`.toLowerCase()
      if (!haystack.includes(needle)) continue
      matches.push({
        path: note.rel,
        title,
        snippet: snippet(content, needle, this.config.maxSnippetChars),
      })
    }
    return matches
  }

  async read(path: string, signal?: AbortSignal): Promise<string> {
    const root = this.root()
    if (root === undefined) throw new BrainError('BRAIN_NOT_CONFIGURED', 'no vault path configured')
    const abs = resolveNotePath(root, path)
    try {
      return await readFile(abs, 'utf8')
    } catch (error: unknown) {
      if (signal?.aborted) throw error
      const code = (error as { code?: unknown } | null)?.code
      if (code === 'ENOENT' || code === 'EISDIR') {
        throw new BrainError('BRAIN_NOT_FOUND', `note not found: ${path}`)
      }
      throw new BrainError('BRAIN_IO', `note read failed: ${path}`)
    }
  }
}

/**
 * Validate and resolve a vault-relative `/`-separated path inside the root.
 * @param root - the resolved vault root.
 * @param rel - the vault-relative path to contain.
 * @returns the absolute host path.
 * @throws BrainError for an absolute, empty, or escaping path.
 */
function resolveNotePath(root: string, rel: string): string {
  if (rel === '' || isAbsolute(rel) || rel.includes('\0')) {
    throw new BrainError('BRAIN_INVALID_PATH', `invalid note path: ${rel}`)
  }
  const segments = rel.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new BrainError('BRAIN_INVALID_PATH', `invalid note path: ${rel}`)
  }
  const candidate = resolve(root, ...segments)
  const inside = relative(root, candidate)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new BrainError('BRAIN_INVALID_PATH', `note path escapes the vault: ${rel}`)
  }
  return candidate
}

/** Walk one directory into a tree of folders and notes, skipping hidden entries. */
async function walkTree(absDir: string, relDir: string, signal?: AbortSignal): Promise<BrainTreeNode[]> {
  if (signal?.aborted) throw new Error('brain listing aborted')
  let entries
  try {
    entries = await readdir(absDir, { withFileTypes: true })
  } catch {
    // An unreadable/missing root reads as an empty vault, not a failure.
    return []
  }
  const folders: BrainTreeNode[] = []
  const notes: BrainTreeNode[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const abs = join(absDir, entry.name)
    const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
    if (entry.isDirectory()) {
      const children = await walkTree(abs, rel, signal)
      if (children.length > 0) folders.push({ kind: 'folder', name: entry.name, path: rel, children })
    } else if (entry.isFile() && isMarkdown(entry.name)) {
      notes.push({ kind: 'note', name: noteName(entry.name), path: rel })
    }
  }
  folders.sort(byName)
  notes.sort(byName)
  return [...folders, ...notes]
}

/** Walk every note in the vault as a flat async sequence. */
async function* walkNotes(absDir: string, relDir: string, signal?: AbortSignal): AsyncGenerator<WalkedNote> {
  if (signal?.aborted) throw new Error('brain search aborted')
  let entries
  try {
    entries = await readdir(absDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const abs = join(absDir, entry.name)
    const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
    if (entry.isDirectory()) {
      yield* walkNotes(abs, rel, signal)
    } else if (entry.isFile() && isMarkdown(entry.name)) {
      yield { abs, rel }
    }
  }
}

/** Build a bounded snippet around the first case-insensitive match. */
function snippet(content: string, needle: string, maxChars: number): string {
  const idx = content.toLowerCase().indexOf(needle)
  if (idx === -1) return collapse(content.slice(0, maxChars))
  const half = Math.floor(maxChars / 2)
  const start = Math.max(0, idx - half)
  const end = Math.min(content.length, idx + needle.length + half)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < content.length ? '…' : ''
  return prefix + collapse(content.slice(start, end)) + suffix
}

/** Collapse runs of whitespace into single spaces for a one-line snippet. */
function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * Mount the local vault provider and its settings namespace.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = Config(config)
  let current: () => Config = () => resolved
  installSettingsSection(ctx, BRAIN_SETTINGS_NAMESPACE, Config, resolved, {
    setSource: (source) => { current = source },
    // Reads always project the current section, so a committed path change
    // needs no re-registration.
    onChange: () => {},
  })
  new LocalBrainService(
    ctx,
    () => current().path ?? '',
    { maxResults: resolved.maxResults ?? DEFAULT_MAX_RESULTS,
      maxFileBytes: resolved.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      maxSnippetChars: resolved.maxSnippetChars ?? DEFAULT_MAX_SNIPPET_CHARS },
  )
}
