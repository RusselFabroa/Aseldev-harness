/**
 * AselDev Skills page plugin, browser half. Registers Settings → Skills (a
 * `settings.section` entry) over the skills-manager host plugin's JSON API.
 * Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createSkillsApi } from './api.ts'
import { SkillsSection } from './SkillsSection.tsx'
import type { SkillsSectionInjected } from './SkillsSection.tsx'
import { en, zh, type SkillsKey } from './locales.ts'

export type { SkillsSectionInjected, SkillsSectionProps } from './SkillsSection.tsx'
export type { SkillsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Settings → Skills page copy. */
    'settings.skills': SkillsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.skills'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale']

/**
 * Register the Skills section once the `settings.section` declaration exists.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-skills-manager: copy dictionaries')
  const t = ctx.locale.bind(NS) as SkillsSectionInjected['t']
  const api = createSkillsApi()
  const injected = (): SkillsSectionInjected => ({ api, t })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'skills',
    order: 20,
    label: () => t('nav'),
    inject: injected,
  }, SkillsSection))
}
