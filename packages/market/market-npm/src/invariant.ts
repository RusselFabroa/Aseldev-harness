/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-market-npm`.
 * @module @deepseek-ai/dsh-market-npm/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-market-npm'

/** Cordis companion plugin name. */
export const name = 'market-npm-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this provider keeps no cache, session event, or
 * lifecycle state — every call reads the registry or the profile afresh, and
 * the profile files it writes are the Launcher's own sources of truth.
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
