import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { MarketService } from '@deepseek-ai/dsh-market'
import type { MarketInstallResult, MarketSearchResult } from '@deepseek-ai/dsh-market'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import * as ToolMarket from '../src/index.ts'
import {
  formatInstallOutput,
  formatSearchOutput,
  presentInstallCall,
  presentSearchCall,
} from '../src/index.ts'

const contexts: Context[] = []
const testToolSignal = new AbortController().signal

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Provider stand-in: the tools own schemas, formatting, and the approval question. */
class StubMarket extends MarketService {
  readonly calls: string[] = []

  override search(): Promise<MarketSearchResult> {
    this.calls.push('search')
    return Promise.resolve({
      entries: [{ name: 'dsh-tool-lint', version: '1.0.0', description: 'Linting', updatedAt: null }],
    })
  }

  override install(): Promise<MarketInstallResult> {
    this.calls.push('install')
    return Promise.resolve({
      package: 'dsh-tool-lint',
      version: '1.0.0',
      profileDir: '/home/.dsh/profiles/web',
      restartRequired: true,
    })
  }
}

async function harness(): Promise<{
  ctx: Context
  market: StubMarket
  call: (name: string, args: unknown) => Promise<ToolExecutionResult>
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(StubMarket)
  await ctx.plugin(ToolMarket)
  let counter = 0
  return {
    ctx,
    market: ctx.get('market') as StubMarket,
    call: (name, args) => ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId(`call-${++counter}`),
      name,
      arguments: args,
    }),
  }
}

describe('registration', () => {
  it('registers market_search and plugin_install with their budgets', async () => {
    const { ctx } = await harness()
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('market_search')
    expect(names).toContain('plugin_install')
  })

  it('rejects a non-positive budget at load', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(StubMarket)
    await expect(ctx.plugin(ToolMarket, { searchTimeoutMs: 0 }))
      .rejects.toThrow(/tool-market: searchTimeoutMs must be a positive integer/)
  })
})

describe('market_search', () => {
  it('returns the seam entries and renders them as one list', async () => {
    const { market, call } = await harness()
    const out = await call('market_search', { query: 'lint' })
    expect(out.isError).toBe(false)
    expect(out.value).toEqual({
      entries: [{ name: 'dsh-tool-lint', version: '1.0.0', description: 'Linting' }],
    })
    expect(market.calls).toEqual(['search'])
    expect(JSON.stringify(out.content)).toContain('dsh-tool-lint@1.0.0 — Linting')
  })

  it('rejects a blank query before reaching the seam', async () => {
    const { market, call } = await harness()
    const out = await call('market_search', { query: '   ' })
    expect(out.isError).toBe(true)
    expect(market.calls).toEqual([])
  })
})

describe('plugin_install', () => {
  it('fails closed when the call has no agent to route approval through', async () => {
    const { market, call } = await harness()
    const out = await call('plugin_install', { package: 'dsh-tool-lint' })
    expect(out.isError).toBe(true)
    expect(JSON.stringify(out.content)).toContain('cannot be approved without an agent')
    expect(market.calls).toEqual([])
  })
})

describe('presenters and formatting', () => {
  it('presents a search call as a read card titled by the query', () => {
    expect(presentSearchCall({ query: 'lint' })).toEqual({
      card: 'generic',
      title: 'lint',
      kind: 'read',
      rawInput: 'lint',
    })
  })

  it('presents an install call as an execute card naming the pinned target', () => {
    expect(presentInstallCall({ package: 'dsh-tool-lint', version: '1.0.0' })).toEqual({
      card: 'generic',
      title: 'Install dsh-tool-lint@1.0.0',
      kind: 'execute',
      rawInput: 'dsh-tool-lint@1.0.0',
    })
  })

  it('explains an empty search by naming both discovery rules', () => {
    expect(formatSearchOutput({ entries: [] })).toContain('@deepseek-ai/dsh-')
    expect(formatSearchOutput({ entries: [] })).toContain('dsh manifest field')
  })

  it('states the restart requirement after a successful install', () => {
    expect(formatInstallOutput({
      package: 'dsh-tool-lint',
      version: '1.0.0',
      profileDir: '/home/.dsh/profiles/web',
      restartRequired: true,
    })).toBe(
      'Installed dsh-tool-lint@1.0.0 into /home/.dsh/profiles/web. '
      + 'It is registered for the next boot; restart dsh before the plugin can mount.',
    )
  })
})
