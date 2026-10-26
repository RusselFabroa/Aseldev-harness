/**
 * npm-registry access for the market provider: one index query, the
 * per-candidate manifest confirmation behind it, and the two rules that
 * distinguish a DSH plugin from an unrelated package.
 */

import type {
  MarketPluginEntry,
  MarketSearchResult,
  ResolvedMarketConfig,
} from '@deepseek-ai/dsh-market'

/** Manifest fields this provider reads; everything else in the document is ignored. */
export interface PluginManifest {
  /** The published package name, as the registry spells it. */
  readonly name: string
  /** The exact published version this document describes. */
  readonly version: string
  /** The published one-line description, when the document carries one. */
  readonly description: string | null
}

/** The `dsh` manifest section a DSH plugin publishes; only truthiness matters here. */
const DSH_MANIFEST_KEY = 'dsh'

/**
 * Official plugins publish under this name prefix, so the scope alone places
 * them in the market; every other package needs the `dsh` manifest field.
 */
const OFFICIAL_PLUGIN_PREFIX = '@deepseek-ai/dsh-'

/** Registry search returns at most this many objects per page; the index caps `size` itself. */
const INDEX_PAGE_LIMIT = 250

/** Bound one request: the caller's cancellation plus the configured deadline. */
function requestSignal(config: ResolvedMarketConfig, signal: AbortSignal | undefined): AbortSignal {
  const deadline = AbortSignal.timeout(config.requestTimeoutMs)
  return signal === undefined ? deadline : AbortSignal.any([signal, deadline])
}

/**
 * Read one registry JSON document.
 * @param url - absolute registry URL.
 * @param config - resolved config supplying the request deadline.
 * @param signal - caller cancellation.
 * @returns the parsed JSON document.
 */
async function getJson(
  url: string,
  config: ResolvedMarketConfig,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const response = await fetch(url, { signal: requestSignal(config, signal) })
  if (!response.ok) {
    throw new Error(`dsh-market: ${url} responded ${String(response.status)} ${response.statusText}`)
  }
  return await response.json()
}

/** Read an optional string field from an untyped JSON document. */
function optionalString(document: Record<string, unknown>, key: string): string | null {
  const value = document[key]
  return typeof value === 'string' ? value : null
}

/**
 * Read one candidate's published manifest and decide whether it is a DSH
 * plugin. A package the registry does not have at that version is not a
 * plugin; any other package is one when its name carries the official
 * `@deepseek-ai/dsh-` prefix or its manifest carries a truthy `dsh` field.
 * Both refusals are the filter, not an error.
 * @param config - resolved config supplying the registry base URL.
 * @param name - published package name.
 * @param version - exact version, or `undefined` for the latest published one.
 * @param signal - caller cancellation.
 * @returns the manifest of a DSH plugin, or `undefined` for any other package.
 */
export async function findPluginManifest(
  config: ResolvedMarketConfig,
  name: string,
  version: string | undefined,
  signal: AbortSignal | undefined,
): Promise<PluginManifest | undefined> {
  const url = `${config.registryUrl}/${encodeURIComponent(name)}/${version === undefined ? 'latest' : encodeURIComponent(version)}`
  const response = await fetch(url, { signal: requestSignal(config, signal) })
  // A yanked version or an unindexed package is a definitive "not a plugin".
  if (response.status === 404) return undefined
  if (!response.ok) {
    throw new Error(`dsh-market: ${url} responded ${String(response.status)} ${response.statusText}`)
  }
  const document: unknown = await response.json()
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new Error(`dsh-market: manifest of ${name} is not a JSON object`)
  }
  const manifest = document as Record<string, unknown>
  if (!name.startsWith(OFFICIAL_PLUGIN_PREFIX) && !manifest[DSH_MANIFEST_KEY]) return undefined
  const publishedVersion = manifest['version']
  if (typeof publishedVersion !== 'string' || publishedVersion === '') {
    throw new Error(`dsh-market: manifest of ${name} declares no version`)
  }
  return { name, version: publishedVersion, description: optionalString(manifest, 'description') }
}

/**
 * Run one index query and keep only the candidates confirmed as DSH plugins.
 * @param config - resolved config supplying the registry base URL and entry bound.
 * @param query - non-empty search text.
 * @param limit - requested entry count; clamped to the configured bound.
 * @param signal - caller cancellation.
 * @returns confirmed plugins in index relevance order, never more than the bound.
 */
export async function searchRegistry(
  config: ResolvedMarketConfig,
  query: string,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<MarketSearchResult> {
  const size = Math.min(limit, config.maxResults, INDEX_PAGE_LIMIT)
  const url = `${config.registryUrl}/-/v1/search?text=${encodeURIComponent(query)}&size=${String(size)}`
  const payload = await getJson(url, config, signal)
  const objects = (payload as { objects?: unknown } | null)?.objects
  if (!Array.isArray(objects)) {
    throw new Error(`dsh-market: ${url} did not return a search result object list`)
  }
  const candidates = objects.flatMap((object): Array<{ name: string; updatedAt: string | null }> => {
    const published = (object as { package?: unknown } | null)?.package
    if (typeof published !== 'object' || published === null || Array.isArray(published)) return []
    const name = (published as Record<string, unknown>)['name']
    if (typeof name !== 'string' || name === '') return []
    return [{ name, updatedAt: optionalString(published as Record<string, unknown>, 'date') }]
  })
  // Every candidate is probed in parallel: the index describes packages, and
  // only the manifest says whether one is a DSH plugin.
  const confirmed = await Promise.all(candidates.map(async (candidate) => {
    const manifest = await findPluginManifest(config, candidate.name, undefined, signal)
    if (manifest === undefined) return undefined
    return {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      updatedAt: candidate.updatedAt,
    } satisfies MarketPluginEntry
  }))
  return { entries: confirmed.filter(entry => entry !== undefined).slice(0, size) }
}
