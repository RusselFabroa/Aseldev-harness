/**
 * Browser brain runtime: the read-only knowledge-vault object layer. Owns the
 * whole-tree baseline (status + folder/note tree), the per-query search hop,
 * and the per-note read hop, all over the `brain.*` wire face. React-free.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  BrainSearchMatch, BrainStatus, BrainTreeNode, IApiClient, RpcError,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '../contract/store.ts'

/** Whole-vault baseline projected for UI consumers. */
export interface BrainListState {
  /** Vault status (configured + root path, or not). */
  status: BrainStatus
  /** Folder/note tree; empty while unconfigured or while loading. */
  tree: readonly BrainTreeNode[]
  state: 'idle' | 'loading' | 'ready' | 'error'
  error: RpcError | null
}

/** The outward brain-service face exposed as `ctx.brain`. */
export interface IBrain {
  /** The useBrain standard feed (read face — reads/writes stay on the class). */
  readonly list: SnapshotStore<BrainListState>
  /** Re-pull the whole-vault baseline. */
  refresh(): Promise<void>
  /** Full-text search across the vault (one shot; the UI owns debounce). */
  search(query: string, signal?: AbortSignal): Promise<{ items: readonly BrainSearchMatch[] }>
  /** Read one note's Markdown body by vault-relative path. */
  read(path: string, signal?: AbortSignal): Promise<{ path: string; title: string; content: string }>
}

/** Real brain object layer and Host actions. */
export class BrainRuntime implements IBrain {
  /** UI-facing immutable projection. */
  readonly list: SnapshotStore<BrainListState>

  /**
   * @param ctx - client root context.
   * @param api - shared wire client.
   */
  constructor(ctx: Context, private readonly api: IApiClient) {
    this.list = createSnapshotStore<BrainListState>({
      status: { configured: false }, tree: [], state: 'idle', error: null,
    })
    ctx.reflect.provide('brain', this, undefined)
    // A reconnect (or the initial connect) rebuilds the baseline from the wire.
    ctx.on('connection/reset', () => { void this.refresh() })
    void this.refresh()
  }

  async refresh(): Promise<void> {
    this.list.update((draft) => {
      draft.state = 'loading'
      draft.error = null
    })
    const response = await this.api.brain.list({})
    const result = response.result
    if (!result.ok) {
      this.list.update((draft) => {
        draft.state = 'error'
        draft.error = result.error
      })
      return
    }
    const { status, tree } = result.value
    this.list.set({ status, tree, state: 'ready', error: null })
  }

  async search(query: string, signal?: AbortSignal): Promise<{ items: readonly BrainSearchMatch[] }> {
    const response = await this.api.brain.search({ query }, signal)
    if (!response.result.ok) throw new Error(response.result.error.message)
    return { items: response.result.value.items }
  }

  async read(path: string, signal?: AbortSignal): Promise<{ path: string; title: string; content: string }> {
    const response = await this.api.brain.read({ path }, signal)
    if (!response.result.ok) throw new Error(response.result.error.message)
    return response.result.value
  }
}
