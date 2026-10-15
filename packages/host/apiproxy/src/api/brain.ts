/**
 * brain domain contract: the web face of the knowledge-vault seam (`ctx.brain`).
 * Read-only: every payload returns notes already inside the configured vault;
 * no method accepts an arbitrary host path.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Whether a vault is configured and its resolved root path. */
export interface BrainStatus {
  configured: boolean
  path?: string
}

/** One note (a `.md` file) as a leaf in the vault tree. */
export interface BrainNoteNode {
  kind: 'note'
  /** File name without the `.md` extension. */
  name: string
  /** Vault-relative path including the `.md` extension, with `/` separators. */
  path: string
}

/** One folder as a branch in the vault tree. */
export interface BrainFolderNode {
  kind: 'folder'
  /** Folder name without any path separators. */
  name: string
  /** Vault-relative path with `/` separators ('' is the root). */
  path: string
  /** Nested folders and notes, in stable name order. */
  children: BrainTreeNode[]
}

/** One node of the vault tree (folders nest; notes are leaves). */
export type BrainTreeNode = BrainFolderNode | BrainNoteNode

/** One full-text search match. */
export interface BrainSearchMatch {
  /** Vault-relative path of the matching note. */
  path: string
  /** File name without the `.md` extension. */
  title: string
  /** A bounded excerpt around the first match. */
  snippet: string
}

/** Brain-domain unary methods (the map keys brain.* of RpcMethodMap). */
export interface BrainApi {
  /**
   * List the whole vault as a tree of folders and notes. An unconfigured vault
   * is a successful empty result (`status.configured === false`), not an error.
   */
  list(
    request: RpcRequest<{}>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ status: BrainStatus; tree: BrainTreeNode[] }>>

  /** Full-text search across note titles and bodies. */
  search(
    request: RpcRequest<{ query: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ items: BrainSearchMatch[] }>>

  /**
   * Read one note's Markdown body by vault-relative path. An escaping or
   * absolute path fails with `brain-invalid-path`; a missing note with
   * `brain-not-found`.
   */
  read(
    request: RpcRequest<{ path: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ path: string; title: string; content: string }>>
}
