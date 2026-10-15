/**
 * Vocabulary of the knowledge-vault capability seam. Types only — no runtime
 * code, and no cordis import, so both the Host service and the wire contract
 * can name these shapes without dragging in a runtime dependency.
 *
 * @module @deepseek-ai/dsh-brain
 */

/** Whether a vault is configured and its resolved root path. */
export interface BrainStatus {
  /** True when a vault path is configured (and exists). */
  configured: boolean
  /** The configured vault root, when one is configured. */
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
  /** A bounded excerpt around the first match in the note body. */
  snippet: string
}

/** The stable error codes a brain provider raises. */
export type BrainErrorCode =
  | 'BRAIN_NOT_CONFIGURED'
  | 'BRAIN_NOT_FOUND'
  | 'BRAIN_INVALID_PATH'
  | 'BRAIN_IO'

/** A brain provider failure the wire layer maps to its own taxonomy. */
export class BrainError extends Error {
  /** Stable machine code for the wire layer. */
  readonly code: BrainErrorCode

  /**
   * @param code - the stable failure kind.
   * @param message - human-readable detail.
   */
  constructor(code: BrainErrorCode, message: string) {
    super(message)
    this.name = 'BrainError'
    this.code = code
  }
}
