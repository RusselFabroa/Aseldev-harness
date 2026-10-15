/**
 * The one piece of shared state between the chat cards and the sidebar's
 * artifacts window: whether the window is open, which artifact (if any) it
 * shows, and a change counter the window and the button's count re-read on.
 * A bare observable source (the inject `hooks` compartment binds it); its
 * snapshot keeps one reference until the next change.
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** What the artifacts window shows. */
export interface ArtifactsViewState {
  /** Whether the window is open. */
  open: boolean
  /** Artifact in the viewer; null shows the library. */
  id: string | null
  /** Version in the viewer; null means the latest. */
  version: number | null
  /** Bumped whenever a card sees a newly saved version. */
  changes: number
}

/** The observable plus the transitions the cards and the window call. */
export interface ArtifactsView extends HostObservable<ArtifactsViewState> {
  /** Open the window on the library. */
  openLibrary(): void
  /** Open the window on one artifact. */
  openArtifact(id: string, version?: number): void
  /** Close the window (keeps the last artifact for the next library open). */
  close(): void
  /** A new version was saved somewhere: re-read lists and counts. */
  changed(): void
}

/**
 * Create the window state. Called once from the plugin's apply.
 * @returns a fresh observable view state.
 */
export function createArtifactsView(): ArtifactsView {
  let state: ArtifactsViewState = { open: false, id: null, version: null, changes: 0 }
  const listeners = new Set<() => void>()
  const set = (next: ArtifactsViewState): void => {
    state = next
    for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    openLibrary: () => { set({ ...state, open: true, id: null, version: null }) },
    openArtifact: (id, version) => { set({ ...state, open: true, id, version: version ?? null }) },
    close: () => { set({ ...state, open: false }) },
    changed: () => { set({ ...state, changes: state.changes + 1 }) },
  }
}
