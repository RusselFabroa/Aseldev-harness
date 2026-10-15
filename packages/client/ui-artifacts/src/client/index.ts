/**
 * AselDev artifacts plugin, browser half. Two registrations sharing one view
 * state: the `artifact` tool's chat card (keyed `tool.call.toolview`) and the
 * Artifacts button in the sidebar launcher list, which hosts the artifacts
 * window (library + viewer). The tool itself and the sandboxed page routes
 * live in the host plugin at aseldev-plugins/artifacts/host.ts.
 * Export discipline: packages/client/AGENTS.md.
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createArtifactsApi } from './api.ts'
import { ArtifactCard } from './ArtifactCard.tsx'
import { ArtifactsSection } from './ArtifactsSection.tsx'
import type { ArtifactCardInjected, ArtifactsSectionInjected } from './contract.ts'
import { en, zh } from './locales.ts'
import { createArtifactsView } from './view-state.ts'

export type { ArtifactCardInjected, ArtifactCardProps, ArtifactsSectionInjected, ArtifactsSectionProps } from './contract.ts'
export type { ArtifactsKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'artifacts'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'sessions']

/**
 * Register the card and the sidebar entry once their slots are declared.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-artifacts: dictionaries')

  const api = createArtifactsApi()
  const view = createArtifactsView()

  const sectionInjected = (): ArtifactsSectionInjected => ({
    api,
    openLibrary: view.openLibrary,
    openArtifact: view.openArtifact,
    close: view.close,
    openSession: (sessionId) => {
      view.close()
      ctx.sessions.open(sessionId as SessionId)
    },
    hooks: { artifactsView: view },
  })
  const cardInjected = (): ArtifactCardInjected => ({
    openArtifact: view.openArtifact,
    changed: view.changed,
  })

  ctx.slots.inject('sidebar.launcher', () => ctx.slots.register({
    name: 'sidebar.launcher',
    id: 'artifacts',
    order: 10,
    inject: sectionInjected,
    locale: NS,
  }, ArtifactsSection))

  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'artifact',
    inject: cardInjected,
    locale: NS,
  }, ArtifactCard))
}
