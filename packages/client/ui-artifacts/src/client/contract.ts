/**
 * ui-artifacts contract: the injected shares of the two registrations (the
 * sidebar launcher button with its window, and the `artifact` tool card) and
 * this package's locale namespace merge.
 */

import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: ui-sidebar's SlotMap merge (the 'sidebar.launcher' entry).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { ArtifactsApi } from './api.ts'
import type { ArtifactsKey } from './locales.ts'
import type { ArtifactsViewState } from './view-state.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Artifacts card, button, viewer and library copy. */
    artifacts: ArtifactsKey
  }
}

/** Injected share of the sidebar launcher (button + window). */
export type ArtifactsSectionInjected = {
  /** Host calls for the library and the viewer. */
  api: ArtifactsApi
  /** Open the window on the library. */
  openLibrary: () => void
  /** Open the window on one artifact. */
  openArtifact: (id: string, version?: number) => void
  /** Close the window. */
  close: () => void
  /** Close the window and open the conversation that made an artifact. */
  openSession: (sessionId: string) => void
  hooks: {
    /** Window state, bound by the renderer as useArtifactsView. */
    artifactsView: HostObservable<ArtifactsViewState>
  }
}

/** Full launcher props: sidebar owner share + injected face + locale seat. */
export type ArtifactsSectionProps =
  PropsRuntime<'sidebar.launcher'>
  & InjectFace<ArtifactsSectionInjected>
  & PropsLocale<'artifacts'>

/** Injected share of the `artifact` tool card. */
export type ArtifactCardInjected = {
  /** Open the window on one artifact. */
  openArtifact: (id: string, version?: number) => void
  /** Report that a version was saved, so counts and lists refresh. */
  changed: () => void
}

/** Full card props: keyed toolview share + injected face + locale seat. */
export type ArtifactCardProps = ToolCallViewProps & ArtifactCardInjected & PropsLocale<'artifacts'>
