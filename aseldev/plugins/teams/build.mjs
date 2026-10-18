/**
 * Build both halves of the teams plugin into `lib/`.
 *
 * 1. `client.tsx` → `lib/client.js` — the browser bundle the dsh web shell's
 *    module system loads (`window.__ModuleLoader__.load({ id, factory })`, a
 *    CJS closure whose `require` answers only the frozen platform module
 *    table). Reproduces the fields the repository's own client bundles use
 *    (`packages/client/tsdown.client.ts`) without importing anything from the
 *    repository, so the plugin stays out of tree.
 *
 * 2. `host.ts` → `lib/host.js` — the Node half as plain ESM, so an installed
 *    addon runs on a built harness (plain `node`) instead of relying on the
 *    source launcher's tsx/type-stripping loaders. Only builtins stay
 *    external: every harness package the host needs is resolved at runtime
 *    from the profile's `node_modules` by `fromProfile()`, so nothing
 *    repository-owned may be inlined here.
 *
 * 3. `engine.mjs` → `lib/engine.mjs` — a straight copy. The host loads it with
 *    `import(new URL('./engine.mjs', import.meta.url))`, which is a computed
 *    URL the bundler must leave dynamic; at runtime that URL is relative to
 *    `lib/host.js`, so the file has to sit beside it.
 *
 * Shared React: `react`, `react/jsx-runtime`, and the other platform modules
 * stay EXTERNAL, so the emitted client bundle calls `require("react")` and
 * receives the shell's single React instance. Bundling a private copy would
 * break hooks and the slot renderer; requiring a specifier the frozen table
 * does not answer throws when the bundle materializes.
 *
 * Two settings exist only to keep the build hermetic:
 * - `config: false` — do not discover `tsdown.config.ts` by walking up into
 *   the repository (that config switches on workspace mode).
 * - `tsconfig: false` — do not read that tsconfig either: its `paths` map
 *   `@deepseek-ai/*` to workspace `src`, which would inline a sibling plugin's
 *   source instead of leaving it external (and for the host: would bundle
 *   harness Service Definitions into the addon).
 *
 * Usage:
 *   node build.mjs            build both halves
 *   node build.mjs --check    fail if `lib/` is missing or older than its sources
 *
 * Run it again after any change to `host.ts` or `engine.mjs`; the Loader
 * imports `lib/host.js`, not the sources.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'tsdown'

/** This package's directory (the build cwd, so paths stay package-relative). */
const here = dirname(fileURLToPath(import.meta.url))

/** Package name; it must equal the Loader row name and the client bundle's `id`. */
const ID = '@aseldev/dsh-teams'

const LIB = join(here, 'lib')
const CLIENT_SOURCE = join(here, 'client.tsx')
const CLIENT_OUTPUT = join(LIB, 'client.js')
const HOST_SOURCE = join(here, 'host.ts')
const HOST_OUTPUT = join(LIB, 'host.js')
const ENGINE_SOURCE = join(here, 'engine.mjs')
const ENGINE_OUTPUT = join(LIB, 'engine.mjs')

/**
 * Modules answered by the shell's frozen module table
 * (`packages/client/web/src/platform.ts` plus the documented store-engine
 * exemption). Every one of them must stay external.
 */
const SHARED_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

const clientConfig = {
  config: false,
  tsconfig: false,
  name: `${ID}/client`,
  cwd: here,
  entry: { client: 'client.tsx' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  // Types are irrelevant for a fetched bundle; dts would also wrap the
  // banner/footer into a `.d.cts` and break the factory parse.
  dts: false,
  sourcemap: true,
  // Each half writes into the same lib/, so neither may wipe the directory.
  clean: false,
  external: SHARED_MODULES,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

const hostConfig = {
  config: false,
  tsconfig: false,
  name: `${ID}/host`,
  cwd: here,
  entry: { host: 'host.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  // The deployment engine range starts at Node 22; nothing here needs newer.
  target: 'node22',
  dts: false,
  sourcemap: true,
  clean: false,
  outputOptions: { entryFileNames: 'host.js' },
}

/**
 * Every specifier a built file imports, static or dynamic.
 * @param source - emitted JavaScript.
 * @returns the specifier strings found.
 */
function importedSpecifiers(source) {
  const found = new Set()
  const patterns = [/from\s*["']([^"']+)["']/g, /import\s*\(\s*["']([^"']+)["']\s*\)/g]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[1])
  }
  return [...found]
}

/**
 * Prove the emitted host bundle is runnable on plain Node: ESM, builtins and
 * the sibling engine copy only, and the engine seam still dynamic.
 * @returns the imported specifier list.
 */
function assertHostBundle() {
  if (!existsSync(HOST_OUTPUT)) throw new Error(`build: ${HOST_OUTPUT} was not emitted`)
  if (!existsSync(ENGINE_OUTPUT)) throw new Error(`build: ${ENGINE_OUTPUT} was not copied`)
  const source = readFileSync(HOST_OUTPUT, 'utf8')

  if (source.includes('\u0000')) throw new Error('build: host bundle contains a NUL marker (unresolved virtual module)')
  if (/require\s*\(/.test(source)) throw new Error('build: host bundle contains require() — it is not plain ESM')

  const foreign = importedSpecifiers(source)
    .filter(specifier => !specifier.startsWith('node:') && !specifier.startsWith('./') && !specifier.startsWith('../'))
  if (foreign.length > 0) {
    throw new Error(
      `build: host bundle imports ${foreign.map(specifier => JSON.stringify(specifier)).join(', ')} — `
      + 'only node: builtins and relative paths may stay external, because an installed addon resolves '
      + 'harness packages at runtime through fromProfile()',
    )
  }

  // The engine seam must stay a runtime dynamic import: the bundler cannot
  // inline it (computed URL) and the copy beside the bundle is what answers it.
  if (!source.includes("'./engine.mjs'") && !source.includes('"./engine.mjs"')) {
    throw new Error('build: the ./engine.mjs dynamic import did not survive into lib/host.js')
  }
  if (!source.includes('import.meta.url')) {
    throw new Error('build: import.meta.url vanished — the engine seam would resolve against the wrong directory')
  }

  const engineSource = readFileSync(ENGINE_SOURCE)
  const engineCopy = readFileSync(ENGINE_OUTPUT)
  if (!engineSource.equals(engineCopy)) throw new Error('build: lib/engine.mjs does not match engine.mjs')

  return importedSpecifiers(source)
}

/**
 * Report whether `lib/` matches its sources on disk.
 * @returns the list of stale or missing outputs (empty means up to date).
 */
function staleness() {
  const problems = []
  for (const [source, output] of [
    [CLIENT_SOURCE, CLIENT_OUTPUT],
    [HOST_SOURCE, HOST_OUTPUT],
    [ENGINE_SOURCE, ENGINE_OUTPUT],
  ]) {
    if (!existsSync(output)) {
      problems.push(`${output} is missing (run node build.mjs)`)
      continue
    }
    if (statSync(source).mtimeMs > statSync(output).mtimeMs) {
      problems.push(`${output} is older than ${source} (run node build.mjs)`)
    }
  }
  return problems
}

/**
 * Load the emitted host bundle in this process: the deployment imports
 * exactly this file from plain Node, so nothing TypeScript- or tsx-shaped may
 * survive in it. Importing is side-effect free (the module only defines its
 * exports and closes over `process.env`).
 * @returns the exported names, for the build report.
 */
async function assertHostLoads() {
  const module = await import(pathToFileURL(HOST_OUTPUT).href)
  for (const exportName of ['apply', 'name', 'inject']) {
    if (!(exportName in module)) throw new Error(`build: lib/host.js does not export ${exportName}`)
  }
  if (typeof module.apply !== 'function') throw new Error('build: lib/host.js exports a non-function apply')
  if (typeof module.name !== 'string' || module.name === '') throw new Error('build: lib/host.js exports an empty name')
  if (!Array.isArray(module.inject) || module.inject.length === 0) {
    throw new Error('build: lib/host.js exports no inject list')
  }
  return Object.keys(module).sort()
}

if (process.argv.includes('--check')) {
  const problems = staleness()
  if (problems.length > 0) {
    for (const problem of problems) console.error(`stale: ${problem}`)
    process.exit(1)
  }
  console.log('lib/ is up to date with client.tsx, host.ts, and engine.mjs')
} else {
  mkdirSync(LIB, { recursive: true })
  const started = Date.now()

  await build(clientConfig, { config: false })
  await build(hostConfig, { config: false })
  copyFileSync(ENGINE_SOURCE, ENGINE_OUTPUT)

  const hostImports = assertHostBundle()
  const hostExports = await assertHostLoads()
  const bytes = (path) => `${String(statSync(path).size)} bytes`
  console.log(`built ${CLIENT_OUTPUT} (${bytes(CLIENT_OUTPUT)})`)
  console.log(`built ${HOST_OUTPUT} (${bytes(HOST_OUTPUT)})`)
  console.log(`copied ${ENGINE_OUTPUT} (${bytes(ENGINE_OUTPUT)})`)
  console.log(`host imports: ${hostImports.join(', ')}`)
  console.log(`host exports: ${hostExports.join(', ')}`)
  console.log(`done in ${String(Date.now() - started)}ms`)
}
