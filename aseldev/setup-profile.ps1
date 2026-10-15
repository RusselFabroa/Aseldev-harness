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
