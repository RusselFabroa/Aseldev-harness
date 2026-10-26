// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS } from '../src/client/index.ts'
import { MarketSettingsTab } from '../src/client/MarketSettingsTab.tsx'
import type { MarketSettingsTabInjected } from '../src/client/MarketSettingsTab.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

const FOUND = { entries: [] }
type Found = typeof FOUND
type Installed = { package: string; version: string; profileDir: string; restartRequired: boolean }
type RemoteAnswer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

async function bench(provideMarket = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  const search = vi.fn<() => Promise<RemoteAnswer<Found>>>()
    .mockResolvedValue({ ok: true, value: FOUND })
  const install = vi.fn<() => Promise<RemoteAnswer<Installed>>>()
  if (provideMarket) ctx.provide('remote.market', { search, install })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, search, install }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-market browser plugin', () => {
  it('declares only the services used by the Settings Remote contribution', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('activates without a Market API and resolves it only when an action runs', async () => {
    const b = await bench(false)
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.plugins.tab')[0]!
    const injected = (entry.inject as unknown as () => MarketSettingsTabInjected)()
    await expect(injected.search({ query: 'dsh' })).rejects.toThrow('Market API is unavailable')
    await expect(injected.install({ package: 'pkg' })).rejects.toThrow('Market API is unavailable')
    expect(b.search).not.toHaveBeenCalled()
    b.ctx.provide('remote.market', { search: b.search, install: b.install })
    await expect(injected.search({ query: 'dsh' })).resolves.toEqual(FOUND)
    await b.ctx.fiber.dispose()
  })

  it('registers a localized tab without reading the Remote eagerly', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('settings.plugins.tab')[0]!
    expect(entry.component).toBe(MarketSettingsTab)
    expect(entry.options).toMatchObject({ id: 'market', order: 20 })
    expect(entry.locale).toBe(NS)
    expect(resolveSlotLabel(entry.options.label)).toBe('插件市场')
    expect(b.search).not.toHaveBeenCalled()

    const injected = (entry.inject as unknown as () => MarketSettingsTabInjected)()
    await expect(injected.search({ query: 'dsh' })).resolves.toEqual(FOUND)
    expect(b.search).toHaveBeenCalledWith({ query: 'dsh' })
    b.search.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'unavailable' } })
    await expect(injected.search({ query: 'dsh' })).rejects
      .toThrow('market.search failed: REMOTE_ERROR: unavailable')

    b.install.mockResolvedValueOnce({
      ok: true,
      value: { package: 'pkg', version: '1.0.0', profileDir: '/profiles/web', restartRequired: true },
    })
    await expect(injected.install({ package: 'pkg' })).resolves.toMatchObject({ version: '1.0.0' })
    expect(b.install).toHaveBeenCalledWith({ package: 'pkg' })
    b.install.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'denied' } })
    await expect(injected.install({ package: 'pkg' })).rejects
      .toThrow('market.install failed: REMOTE_ERROR: denied')
    await b.ctx.fiber.dispose()
  })

  it('follows locale and recovers across late declaration and declarer reload', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)

    const stop = declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.plugins.tab')).toHaveLength(1) })
    b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.plugins.tab')[0]!.options.label)).toBe('Market')

    stop()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    declare(b.slots)
    await vi.waitFor(() => {
      expect(b.slots.entries('settings.plugins.tab')[0]?.component).toBe(MarketSettingsTab)
    })

    await fiber.dispose()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    expect(() => b.locale.register(NS, 'zh', {})).not.toThrow()
    await b.ctx.fiber.dispose()
  })
})
