/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-brain`.
 * @module @deepseek-ai/dsh-tool-brain/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-brain'

/** Cordis companion plugin name. */
export const name = 'tool-brain-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the tools are pure reads over the brain provider,
 * append no package-owned session events (their calls/results log through the
 * core `tool/call` / `tool/result` pair), and own no cross-plugin mutable
 * state. Result bounds are the provider's to enforce.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
