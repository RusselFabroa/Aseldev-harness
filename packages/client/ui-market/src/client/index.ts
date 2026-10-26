/** Plugin market tab registered into Web Settings. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the ctx.remote Context merge and the market namespace methods.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { MarketSettingsTab, type MarketSettingsTabInjected } from './MarketSettingsTab.tsx'
import { en, zh, type MarketLocaleKey } from './locales.ts'

export type { MarketSettingsTabInjected, MarketSettingsTabProps } from './MarketSettingsTab.tsx'
export type { MarketLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Plugin market tab copy. */
    'settings.market': MarketLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.market'

/** Services required to register Settings before the optional Market API is available. */
export const inject = ['slots', 'locale']

/** Contribute the market tab to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-market: dictionaries')

  const t = ctx.locale.bind(NS)
  const market = (): ClientContext['remote']['market'] => {
    const service = ctx.get('remote.market') as ClientContext['remote']['market'] | undefined
    if (service === undefined) {
      throw new Error('Market API is unavailable. Rebuild @deepseek-ai/dsh-api-remotes and reload the app.')
    }
    return service
  }
  const search: MarketSettingsTabInjected['search'] = async (request) => {
    const result = await market().search(request)
    if (!result.ok) {
      throw new Error(`market.search failed: ${result.error.code}: ${result.error.message}`)
    }
    return result.value
  }
  const install: MarketSettingsTabInjected['install'] = async (request) => {
    const result = await market().install(request)
    if (!result.ok) {
      throw new Error(`market.install failed: ${result.error.code}: ${result.error.message}`)
    }
    return result.value
  }
  const injected = (): MarketSettingsTabInjected => ({ search, install })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'market',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, MarketSettingsTab))
}
