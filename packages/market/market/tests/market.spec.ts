import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import MarketGateway, { MarketService, resolveMarketConfig } from '../src/index.ts'
import type { MarketInstallRequest, MarketInstallResult, MarketSearchRequest, MarketSearchResult } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Provider stand-in: the gateway owns no policy, so it only has to be called. */
class StubMarket extends MarketService {
  readonly seen: string[] = []

  override search(request: MarketSearchRequest): Promise<MarketSearchResult> {
    this.seen.push(`search:${request.query}`)
    return Promise.resolve({ entries: [{ name: 'p', version: '1.0.0', description: null, updatedAt: null }] })
  }

  override install(request: MarketInstallRequest): Promise<MarketInstallResult> {
    this.seen.push(`install:${request.package}`)
    return Promise.resolve({ package: request.package, version: '1.0.0', profileDir: '/p', restartRequired: true })
  }
}

describe('resolveMarketConfig', () => {
  it('resolves $DSH_HOME/profiles/<profile> and the profile patch layer', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-market-home-'))
    const config = resolveMarketConfig({ dshHome: home, profile: 'web' })
    expect(config.registryUrl).toBe('https://registry.npmjs.org')
    expect(config.profileDir).toBe(join(home, 'profiles', 'web'))
    expect(config.patchPath).toBe(join(home, 'profiles', 'web', 'cordis.patch.yml'))
    expect(config.maxResults).toBe(10)
  })

  it('strips trailing slashes from the configured registry URL', () => {
    expect(resolveMarketConfig({ registryUrl: 'http://localhost:4873/' }).registryUrl).toBe('http://localhost:4873')
  })

  it('rejects a registry URL that is not an absolute http(s) URL', () => {
    expect(() => resolveMarketConfig({ registryUrl: 'registry.example.com' })).toThrow(/is not an absolute URL/)
    expect(() => resolveMarketConfig({ registryUrl: 'ftp://registry.example.com' })).toThrow(/must use http or https/)
  })

  it('rejects registry credentials', () => {
    expect(() => resolveMarketConfig({ registryUrl: 'https://user:pw@registry.example.com' }))
      .toThrow(/must not carry credentials/)
  })

  it('bounds maxResults', () => {
    expect(() => resolveMarketConfig({ maxResults: 0 })).toThrow(/maxResults must be an integer of at least 1/)
    expect(() => resolveMarketConfig({ maxResults: 2.5 })).toThrow(/maxResults must be an integer/)
    expect(() => resolveMarketConfig({ maxResults: 51 })).toThrow(/maxResults must not exceed 50/)
  })

  it('rejects a blank package manager and a non-positive bound', () => {
    expect(() => resolveMarketConfig({ packageManager: '  ' })).toThrow(/packageManager must not be blank/)
    expect(() => resolveMarketConfig({ maxOutputBytes: 0 })).toThrow(/maxOutputBytes must be an integer of at least 1/)
  })

  it('rejects a profile name the launcher would refuse', () => {
    expect(() => resolveMarketConfig({ profile: '..' })).toThrow(/invalid profile name/)
  })
})

describe('MarketGateway', () => {
  it('publishes search and install under the market wire namespace', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(StubMarket)
    await ctx.plugin(MarketGateway)
    const gateway = ctx.get('marketGateway') as MarketGateway
    expect(gateway.typertRemote).toMatchObject({ serviceKey: 'marketGateway', namespace: 'market' })
    expect(remoteMethods(gateway)).toEqual([
      { method: 'search', invocation: { kind: 'direct' } },
      { method: 'install', invocation: { kind: 'direct' } },
    ])
  })

  it('forwards every call to the mounted provider', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(StubMarket)
    await ctx.plugin(MarketGateway)
    const provider = ctx.get('market') as StubMarket
    const gateway = ctx.get('marketGateway') as MarketGateway
    await gateway.search({ query: 'lint' })
    const installed = await gateway.install({ package: 'dsh-tool-lint' })
    expect(provider.seen).toEqual(['search:lint', 'install:dsh-tool-lint'])
    expect(installed).toEqual({ package: 'dsh-tool-lint', version: '1.0.0', profileDir: '/p', restartRequired: true })
  })
})
