#!/usr/bin/env node
// Append a session summary (read from stdin) to today's note in the vault.
// Vault: $ASELDEV_BRAIN_VAULT, else `brain.path` in $DSH_HOME/settings.yaml
// (DSH_HOME defaults to ~/.dsh). Writes only inside the vault folder.
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

function fail(message) {
  console.error(`save-note: ${message}`)
  process.exit(1)
}

function vaultFromSettings() {
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const file = join(dshHome, 'settings.yaml')
  if (!existsSync(file)) return undefined
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const start = lines.findIndex(line => /^brain:\s*$/.test(line))
  if (start === -1) return undefined
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    const match = line.match(/^\s+path:\s*(.+?)\s*$/)
    if (match) return match[1].replace(/^(['"])(.*)\1$/, '$2')
  }
  return undefined
}

function localDate() {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

const vault = process.env.ASELDEV_BRAIN_VAULT?.trim() || vaultFromSettings()
if (!vault) fail('no vault configured: set ASELDEV_BRAIN_VAULT or the Brain path in Settings → Plugins → Brain')
if (!existsSync(vault)) fail(`vault folder does not exist: ${vault}`)

const workspace = (arg('workspace', 'session') || 'session').replace(/[\\/:*?"<>|]+/g, '-').trim()
const folder = arg('folder', '01 - Inbox')
const date = arg('date', localDate())
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`--date must be YYYY-MM-DD, got ${date}`)

const dir = resolve(vault, folder)
const rel = relative(resolve(vault), dir)
if (rel.startsWith('..') || isAbsolute(rel)) fail(`--folder must stay inside the vault: ${folder}`)
if (rel.split(/[\\/]/)[0] === '.obsidian') fail('refusing to write into .obsidian')

const body = readFileSync(0, 'utf8').trim()
if (body.length === 0) fail('empty note body on stdin')

mkdirSync(dir, { recursive: true })
const file = join(dir, `${date} - ${workspace}.md`)
if (existsSync(file)) {
  appendFileSync(file, `\n\n${body}\n`, 'utf8')
  console.log(`appended: ${file}`)
} else {
  const header = `---\ndate: ${date}\nworkspace: ${workspace}\ntags: [dev-log, aseldev-harness]\n---\n\n# ${date} · ${workspace}\n\n`
  writeFileSync(file, `${header}${body}\n`, 'utf8')
  console.log(`created: ${file}`)
}
