import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollect,
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NpmMarketService, { resolveSearchSpec } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** One published manifest, as the registry serves it. */
function manifest(name: string, version: string, description: string | undefined, dsh: unknown): unknown {
  return { name, version, ...description === undefined ? {} : { description }, ...dsh === undefined ? {} : { dsh } }
}

/** Registry answers keyed by exact request URL. */
function stubRegistry(routes: Record<string, unknown>): string[] {
  const requested: string[] = []
  vi.stubGlobal('fetch', (input: string) => {
    requested.push(input)
    if (!(input in routes)) return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' })
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(routes[input]),
    })
  })
  return requested
}

/** Subprocess stand-in that records the spec and reports one exit code. */
class StubSubprocess extends SubprocessRuntime {
  readonly specs: SubprocessSpawnSpec[] = []
  private readonly code: number
  private readonly stderr: string

  constructor(ctx: Context, config: { code?: number; stderr?: string } = {}) {
    super(ctx)
    this.code = config.code ?? 0
    this.stderr = config.stderr ?? ''
  }

  override resolveExecutable(command: string): Promise<string> {
    return Promise.resolve(command)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
    const stderrMode = spec.stdio.stderr as SubprocessCollect
    return {
      pid: 1,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: {
        ...(spec.stdio.stdout === 'inherit' || spec.stdio.stdout === 'pipe'
          ? {}
          : { stdout: reader('') }),
        stderr: reader(this.stderr.slice(0, stderrMode.maxBytes)),
      },
      done: Promise.resolve({ exitCode: this.code, signal: null }),
      terminate: () => {},
      waitForExit: () => Promise.resolve(true),
    }
  }

  override spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<never> {
    return Promise.reject(new Error('unused'))
  }
}

/** One initialized profile under a fresh harness home. */
function profileHome(patchLayer = '[]\n'): { home: string; profileDir: string; patchPath: string } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-market-'))
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), '{\n  "name": "dsh-profile-web",\n  "private": true\n}\n')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  writeFileSync(patchPath, patchLayer)
  return { home, profileDir, patchPath }
}

/** Mount the provider over a stub registry and subprocess. */
async function harness(
  routes: Record<string, unknown>,
  options: { code?: number; stderr?: string; patchLayer?: string } = {},
): Promise<{
  ctx: Context
  service: NpmMarketService
  subprocess: StubSubprocess
  profile: ReturnType<typeof profileHome>
  requested: string[]
}> {
  const profile = profileHome(options.patchLayer)
  const requested = stubRegistry(routes)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(StubSubprocess, {
    ...options.code === undefined ? {} : { code: options.code },
    ...options.stderr === undefined ? {} : { stderr: options.stderr },
  })
  await ctx.plugin(NpmMarketService, {
    dshHome: profile.home,
    profile: 'web',
    registryUrl: 'http://registry.test',
  })
  return {
    ctx,
    service: ctx.get('market') as NpmMarketService,
    subprocess: ctx.get('subprocess') as StubSubprocess,
    profile,
    requested,
  }
}

describe('resolveSearchSpec', () => {
  it('requires a non-blank query', () => {
    expect(() => resolveSearchSpec({ query: '   ' }, 10)).toThrow(/non-blank query/)
  })

  it('clamps the requested count to the configured bound', () => {
    expect(resolveSearchSpec({ query: ' lint ' }, 10)).toEqual({ query: 'lint', limit: 10 })
    expect(resolveSearchSpec({ query: 'lint', limit: 3 }, 10)).toEqual({ query: 'lint', limit: 3 })
    expect(resolveSearchSpec({ query: 'lint', limit: 40 }, 10)).toEqual({ query: 'lint', limit: 10 })
  })

  it('rejects a non-positive count', () => {
    expect(() => resolveSearchSpec({ query: 'lint', limit: 0 }, 10)).toThrow(/positive integer/)
  })
})

describe('search', () => {
  it('keeps official-scope and dsh-declaring candidates only', async () => {
    const { service } = await harness({
      'http://registry.test/-/v1/search?text=plugin&size=10': {
        objects: [
          { package: { name: '@deepseek-ai/dsh-tool-lint', date: '2026-01-01T00:00:00.000Z' } },
          { package: { name: 'dsh-client-panel', date: '2026-01-02T00:00:00.000Z' } },
          { package: { name: 'left-pad' } },
          { package: { name: '@acme/dsh-gadget' } },
          { package: { name: 'dsh-gone' } },
          { package: { name: 'dsh-bundle' } },
        ],
      },
      // An official-scope package is discoverable without any `dsh` metadata.
      'http://registry.test/%40deepseek-ai%2Fdsh-tool-lint/latest': manifest('@deepseek-ai/dsh-tool-lint', '0.1.0-rc.7', undefined, undefined),
      'http://registry.test/dsh-client-panel/latest': manifest('dsh-client-panel', '2.0.0', 'A panel', { client: {} }),
      'http://registry.test/left-pad/latest': manifest('left-pad', '1.3.0', 'padding', undefined),
      'http://registry.test/%40acme%2Fdsh-gadget/latest': manifest('@acme/dsh-gadget', '1.0.0', 'unofficial', undefined),
      'http://registry.test/dsh-bundle/latest': manifest('dsh-bundle', '0.4.1', undefined, { bundle: { patch: './p.yml' } }),
    })
    const result = await service.search({ query: 'plugin' })
    expect(result.entries).toEqual([
      { name: '@deepseek-ai/dsh-tool-lint', version: '0.1.0-rc.7', description: null, updatedAt: '2026-01-01T00:00:00.000Z' },
      { name: 'dsh-client-panel', version: '2.0.0', description: 'A panel', updatedAt: '2026-01-02T00:00:00.000Z' },
      { name: 'dsh-bundle', version: '0.4.1', description: null, updatedAt: null },
    ])
  })

  it('asks the registry for at most the configured number of candidates', async () => {
    const { service, requested } = await harness({
      'http://registry.test/-/v1/search?text=lint&size=2': { objects: [] },
    })
    await expect(service.search({ query: 'lint', limit: 2 })).resolves.toEqual({ entries: [] })
    expect(requested).toEqual(['http://registry.test/-/v1/search?text=lint&size=2'])
  })

  it('encodes a scoped candidate name in its manifest URL', async () => {
    const { service, requested } = await harness({
      'http://registry.test/-/v1/search?text=scoped&size=10': { objects: [{ package: { name: '@scope/plugin' } }] },
      'http://registry.test/%40scope%2Fplugin/latest': manifest('@scope/plugin', '1.0.0', undefined, { client: {} }),
    })
    await service.search({ query: 'scoped' })
    expect(requested).toContain('http://registry.test/%40scope%2Fplugin/latest')
  })

  it('fails loud when the index answers without an object list', async () => {
    const { service } = await harness({
      'http://registry.test/-/v1/search?text=lint&size=10': { total: 0 },
    })
    await expect(service.search({ query: 'lint' })).rejects.toThrow(/did not return a search result object list/)
  })
})

describe('install', () => {
  it('installs the exact version into the profile and registers the loader row', async () => {
    const { service, subprocess, profile } = await harness({
      'http://registry.test/%40scope%2Fplugin/1.2.3': manifest('@scope/plugin', '1.2.3', 'A panel', { client: {} }),
    })
    const result = await service.install({ package: '@scope/plugin', version: '1.2.3' })
    expect(result).toEqual({
      package: '@scope/plugin',
      version: '1.2.3',
      profileDir: profile.profileDir,
      restartRequired: true,
    })
    expect(subprocess.specs).toHaveLength(1)
    expect(subprocess.specs[0]?.argv.slice(1)).toEqual(['add', '@scope/plugin@1.2.3'])
    expect(subprocess.specs[0]?.cwd).toBe(profile.profileDir)
    // The package manager's store stays inside the harness home.
    expect(subprocess.specs[0]?.env?.['npm_config_store_dir'])
      .toBe(join(profile.profileDir, '..', '.pnpm-store'))
    expect(yaml.load(readFileSync(profile.patchPath, 'utf8'))).toEqual([
      { insert: [{ id: 'market-scope-plugin', name: '@scope/plugin' }] },
    ])
  })

  it('resolves the latest published version when the request pins none', async () => {
    const { service, subprocess } = await harness({
      'http://registry.test/dsh-tool-lint/latest': manifest('dsh-tool-lint', '3.1.0', 'linting', { client: {} }),
    })
    await expect(service.install({ package: 'dsh-tool-lint' })).resolves.toMatchObject({ version: '3.1.0' })
    expect(subprocess.specs[0]?.argv.slice(1)).toEqual(['add', 'dsh-tool-lint@3.1.0'])
  })

  it('keeps an existing patch layer and appends one row for a fresh package', async () => {
    const existing = '- id: timer\n  disabled: true\n'
    const { service, profile } = await harness({
      'http://registry.test/dsh-tool-lint/latest': manifest('dsh-tool-lint', '1.0.0', undefined, { client: {} }),
    }, { patchLayer: existing })
    await service.install({ package: 'dsh-tool-lint' })
    const written = readFileSync(profile.patchPath, 'utf8')
    expect(written).toContain('- id: timer')
    expect(written).toContain('name: dsh-tool-lint')
  })

  it('is idempotent for a package already registered', async () => {
    const layer = '- insert:\n    - id: market-dsh-tool-lint\n      name: dsh-tool-lint\n'
    const { service, profile } = await harness({
      'http://registry.test/dsh-tool-lint/latest': manifest('dsh-tool-lint', '1.0.0', undefined, { client: {} }),
    }, { patchLayer: layer })
    await service.install({ package: 'dsh-tool-lint' })
    expect(readFileSync(profile.patchPath, 'utf8')).toBe(layer)
  })

  it('installs an official-scope package that declares no dsh field', async () => {
    const { service, subprocess } = await harness({
      'http://registry.test/%40deepseek-ai%2Fdsh-tool-lint/latest': manifest('@deepseek-ai/dsh-tool-lint', '0.1.0-rc.7', undefined, undefined),
    })
    await expect(service.install({ package: '@deepseek-ai/dsh-tool-lint' }))
      .resolves.toMatchObject({ package: '@deepseek-ai/dsh-tool-lint', version: '0.1.0-rc.7' })
    expect(subprocess.specs[0]?.argv.slice(1)).toEqual(['add', '@deepseek-ai/dsh-tool-lint@0.1.0-rc.7'])
  })

  it('refuses a package that publishes no dsh field', async () => {
    const { service, subprocess } = await harness({
      'http://registry.test/left-pad/latest': manifest('left-pad', '1.3.0', 'padding', undefined),
    })
    await expect(service.install({ package: 'left-pad' })).rejects.toThrow(/is not a published DSH plugin/)
    expect(subprocess.specs).toEqual([])
  })

  it('refuses a version pin that is not exact', async () => {
    const { service, subprocess } = await harness({})
    await expect(service.install({ package: 'dsh-tool-lint', version: '^1.0.0' }))
      .rejects.toThrow(/is not an exact published version/)
    expect(subprocess.specs).toEqual([])
  })

  it('refuses a package name outside npm grammar', async () => {
    const { service } = await harness({})
    await expect(service.install({ package: '../../etc' })).rejects.toThrow(/is not a valid package name/)
  })

  it('reports the package-manager stderr tail when the install fails', async () => {
    const { service, profile } = await harness({
      'http://registry.test/dsh-tool-lint/latest': manifest('dsh-tool-lint', '1.0.0', undefined, { client: {} }),
    }, { code: 1, stderr: 'ERR_PNPM_NO_MATCHING_VERSION' })
    await expect(service.install({ package: 'dsh-tool-lint' }))
      .rejects.toThrow(/pnpm add dsh-tool-lint@1.0.0 failed \(exit 1, signal null\): ERR_PNPM_NO_MATCHING_VERSION/)
    expect(readFileSync(profile.patchPath, 'utf8')).toBe('[]\n')
  })

  it('refuses to install into a profile that does not exist', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-market-empty-'))
    stubRegistry({
      'http://registry.test/dsh-tool-lint/latest': manifest('dsh-tool-lint', '1.0.0', undefined, { client: {} }),
    })
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(StubSubprocess)
    await ctx.plugin(NpmMarketService, { dshHome: home, profile: 'web', registryUrl: 'http://registry.test' })
    await expect((ctx.get('market') as NpmMarketService).install({ package: 'dsh-tool-lint' }))
      .rejects.toThrow(/profile "web" does not exist/)
  })
})

describe('load-time config validation', () => {
  it('fails the plugin load on an unusable registry URL', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(StubSubprocess)
    await expect(ctx.plugin(NpmMarketService, { registryUrl: 'not-a-url' }))
      .rejects.toThrow(/registryUrl .* is not an absolute URL/)
  })
})
