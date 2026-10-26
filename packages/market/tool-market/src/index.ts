/**
 * Model-facing plugin-market tools. `market_search` finds installable DSH
 * plugins in the configured registry; `plugin_install` installs one into the
 * configured profile. Both forward to `ctx.market` — this package owns the
 * schemas, argument checks, result formatting, render intent, and the approval
 * question an install must answer, never registry access or package management.
 * @module @deepseek-ai/dsh-tool-market
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, GenericResultView, ToolResult } from '@deepseek-ai/dsh-tools'
// Type-only: makes `ctx.market` and the `approval` service reachable.
import type {} from '@deepseek-ai/dsh-market'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { MarketPluginEntry } from '@deepseek-ai/dsh-market'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-market'

/** Services required by the market tool suite. */
export const inject = ['tools', 'market']

/** Default cooperative budget (ms) for one `market_search` call. */
export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000

/** Default cooperative budget (ms) for one `plugin_install` call; a download outlasts a search. */
export const DEFAULT_INSTALL_TIMEOUT_MS = 300_000

/** Plugin config: the per-tool cooperative budgets. */
export interface Config {
  /** Cooperative timeout budget (ms) for `market_search`. Defaults to 30000. */
  searchTimeoutMs?: number
  /** Cooperative timeout budget (ms) for `plugin_install`. Defaults to 300000. */
  installTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  searchTimeoutMs: z.number().default(DEFAULT_SEARCH_TIMEOUT_MS),
  installTimeoutMs: z.number().default(DEFAULT_INSTALL_TIMEOUT_MS),
})

/** Canonical `market_search` output value. */
export interface MarketSearchOutput {
  entries: MarketPluginEntryOutput[]
}

/** One entry as the tool reports it. */
export interface MarketPluginEntryOutput {
  name: string
  version: string
  description?: string
  updatedAt?: string
}

/** Canonical `plugin_install` output value. */
export interface PluginInstallOutput {
  package: string
  version: string
  profileDir: string
  restartRequired: boolean
}

/** Schema of one reported plugin entry, shared by the tool schema and its projections. */
const PLUGIN_ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    version: { type: 'string', required: true },
    description: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const

/** Project one seam entry, omitting absent optional fields. */
function projectEntry(entry: MarketPluginEntry): MarketPluginEntryOutput {
  return {
    name: entry.name,
    version: entry.version,
    ...entry.description === null ? {} : { description: entry.description },
    ...entry.updatedAt === null ? {} : { updatedAt: entry.updatedAt },
  }
}

/**
 * Format a search outcome as one model-facing text block.
 * @param output - the canonical `market_search` value.
 * @returns one line per plugin, or a no-results line.
 */
export function formatSearchOutput(output: MarketSearchOutput): string {
  if (output.entries.length === 0) {
    return 'No installable plugins matched. Try different words; this registry lists packages published under @deepseek-ai/dsh- and packages that declare a dsh manifest field.'
  }
  const lines = output.entries.map((entry) => {
    const description = entry.description === undefined ? '' : ` — ${entry.description}`
    return `- ${entry.name}@${entry.version}${description}`
  })
  return `Installable plugins:\n${lines.join('\n')}\n\nInstall one with plugin_install and its exact name.`
}

/**
 * Format an install outcome as one model-facing text block.
 * @param output - the canonical `plugin_install` value.
 * @returns what was installed and what the user must do to use it.
 */
export function formatInstallOutput(output: PluginInstallOutput): string {
  const restart = output.restartRequired
    ? ' It is registered for the next boot; restart dsh before the plugin can mount.'
    : ''
  return `Installed ${output.package}@${output.version} into ${output.profileDir}.${restart}`
}

/**
 * Pending-call presentation for `market_search`.
 * @param args - the raw tool arguments; only `query` feeds the view.
 * @returns the generic discovery card shown while the call runs.
 */
export function presentSearchCall(args: { query: string }): GenericCallView {
  return { card: 'generic', title: args.query, kind: 'read', rawInput: args.query }
}

/**
 * Pending-call presentation for `plugin_install`.
 * @param args - the raw tool arguments; `package` and `version` label the install.
 * @returns the generic install card shown while the call runs.
 */
export function presentInstallCall(args: { package: string; version?: string }): GenericCallView {
  const title = args.version === undefined ? args.package : `${args.package}@${args.version}`
  return { card: 'generic', title: `Install ${title}`, kind: 'execute', rawInput: title }
}

/**
 * Completed-call presentation for `plugin_install`: the installed version and
 * where it landed, both derivable from the arguments only when the call
 * succeeded.
 * @param args - the raw tool arguments.
 * @param result - the final model-facing tool result.
 * @returns the completed generic card, or `undefined` to keep the raw content.
 */
export function presentInstallResult(
  args: { package: string; version?: string },
  result: ToolResult,
): GenericResultView | undefined {
  if (result.isError) return undefined
  return {
    card: 'generic',
    title: args.version === undefined ? args.package : `${args.package}@${args.version}`,
  }
}

/** Configured budget must be a positive integer. */
function assertPositiveInteger(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-market: ${label} must be a positive integer`)
  }
}

/**
 * Register the market tools. Both budgets are attached to their tool as
 * `ToolDefinition.timeoutMs` for `@deepseek-ai/dsh-tool-call-timeout-policy` to
 * enforce; the registrations are effect-scoped and unregister on dispose.
 * @param ctx - context carrying `ctx.tools` and `ctx.market`.
 * @param config - the deployment's per-tool budgets.
 */
export function apply(ctx: Context, config: Config): void {
  const searchTimeoutMs = config.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS
  const installTimeoutMs = config.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS
  assertPositiveInteger('searchTimeoutMs', searchTimeoutMs)
  assertPositiveInteger('installTimeoutMs', installTimeoutMs)

  ctx.tools.register(defineTool({
    name: 'market_search',
    description: 'Search the plugin registry for installable DSH plugins. Returns each plugin name, version, and description.',
    parameters: {
      query: { type: 'string', required: true, description: 'Words describing what the plugin should do.' },
      limit: { type: 'number', description: 'How many plugins to return; the deployment caps this.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: { type: 'array', required: true, items: PLUGIN_ENTRY_SCHEMA },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatSearchOutput(value) }],
    },
    timeoutMs: searchTimeoutMs,
    // A registry read mutates nothing.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = args.query.trim()
      if (query === '') throw new Error('query must be a non-empty string')
      const result = await ctx.market.search(
        { query, ...args.limit === undefined ? {} : { limit: args.limit } },
        exec.signal,
      )
      return { entries: result.entries.map(projectEntry) }
    },
    presentCall: presentSearchCall,
  }))

  ctx.tools.register(defineTool({
    name: 'plugin_install',
    description: 'Install a DSH plugin from the plugin registry into the current profile. Installing runs the machine user\'s package manager and changes what the next boot mounts, so the user must approve it.',
    parameters: {
      package: { type: 'string', required: true, description: 'Exact published package name, as market_search returned it.' },
      version: { type: 'string', description: 'Exact published version to install; the latest version when omitted.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          package: { type: 'string', required: true },
          version: { type: 'string', required: true },
          profileDir: { type: 'string', required: true },
          restartRequired: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatInstallOutput(value) }],
    },
    timeoutMs: installTimeoutMs,
    async execute(args, exec) {
      const target = args.version === undefined ? args.package : `${args.package}@${args.version}`
      const approval = ctx.get('approval')
      if (exec.agent === undefined) {
        throw new Error(`plugin_install cannot be approved without an agent to route the question through (${target})`)
      }
      if (approval === undefined) {
        throw new Error(`plugin_install requires an approval channel and this deployment composes none (${target})`)
      }
      const outcome = await approval.request({
        agent: exec.agent,
        toolName: 'plugin_install',
        callId: exec.callId,
        reason: `install ${target} from the plugin registry into the dsh profile`,
        signal: exec.signal,
      })
      if (outcome !== 'allowed-once') {
        throw new Error(outcome === 'rejected'
          ? `the user rejected installing ${target}`
          : outcome === 'cancelled'
            ? `approval for installing ${target} was cancelled`
            : `no approval channel is available to install ${target}`)
      }
      const result = await ctx.market.install(
        { package: args.package, ...args.version === undefined ? {} : { version: args.version } },
        exec.signal,
      )
      return {
        package: result.package,
        version: result.version,
        profileDir: result.profileDir,
        restartRequired: result.restartRequired,
      }
    },
    presentCall: presentInstallCall,
    presentResult: (args, result) => presentInstallResult(args, result),
  }))
}
