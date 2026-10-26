# Points your AselDev profile at the AselDev plugins and skills in THIS clone.
#
# Writes one block, between the "# >>> aseldev" and "# <<< aseldev" markers,
# into %USERPROFILE%\.dsh-aseldev\profiles\web\cordis.patch.yml (or the
# profile under $env:DSH_HOME). Everything else in that file is left alone, so
# it is safe to run again: after a git pull, after moving the folder, or on a
# new computer before the first start. rebuild-aseldev.cmd runs it for you.
param(
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh-aseldev' })
)
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path $DshHome 'profiles\web'
$patch = Join-Path $profileDir 'cordis.patch.yml'
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

function FileUrl([string]$path) { ([System.Uri](Resolve-Path -LiteralPath $path).Path).AbsoluteUri }
function Quote([string]$text) { "'" + ($text -replace "'", "''") + "'" }

# An external dual-face package is discoverable by the existing client registry.
# Keep its install link and build outside upstream workspace manifests.
$teamsDir = Join-Path $repo 'aseldev\plugins\teams'
& node (Join-Path $teamsDir 'build.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Team client build failed; the profile patch was not changed.' }
& node (Join-Path $teamsDir 'link-profile.mjs') $DshHome
if ($LASTEXITCODE -ne 0) { throw 'Team package linking failed; the profile patch was not changed.' }

# The office scene is a second external dual-face package: built and linked the
# same way, so its read-only route and the linked client package ship together.
$officeDir = Join-Path $repo 'aseldev\plugins\office'
& node (Join-Path $officeDir 'build.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Office build failed; the profile patch was not changed.' }
& node (Join-Path $officeDir 'link-profile.mjs') $DshHome
if ($LASTEXITCODE -ne 0) { throw 'Office package linking failed; the profile patch was not changed.' }

$skillsDir = Join-Path $repo 'aseldev\skills'
$nl = "`r`n"
$block = @(
  '# >>> aseldev (written by aseldev\setup-profile.ps1 - edit that script, not this block)',
  '# Skills manager: Settings > Skills plus the /skill loader for your skills folder.',
  '# Artifacts: the agent''s artifact tool, saved versions and the sandboxed viewer pages.',
  '- insert:',
  '    - id: aseldev-skills-manager',
  ('      name: ' + (Quote (FileUrl (Join-Path $repo 'aseldev\plugins\skills-manager\host.ts')))),
  '      config:',
  ('        root: ' + (Quote $skillsDir)),
  '    - id: aseldev-artifacts',
  ('      name: ' + (Quote (FileUrl (Join-Path $repo 'aseldev\plugins\artifacts\host.ts')))),
  '# Brain: blocks agents from 05 - Private (any tool), adds the core card to every chat and the brain_write tool.',
  '    - id: aseldev-brain',
  ('      name: ' + (Quote (FileUrl (Join-Path $repo 'aseldev\plugins\brain\host.ts')))),
  '      config:',
  '        privateFolders:',
  '          - ''05 - Private''',
  '# Brain tools (brain_search, brain_read) for every agent in every preset.',
  '    - id: aseldev-tool-brain',
  '      name: ''@deepseek-ai/dsh-tool-brain''',
  '# Persistent specialist teams, coordinator tools, and sidebar status panel.',
  '    - id: aseldev-teams',
  '      name: ''@aseldev/dsh-teams''',
  '      config:',
  '        maxActive: 3',
  '        maxLimit: 12',
  '        # Writing workers may delegate (start subagents). Nested workers are',
  '        # outside the team scheduler''s reservations and concurrency limit.',
  '        workerDelegation: true',
  '        # The office owns the sidebar entry in this profile; the Team panel',
  '        # still exists and keeps every action. Flip to true for both entries.',
  '        showLauncher: false',
  '# Isometric office: this conversation''s team assignments as a live office scene.',
  '# It registers the sidebar entry the teams row above gives up.',
  '    - id: aseldev-office',
  '      name: ''@aseldev/dsh-office''',
  '# <<< aseldev'
) -join $nl

$header = @(
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).'
) -join $nl

$text = if (Test-Path -LiteralPath $patch) { [System.IO.File]::ReadAllText($patch) } else { $header + $nl }
$pattern = '(?s)# >>> aseldev.*?# <<< aseldev'
if ([regex]::IsMatch($text, $pattern)) {
  $text = [regex]::Replace($text, $pattern, [System.Text.RegularExpressions.MatchEvaluator] { param($m) $block })
} else {
  $text = $text.TrimEnd() + $nl + $block + $nl
}
[System.IO.File]::WriteAllText($patch, $text, (New-Object System.Text.UTF8Encoding $false))
Write-Host "AselDev profile ready: $patch"
Write-Host "  plugins + skills from: $repo\aseldev"
