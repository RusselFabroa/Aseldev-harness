/**
 * Asel's Brain plugin, browser half. One registration: BrainSection fills the
 * sidebar shell's `sidebar.brain` hole (the knowledge-vault section above the
 * workspace browser). It reads the vault baseline through the global useBrain
 * hook and drives read/search/refresh through the injected Host callbacks.
 * Export discipline: packages/client/AGENTS.md.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { BrainSectionInjected } from './contract/slots.ts'
import { BrainSection } from './BrainSection.tsx'
import { en, zh } from './locales.ts'

export type { BrainSectionInjected, BrainSectionProps } from './contract/slots.ts'
export type { BrainKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'brain'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'brain', 'locale']

/**
 * Register the section once its slot declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-brain: dictionaries')

  const injected = (): BrainSectionInjected => ({
    search: (query, signal) => ctx.brain.search(query, signal),
    read: (path, signal) => ctx.brain.read(path, signal),
    refresh: () => { void ctx.brain.refresh() },
    hooks: { brain: ctx.brain.list },
  })

  ctx.slots.inject('sidebar.brain', () => ctx.slots.register(
    {
      name: 'sidebar.brain',
      inject: injected,
      locale: NS,
    },
    BrainSection,
  ))
}
