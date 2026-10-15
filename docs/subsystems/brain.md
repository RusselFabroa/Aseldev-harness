# Knowledge Vault (Brain)

English | [中文](brain.zh.md)

The read-only knowledge-vault capability seam (`ctx.brain`) owned by [`@deepseek-ai/dsh-brain`](../../packages/knowledge/brain): one configured directory of Markdown notes addressed by vault-relative paths with `/` separators that can never escape the root. The local provider ([`@deepseek-ai/dsh-brain-local`](../../packages/knowledge/brain-local)) walks the tree, runs a bounded case-insensitive full-text search, and reads single notes. Consumers are the Host RPCs behind the Web sidebar browser and the model-facing [`@deepseek-ai/dsh-tool-brain`](../../packages/knowledge/tool-brain) tools. Scan bounds belong to the provider's configuration; nothing in this seam mutates the vault.

Sources: [`packages/knowledge/brain/src/types.ts`](../../packages/knowledge/brain/src/types.ts), [`packages/knowledge/brain/src/index.ts`](../../packages/knowledge/brain/src/index.ts)

## Vault vocabulary

```ts type-equiv
/** Whether a vault is configured and its resolved root path. */
interface BrainStatus {
  /** True when a vault path is configured (and exists). */
  configured: boolean
  /** The configured vault root, when one is configured. */
  path?: string
}
```

```ts type-equiv
/** One node of the vault tree (folders nest; notes are leaves). */
type BrainTreeNode = BrainFolderNode | BrainNoteNode
```

```ts type-equiv
/** One note (a `.md` file) as a leaf in the vault tree. */
interface BrainNoteNode {
  kind: 'note'
  /** File name without the `.md` extension. */
  name: string
  /** Vault-relative path including the `.md` extension, with `/` separators. */
  path: string
}
```

```ts type-equiv
/** One folder as a branch in the vault tree. */
interface BrainFolderNode {
  kind: 'folder'
  /** Folder name without any path separators. */
  name: string
  /** Vault-relative path with `/` separators ('' is the root). */
  path: string
  /** Nested folders and notes, in stable name order. */
  children: BrainTreeNode[]
}
```

```ts type-equiv
/** One full-text search match. */
interface BrainSearchMatch {
  /** Vault-relative path of the matching note. */
  path: string
  /** File name without the `.md` extension. */
  title: string
  /** A bounded excerpt around the first match in the note body. */
  snippet: string
}
```

## Failure taxonomy

A provider raises [`BrainError`](#brainerror) with one stable code; the wire layer maps it onto its own RPC taxonomy instead of leaking the class across the process edge.

```ts type-equiv
/** The stable error codes a brain provider raises. */
type BrainErrorCode =
  | 'BRAIN_NOT_CONFIGURED'
  | 'BRAIN_NOT_FOUND'
  | 'BRAIN_INVALID_PATH'
  | 'BRAIN_IO'
```

<a id="brainerror"></a>

```ts public-api
/**
 * A brain provider failure the wire layer maps to its own taxonomy.
 */
declare class BrainError extends Error {
  /** Stable machine code for the wire layer. */
  readonly code: BrainErrorCode;
  /**
   * @param code - the stable failure kind.
   * @param message - human-readable detail.
   */
  constructor(code: BrainErrorCode, message: string);
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->
<!-- END GENERATED cordis-surface -->
