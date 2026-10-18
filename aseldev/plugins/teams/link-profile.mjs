/** Install this external package's link without following or deleting its target. */
import { lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const home = process.argv[2]
if (!home) throw new Error('Usage: node link-profile.mjs <Harness home>')
const source = dirname(fileURLToPath(import.meta.url))
const link = join(resolve(home), 'profiles', 'node_modules', '@aseldev', 'dsh-teams')
mkdirSync(dirname(link), { recursive: true })
let entry
try { entry = lstatSync(link) }
catch (error) { if (error.code !== 'ENOENT') throw error }
if (entry) {
  if (!entry.isSymbolicLink()) throw new Error(`Refusing to replace a real file or directory: ${link}`)
  if (resolve(dirname(link), readlinkSync(link)) === resolve(source)) process.exit(0)
  unlinkSync(link)
}
symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir')
