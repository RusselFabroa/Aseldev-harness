/**
 * AselDev artifacts plugin, node half. Pure UI plugin: the empty apply exists
 * so the plugin appears in the host Loader; the browser half ships via
 * exports["./client"]. The `artifact` tool, storage and sandboxed page routes
 * live in the separate host plugin at aseldev-plugins/artifacts/host.ts.
 */

/** Host plugin body — no host-side behavior for the artifacts UI plugin. */
export function apply(): void {}
