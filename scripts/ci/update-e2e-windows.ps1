# Real installation and update test of the Windows installer (windows-latest, administrator).
#
# Flow: install a test installer 0.x.y silently, check services and permissions, update to a higher version through
# the web interface API (update service -> Task Scheduler -> silently run setup), then uninstall.
#
# The test packages carry a marker (tools\update-test.json) that is only built in this CI. It allows the local
# update source and the throwaway key; packages from release.yml have neither.
#
# Not checkable on the runner: SmartScreen, User Account Control (the runner is already an administrator),
# Windows Server 2016 and a restart of the computer with a running service.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root
$work = Join-Path $env:RUNNER_TEMP 'cm-update-e2e'
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $work | Out-Null
$apiPort = 4599
$api = "http://127.0.0.1:$apiPort"
# The folder names keep the former product name "WorldFoundry": installed versions and their updater use exactly these paths.
$dataDir = Join-Path $env:ProgramData 'WorldFoundry'
$updateDir = Join-Path $env:ProgramData 'WorldFoundry Update'
$installDir = Join-Path $env:ProgramFiles 'WorldFoundry'
$fake = $null

function Step($text) { Write-Host "`n=== $text" }
function Fail($text) { throw $text }

function Dump-File($file, $tail) {
  try { if (Test-Path $file) { Write-Host "[$file]"; Get-Content $file -Tail $tail } } catch { Write-Host "(not readable: $($_.Exception.Message))" }
}

function Dump {
  Write-Host "`n--- Diagnostics ---"
  try {
    foreach ($f in @((Join-Path $updateDir 'status.json'), (Join-Path $updateDir 'updater.log'))) { Dump-File $f 60 }
    foreach ($dir in @($work)) { Get-ChildItem $dir -Filter '*.log' -ErrorAction SilentlyContinue | ForEach-Object { Dump-File $_.FullName 40 } }
    Get-ChildItem $updateDir -Filter 'setup-*.log' -ErrorAction SilentlyContinue | ForEach-Object { Dump-File $_.FullName 60 }
    # Logs of the service wrappers: application (ProgramData\...\logs) and update service (update folder\logs)
    foreach ($dir in @((Join-Path $dataDir 'logs'), (Join-Path $updateDir 'logs'))) {
      Get-ChildItem $dir -ErrorAction SilentlyContinue | ForEach-Object { Dump-File $_.FullName 40 }
    }
    Get-Service worldfoundry, worldfoundry-updater -ErrorAction SilentlyContinue | Format-Table -AutoSize | Out-String | Write-Host
    Write-Host '[Task WorldFoundryUpdate]'
    schtasks.exe /Query /TN WorldFoundryUpdate 2>&1 | Out-String | Write-Host
    Write-Host "[update.lock present: $(Test-Path (Join-Path $updateDir 'update.lock'))]"
  } catch { Write-Host "(Diagnostics incomplete: $($_.Exception.Message))" }
}

function Wait-Until($what, $seconds, [scriptblock]$check) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try { if (& $check) { return } } catch { }
    Start-Sleep -Seconds 2
  }
  Fail "Timeout: $what"
}

# Services sometimes start a moment after the end of setup or after a restart than a check queries them
function Wait-ServiceRunning($name, $seconds = 120) {
  Wait-Until "Service $name is running" $seconds { (Get-Service $name -ErrorAction Stop).Status -eq 'Running' }
}

function Read-UpdateStatus {
  $file = Join-Path $updateDir 'status.json'
  if (-not (Test-Path $file)) { return $null }
  return Get-Content $file -Raw | ConvertFrom-Json
}

# The update job is only finished when the updater reports "done" (setup finished, services started, new version
# responding), the lock is free and the one-time task is removed. The application reports success earlier.
function Wait-UpdateFinished($version, $seconds = 300) {
  Wait-Until 'Update job finished (status done)' $seconds {
    $s = Read-UpdateStatus
    ($null -ne $s) -and ($s.version -eq $version) -and ($s.state -eq 'done')
  }
  Wait-Until 'Lock update.lock released' 60 { -not (Test-Path (Join-Path $updateDir 'update.lock')) }
  Wait-Until 'Task WorldFoundryUpdate removed' 120 {
    schtasks.exe /Query /TN WorldFoundryUpdate *> $null
    $LASTEXITCODE -ne 0
  }
}

function Read-Config($name) {
  $line = Get-Content (Join-Path $dataDir 'worldfoundry.env') | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -replace "^$name=", '').Trim("'")
}

function Api($method, $path, $body = $null) {
  $headers = @{ Authorization = "Bearer $script:token" }
  $uri = "http://127.0.0.1:$script:port$path"
  if ($method -eq 'GET') {
    return Invoke-RestMethod -Method $method -Uri $uri -Headers $headers
  }
  # Invoke-RestMethod would otherwise send a bodiless POST as application/x-www-form-urlencoded
  $json = if ($null -ne $body) { $body | ConvertTo-Json -Compress } else { '{}' }
  return Invoke-RestMethod -Method $method -Uri $uri -Headers $headers -ContentType 'application/json' -Body $json
}

function Health-Version { (Api 'GET' '/api/health').version }

try {
  $version = node -p "require('./packages/backend/package.json').version"
  $parts = $version.Split('.')
  $next = "$($parts[0]).$($parts[1]).$([int]$parts[2] + 1)"

  Step "Building the throwaway key and test installers ($version, $next)"
  $key = Join-Path $work 'ci-private.pem'
  $pub = Join-Path $work 'ci-public.pem'
  node scripts/update-keygen.mjs --out $key --pub-out $pub | Out-Null
  $iscc = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
  if (-not (Test-Path $iscc)) { choco install innosetup --yes --no-progress | Out-Null }
  if (-not (Test-Path $iscc)) { Fail 'ISCC.exe was not found.' }

  foreach ($entry in @(@($version, 'a'), @($next, 'b'))) {
    $v = $entry[0]; $id = $entry[1]
    node scripts/package.mjs --target win-x64 --skip-build --skip-smoke --no-archive --out (Join-Path $work "pkg-$id") --version-override $v --test-update-api $api --test-update-key $pub | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "Package $v could not be built." }
    & $iscc "/DAppVersion=$v" "/DSourceDir=$(Join-Path $work "pkg-$id\win-x64")" "/DOutputDir=$(Join-Path $work "setup-$id")" installer\windows\worldfoundry.iss | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "ISCC failed for $v with code $LASTEXITCODE." }
  }
  $setupA = Join-Path $work "setup-a\worldfoundry-$version-setup.exe"
  $setupB = Join-Path $work "setup-b\worldfoundry-$next-setup.exe"

  Step 'Starting the fake GitHub with a signed release'
  $gh = Join-Path $work 'gh'
  New-Item -ItemType Directory -Force (Join-Path $gh "v$next") | Out-Null
  Copy-Item $setupB (Join-Path $gh "v$next")
  node scripts/ci/release-fixture.mjs --dir (Join-Path $gh "v$next") --key $key --pub $pub
  if ($LASTEXITCODE -ne 0) { Fail 'Release files could not be signed.' }
  $fake = Start-Process node -ArgumentList @('scripts/ci/fake-github.mjs', '--dir', $gh, '--port', "$apiPort", '--repo', 'ci/test') -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $work 'fake-github.log') -RedirectStandardError (Join-Path $work 'fake-github.err.log')

  Step "Silent installation of $version"
  $p = Start-Process $setupA -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=$(Join-Path $work 'setup-a.log')") -Wait -PassThru
  if ($p.ExitCode -ne 0) { Fail "Setup ended with code $($p.ExitCode)." }
  foreach ($name in 'worldfoundry', 'worldfoundry-updater') { Wait-ServiceRunning $name }
  if (-not (Test-Path (Join-Path $dataDir 'credentials.txt'))) { Fail 'credentials.txt is missing.' }
  $script:token = Read-Config 'AUTH_TOKEN'
  $script:port = [int](Read-Config 'PORT')
  if (-not $script:token) { Fail 'No token in the configuration.' }
  Wait-Until "Start of $version" 120 { (Health-Version) -eq $version }
  # without a token there is no data
  try { Invoke-RestMethod "http://127.0.0.1:$script:port/api/servers" | Out-Null; Fail 'API reachable without a token.' } catch { if ($_.Exception.Message -eq 'API reachable without a token.') { throw } }

  Step 'Accounts and permissions'
  $sc = (sc.exe qc worldfoundry | Out-String)
  if ($sc -notmatch 'NT SERVICE\\worldfoundry') { Fail "Wrong service account:`n$sc" }
  $scu = (sc.exe qc worldfoundry-updater | Out-String)
  if ($scu -notmatch 'LocalSystem') { Fail "The update service does not run as LocalSystem:`n$scu" }
  $acl = (icacls $updateDir | Out-String)
  if ($acl -notmatch 'NT SERVICE\\worldfoundry:\(OI\)\(CI\)\(RX\)') { Fail "Update folder: the service account should only be able to read:`n$acl" }
  $aclRequest = (icacls (Join-Path $updateDir 'request') | Out-String)
  if ($aclRequest -notmatch 'NT SERVICE\\worldfoundry:\(OI\)\(CI\)\(M\)') { Fail "request: the service account should be able to write:`n$aclRequest" }
  $aclWork = (icacls (Join-Path $updateDir 'work') | Out-String)
  if ($aclWork -match 'NT SERVICE\\worldfoundry') { Fail "work: the service account must not have access:`n$aclWork" }
  $aclInstall = (icacls $installDir | Out-String)
  if ($aclInstall -match 'NT SERVICE\\worldfoundry:.*\((F|M|W)\)') { Fail "Program folder: the service account must not change anything:`n$aclInstall" }

  Step 'Pointing the application at the fake GitHub'
  Add-Content -Path (Join-Path $dataDir 'worldfoundry.env') -Value "UPDATE_REPO='ci/test'`nUPDATE_API_BASE='$api'"
  Restart-Service worldfoundry
  Wait-ServiceRunning 'worldfoundry'
  Wait-Until 'Restart of the service' 120 { (Health-Version) -eq $version }
  $state = Api 'GET' '/api/system/update'
  if ($state.installMode -ne 'service') { Fail "Install mode is $($state.installMode), expected service." }

  Step "Update to $next"
  $checked = Api 'POST' '/api/system/update/check'
  if (-not $checked.updateAvailable -or $checked.latest.version -ne $next) { Fail "Update not detected: $($checked | ConvertTo-Json -Depth 5)" }
  if (-not $checked.canApply) { Fail "Update cannot be applied: $($checked.canApplyReason)" }
  Api 'POST' '/api/system/update/apply' @{ confirm = $true; countdownSeconds = 0 } | Out-Null
  Wait-Until "new version $next" 600 { (Health-Version) -eq $next }
  Wait-Until 'Entry in the update history' 120 { (Api 'GET' '/api/system/update').history[0].result -eq 'success' }
  # the application reports success as soon as the new version responds; setup is still running then (firewall, starting the update service)
  Wait-UpdateFinished $next
  foreach ($name in 'worldfoundry', 'worldfoundry-updater') { Wait-ServiceRunning $name }
  Wait-Until "Version $next responds after the service start" 120 { (Health-Version) -eq $next }
  $final = Read-UpdateStatus
  if ($final.state -ne 'done' -or $final.version -ne $next -or $final.from -ne $version) { Fail "Unexpected update status: $($final | ConvertTo-Json -Compress)" }
  if ((Get-Content (Join-Path $installDir 'VERSION') -Raw).Trim() -ne $next) { Fail 'VERSION in the program folder is wrong.' }
  if ((Read-Config 'AUTH_TOKEN') -ne $script:token) { Fail 'The token changed during the update.' }
  # The update keeps credentials.txt and its access restricted to administrators
  if (-not (Test-Path (Join-Path $dataDir 'credentials.txt'))) { Fail 'credentials.txt is missing after the update.' }
  $aclCred = (icacls (Join-Path $dataDir 'credentials.txt') | Out-String)
  if ($aclCred -match 'NT SERVICE') { Fail "credentials.txt: the service account must not have access:`n$aclCred" }
  Write-Host 'Update on Windows succeeded.'

  Step 'Uninstall keeps the data'
  $uninstaller = Get-ChildItem $installDir -Filter 'unins*.exe' | Select-Object -First 1
  $u = Start-Process $uninstaller.FullName -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -Wait -PassThru
  if ($u.ExitCode -ne 0) { Fail "Uninstall ended with code $($u.ExitCode)." }
  # the uninstaller finishes in a second process and deletes services and folders a moment after it returns
  Wait-Until 'Service worldfoundry removed' 120 { -not (Get-Service worldfoundry -ErrorAction SilentlyContinue) }
  Wait-Until 'Service worldfoundry-updater removed' 120 { -not (Get-Service worldfoundry-updater -ErrorAction SilentlyContinue) }
  Wait-Until 'Program files removed' 120 { -not (Test-Path (Join-Path $installDir 'node')) }
  Wait-Until 'Update folder removed' 120 { -not (Test-Path $updateDir) }
  if (-not (Test-Path (Join-Path $dataDir 'worldfoundry.env'))) { Fail 'The configuration was deleted.' }
  Write-Host 'Windows installer test passed.'
  # the last native commands (sc, schtasks) may leave an error code behind; the test is successful here
  $global:LASTEXITCODE = 0
  exit 0
}
catch {
  Write-Host "ERROR: $($_.Exception.Message)"
  Dump
  throw
}
finally {
  if ($fake -and -not $fake.HasExited) { Stop-Process -Id $fake.Id -Force -ErrorAction SilentlyContinue }
}
