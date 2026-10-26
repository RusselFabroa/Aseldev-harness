/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-market`.
 * @module @deepseek-ai/dsh-market/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-market'

/** Cordis companion plugin name. */
export const name = 'market-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package declares the seam and forwards Remote
 * calls to whichever provider is mounted, so it owns no event stream, mutable
 * data, or lifecycle of its own to relate.
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
