/**
 * AselDev Skills page plugin, node half. Pure UI plugin: the empty apply
 * exists so the plugin appears in the host Loader; the browser half ships via
 * exports["./client"]. The file operations live in the separate host plugin
 * at aseldev-plugins/skills-manager/host.ts.
 */

/** Host plugin body — no host-side behavior for the Skills page plugin. */
export function apply(): void {}
