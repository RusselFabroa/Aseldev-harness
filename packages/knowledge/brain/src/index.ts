/**
 * Knowledge-vault capability seam (`ctx.brain`). A provider walks one
 * read-only directory of Markdown notes and serves its tree, a bounded
 * full-text search, and single-note reads — all addressed by vault-relative
 * paths that never escape the configured root.
 *
 * @module @deepseek-ai/dsh-brain
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { BrainSearchMatch, BrainStatus, BrainTreeNode } from './types.ts'

export {
  BrainError,
} from './types.ts'
export type {
  BrainErrorCode,
  BrainFolderNode,
  BrainNoteNode,
  BrainSearchMatch,
  BrainStatus,
  BrainTreeNode,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    brain: BrainService
  }
}

/**
 * Abstract knowledge-vault provider. Reads only: a provider never mutates the
 * vault. All paths are vault-relative `/`-separated strings; a provider owns
 * containing them to its configured root.
 */
export abstract class BrainService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'brain')
  }

  /**
   * The configured vault root, or an unconfigured status.
   * @returns the status carrying the resolved root when a path is set.
   */
  abstract status(): BrainStatus

  /**
   * List the whole vault as a tree of folders and notes (notes are leaves).
   * @param signal - aborts the walk.
   * @returns the tree; an empty array when no vault is configured.
   */
  abstract list(signal?: AbortSignal): Promise<BrainTreeNode[]>

  /**
   * Full-text search across note titles and bodies, case-insensitive.
   * @param query - the substring to match; a blank query matches nothing.
   * @param signal - aborts the scan.
   * @returns bounded matches, most relevant first (provider-defined ordering).
   */
  abstract search(query: string, signal?: AbortSignal): Promise<BrainSearchMatch[]>

  /**
   * Read one note's Markdown body.
   * @param path - vault-relative note path (with the `.md` extension).
   * @param signal - aborts the read.
   * @returns the decoded Markdown content.
   * @throws BrainError with {@link BrainErrorCode} for an unconfigured vault,
   *   an escaping/absolute path, a missing note, or an I/O failure.
   */
  abstract read(path: string, signal?: AbortSignal): Promise<string>
}

export default BrainService
