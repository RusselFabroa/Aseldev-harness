/**
 * ui-brain contract: the `sidebar.brain` registrant share. The section reads
 * the vault baseline through the registrant-private `useBrain` hook (bound
 * from the inject `hooks` compartment by the renderer) and drives the Host
 * through the injected read/search/refresh callbacks.
 */

import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-sidebar's SlotMap merge (the 'sidebar.brain' entry) so
// PropsRuntime<'sidebar.brain'> resolves the shell's owner share.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { BrainListState, BrainSearchMatch } from '@deepseek-ai/dsh-client-runtime/client'
import type { BrainKey } from '../locales.ts'

// Declared here (not in index.ts) so programs importing this contract —
// including the package's own tests — see the namespace merge.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The knowledge-vault sidebar section copy. */
    brain: BrainKey
  }
}

/**
 * Section-private injected share (arrives via the register inject factory).
 * The `hooks` compartment carries the vault baseline source; the renderer
 * binds it into the `useBrain` selector hook.
 */
export type BrainSectionInjected = {
  /** Full-text search across the vault (the section owns debounce). */
  search: (query: string, signal: AbortSignal) => Promise<{ items: readonly BrainSearchMatch[] }>
  /** Read one note's Markdown body by vault-relative path. */
  read: (path: string, signal: AbortSignal) => Promise<{ path: string; title: string; content: string }>
  /** Re-pull the whole-vault baseline. */
  refresh: () => void
  hooks: {
    /** The knowledge-vault baseline source backing the useBrain selector hook. */
    brain: HostObservable<BrainListState>
  }
}

/** Full section props: shell owner share + injected actions (hooks bound) + the locale seat. */
export type BrainSectionProps =
  PropsRuntime<'sidebar.brain'>
  & InjectFace<BrainSectionInjected>
  & PropsLocale<'brain'>
