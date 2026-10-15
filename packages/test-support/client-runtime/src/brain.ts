/** Test-owned brain face: the renderer standard-kit observable plus recorded actions. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  BrainListState, BrainSearchMatch, IBrain, SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Brain test double. Implements the same IBrain face features receive as
 * `ctx.brain`, so a production face change breaks this double at compile
 * time. Actions record into {@link TestBrain.calls}; defaults are inert.
 */
export class TestBrain implements IBrain {
  /** The useBrain standard feed. */
  readonly list: SnapshotStore<BrainListState>

  /** Calls observed on the action face, newest last. */
  readonly calls: { method: string; args: unknown[] }[] = []

  /** Replaceable action seat. */
  private readonly stubs = new Map<string, (...args: unknown[]) => unknown>()

  /** @param stabilize - the owning runtime's act wrapper. */
  constructor(private readonly stabilize: (fn: () => Promise<void>) => Promise<void>) {
    this.list = createSnapshotStore<BrainListState>({
      status: { configured: false }, tree: [], state: 'ready', error: null,
    })
  }

  /** Update the brain baseline through an immer draft. */
  async update(mutate: (draft: BrainListState) => void): Promise<void> {
    await this.stabilize(async () => { this.list.update(mutate) })
  }

  /** Replace an action's behavior. */
  stub(method: string, impl: (...args: unknown[]) => unknown): void {
    this.stubs.set(method, impl)
  }

  async refresh(): Promise<void> {
    this.calls.push({ method: 'refresh', args: [] })
    await (this.stubs.get('refresh')?.() as Promise<void> | undefined)
  }

  async search(query: string, signal?: AbortSignal): Promise<{ items: readonly BrainSearchMatch[] }> {
    this.calls.push({ method: 'search', args: [query, signal] })
    const stub = this.stubs.get('search')
    if (stub !== undefined) return await (stub(query, signal) as Promise<{ items: readonly BrainSearchMatch[] }>)
    return { items: [] }
  }

  async read(path: string, signal?: AbortSignal): Promise<{ path: string; title: string; content: string }> {
    this.calls.push({ method: 'read', args: [path, signal] })
    const stub = this.stubs.get('read')
    if (stub !== undefined) return await (stub(path, signal) as Promise<{ path: string; title: string; content: string }>)
    return { path, title: path.split('/').pop() ?? path, content: '' }
  }
}
