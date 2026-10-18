/** Check addon sources against installed Harness declarations without editing its compiler graph. */
import ts from 'typescript'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const anchors = [
  '../../../apps/web/src/team-addon-typecheck.tsx',
  '../../../packages/core/agent/src/team-addon-typecheck.ts',
].map(path => fileURLToPath(new URL(path, import.meta.url)))
const options = {
  target: ts.ScriptTarget.ES2024,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  noEmit: true,
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitOverride: true,
  noFallthroughCasesInSwitch: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
  types: ['node'],
}
const host = ts.createCompilerHost(options)
host.resolveModuleNames = (names, containingFile) => names.map(name => {
  const resolved = ts.resolveModuleName(name, containingFile, options, ts.sys).resolvedModule
  if (resolved || name.startsWith('.') || name.startsWith('node:')) return resolved
  // The addon consumes the existing Web peer dependencies, not private React copies.
  for (const anchor of anchors) {
    const peer = ts.resolveModuleName(name, anchor, options, ts.sys).resolvedModule
    if (peer) return peer
  }
  return undefined
})
const fixture = fileURLToPath(new URL('../../../examples/headless-agent/tests/fixtures/aseldev-teams/teams/', import.meta.url))
const program = ts.createProgram([`${here}host.ts`, `${here}client.tsx`, `${fixture}driver.ts`, `${fixture}fixture.ts`], options, host)
const diagnostics = ts.getPreEmitDiagnostics(program)
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: path => path,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  }))
  process.exitCode = 1
} else console.log('Team sources and composition fixture pass strict TypeScript checks.')
