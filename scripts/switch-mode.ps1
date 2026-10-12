# =============================================================================
#  四子棋 · 联机目标切换（本地 / 线上）
#
#  一般由根目录的 switch-local.bat / switch-online.bat 调用：
#    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\switch-mode.ps1 -Mode local
#    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\switch-mode.ps1 -Mode online
#    ... -Mode online -ServerUrl http://1.2.3.4:8787     指定别的后端
#    ... -NoBuild                                       只做检查，不重新构建（快）
#
#  工程是**前后端分离**的两份产物，本脚本把两边都刷到最新、并让它们指向同一台后端：
#
#    1. pnpm sync:core   把 src\core 同步到 back\src\core（服务端裁决用同一份引擎）
#    2. 编译后端         → back\dist   【拷贝用】把 back\ 里所有文件复制到宝塔后端目录
#    3. 构建前端（内嵌本次模式的后端地址）→ dist\  【拷贝用】把 dist\ 里所有文件复制到前端目录
#    4. 自检             产物内嵌地址是否 = 目标地址 + 目标后端协议版本是否与前端一致
#
#  ⚠️ 前端连的后端地址是**构建期写死**进 dist\assets\index-*.js 的 ⇒ 换模式必须重新构建。
#  ⚠️ 本地与线上共用同一份 back\.env（都连宝塔那台 Mongo），所以本脚本**不改** .env。
# =============================================================================

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('local', 'online')]
  [string]$Mode,

  [string]$ServerUrl = '',

  [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

# ---------------------------------------------------------------- 常量
$LOCAL_SERVER_URL = 'http://localhost:8787'
$ONLINE_SERVER_URL = 'http://113.45.13.149:8787'

$root = Split-Path -Parent $PSScriptRoot
$backDir = Join-Path $root 'back'
$distDir = Join-Path $root 'dist'
$envPath = Join-Path $backDir '.env'

# ---------------------------------------------------------------- 输出工具
function Write-Step([string]$text) { Write-Host "  $text" -ForegroundColor Cyan }
function Write-Ok([string]$text) { Write-Host "  [OK] $text" -ForegroundColor Green }
function Write-Warn([string]$text) { Write-Host "  [!!] $text" -ForegroundColor Yellow }
function Write-Err([string]$text) { Write-Host "  [XX] $text" -ForegroundColor Red }

function Write-Banner {
  Write-Host ''
  Write-Host '  ==============================================' -ForegroundColor DarkGray
  Write-Host '     四子棋 · 联机目标切换' -ForegroundColor White
  Write-Host '  ==============================================' -ForegroundColor DarkGray
  Write-Host ''
}

# ---------------------------------------------------------------- 定位 pnpm
function Resolve-Pnpm {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'pnpm\pnpm.exe'),
    (Join-Path $env:APPDATA 'npm\pnpm.cmd'),
    (Join-Path $env:ProgramFiles 'nodejs\pnpm.cmd'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\pnpm.cmd'),
    'D:\nvm\nodejs\pnpm.cmd',
    'C:\nvm\nodejs\pnpm.cmd'
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  $command = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return $null
}

# ---------------------------------------------------------------- 跑原生命令
# pnpm / node 会把「正在执行 xxx」这类正常信息写到 **stderr**，而
# `$ErrorActionPreference = 'Stop'` 会把原生 stderr 当成终止性错误（满屏红字）。
# 这里临时降级为 Continue，只用退出码判断成败。
function Invoke-Cli {
  param(
    [string]$Exe,
    [string[]]$CliArgs,
    [string]$What,
    [switch]$AllowFailure
  )
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  # `| Out-Host`：原生命令的输出直接进控制台、不留在管道里。
  # 否则调用方只要写成 `$x = Invoke-Cli ...` 就会把输出整段吞掉（自检结果就看不见了）。
  try {
    & $Exe @CliArgs | Out-Host
  } finally {
    $ErrorActionPreference = $previous
  }
  $script:CliExitCode = $LASTEXITCODE
  if (-not $AllowFailure -and $script:CliExitCode -ne 0) {
    throw "$What 失败（退出码 $script:CliExitCode）"
  }
}

# ---------------------------------------------------------------- 环境变量去重
# 旧版 Windows 的 Start-Process 在遇到"只有大小写不同"的重名环境变量时会炸
# （Path/PATH、http_proxy/HTTP_PROXY …）。按原始大小写读一遍，同名只留一份。
function Remove-DuplicateEnvNames {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $seen = @{}
    $removed = 0
    foreach ($line in (& cmd.exe /c set 2>$null)) {
      if (-not $line) { continue }
      $idx = $line.IndexOf('=')
      if ($idx -lt 1) { continue }
      $name = $line.Substring(0, $idx)
      $key = $name.ToLowerInvariant()
      if ($seen.ContainsKey($key)) {
        [System.Environment]::SetEnvironmentVariable($name, $null, 'Process')
        $removed += 1
      } else {
        $seen[$key] = $name
      }
    }
    if ($removed -gt 0) { Write-Step "清理了 $removed 个大小写重复的环境变量" }
  } catch {
    Write-Warn "环境变量去重失败（$($_.Exception.Message)），继续"
  } finally {
    $ErrorActionPreference = $previous
  }
}

# ---------------------------------------------------------------- 主流程
Write-Banner

if ($ServerUrl) {
  $targetUrl = $ServerUrl.TrimEnd('/')
} elseif ($Mode -eq 'local') {
  $targetUrl = $LOCAL_SERVER_URL
} else {
  $targetUrl = $ONLINE_SERVER_URL
}

Write-Host "  模式      : $Mode" -ForegroundColor White
Write-Host "  后端地址  : $targetUrl" -ForegroundColor White
Write-Host '  产物      : back\dist（后端） + dist\（前端）' -ForegroundColor DarkGray
Write-Host ''

# --- 0) 环境准备 -----------------------------------------------------------
if (-not (Test-Path -LiteralPath (Join-Path $root 'package.json'))) {
  Write-Err "工程根目录不对（找不到 package.json）：$root"
  throw '根目录错误'
}
if (-not (Test-Path -LiteralPath $backDir)) {
  Write-Err "找不到 back 目录：$backDir"
  throw '缺少 back 目录'
}
$pm = Resolve-Pnpm
if (-not $pm) {
  Write-Err '未找到 pnpm，请先安装（npm i -g pnpm）'
  throw '缺少 pnpm'
}
Remove-DuplicateEnvNames
Write-Step "包管理器: $pm"

if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules'))) {
  Write-Step '首次运行，安装根依赖（pnpm install）...'
  Invoke-Cli -Exe $pm -CliArgs @('install') -What 'pnpm install' | Out-Null
}
if (-not (Test-Path -LiteralPath (Join-Path $backDir 'node_modules'))) {
  Write-Step '首次运行，安装后端依赖（back 下 pnpm install）...'
  Push-Location $backDir
  try {
    Invoke-Cli -Exe $pm -CliArgs @('install') -What '后端 pnpm install' | Out-Null
  } finally {
    Pop-Location
  }
}

# .env 只做存在性检查 + 关键项提示，**不覆盖**（本地与线上共用同一份）
if (-not (Test-Path -LiteralPath $envPath)) {
  Write-Warn 'back\.env 不存在 → 从 .env.example 复制一份，请按需修改'
  Copy-Item -LiteralPath (Join-Path $backDir '.env.example') -Destination $envPath -Force
} else {
  # ⚠️ 必须显式 -Encoding UTF8：.env 里有中文注释，而中文 Windows 的默认编码是 GBK。
  #    用 GBK 读 UTF-8 时，某些汉字的字节序列会把**后面的换行一起吃掉**，
  #    于是 `MONGODB_URI=...` 被并进上一行注释，正则就再也匹配不到（这个坑踩过）。
  $envText = Get-Content -LiteralPath $envPath -Raw -Encoding UTF8
  $dbMode = ''
  $dbUri = ''
  foreach ($line in ($envText -split "`n")) {
    $line = $line.Trim()
    if ($line -match '^DB_MODE\s*=\s*(\S+)') { $dbMode = $Matches[1] }
    if ($line -match '^MONGODB_URI\s*=\s*(\S+)') { $dbUri = $Matches[1] }
  }
  if (-not $dbMode) {
    Write-Warn 'back\.env 里没读到 DB_MODE（默认按 mongo 处理）'
    $dbMode = 'mongo'
  }
  if ($dbMode -eq 'memory') {
    Write-Warn 'back\.env 是 DB_MODE=memory（重启丢回放）。要连真实库请改成 mongo。'
  } else {
    Write-Ok "back\.env: DB_MODE=$dbMode  库=$dbUri"
  }
}

# --- 1) 同步内核 -----------------------------------------------------------
Write-Step '同步内核（pnpm sync:core）...'
Push-Location $root
try {
  Invoke-Cli -Exe $pm -CliArgs @('run', 'sync:core') -What 'sync:core' | Out-Null
} finally {
  Pop-Location
}
Write-Ok 'back\src\core 已与 src\core 一致'

# --- 2) 编译后端 + 3) 构建前端 --------------------------------------------
if ($NoBuild) {
  Write-Warn '已跳过构建（-NoBuild）：两端产物都沿用现有文件'
} else {
  Write-Step '编译后端（back: pnpm run build）...'
  Push-Location $backDir
  try {
    Invoke-Cli -Exe $pm -CliArgs @('run', 'build') -What '后端编译' | Out-Null
  } finally {
    Pop-Location
  }
  $protocolFile = Join-Path $backDir 'dist\protocol.js'
  if (Test-Path -LiteralPath $protocolFile) {
    $protocolVersion = (Select-String -LiteralPath $protocolFile -Pattern 'PROTOCOL_VERSION = (\d+)').Matches[0].Groups[1].Value
    Write-Ok "后端编译完成（PROTOCOL_VERSION = $protocolVersion）"
  } else {
    Write-Ok '后端编译完成'
  }

  Write-Step "构建前端（内嵌 VITE_SERVER_URL=$targetUrl）..."
  $env:VITE_SERVER_URL = $targetUrl
  Push-Location $root
  try {
    Invoke-Cli -Exe $pm -CliArgs @('run', 'build') -What '前端构建' | Out-Null
  } finally {
    Pop-Location
  }
  Write-Ok '前端构建完成 → dist\'
}

# --- 4) 校验前端内嵌地址 ---------------------------------------------------
$entry = Get-ChildItem -Path (Join-Path $distDir 'assets') -Filter 'index-*.js' -ErrorAction SilentlyContinue |
  Select-Object -First 1
$baked = $null
if ($entry) {
  # 同样显式 UTF8：产物里有中文界面文案，别让默认编码把字节流读歪。
  $code = Get-Content -LiteralPath $entry.FullName -Raw -Encoding UTF8
  if ($code -match 'function \w+\(\)\{const \w+="(https?://[^"]+)"\.trim\(\)') {
    $baked = $Matches[1]
  } elseif ($code -match '"([^"]*:\d+)"\.trim\(\)') {
    $baked = $Matches[1]
  }
}

if (-not $entry) {
  Write-Err 'dist\assets 里没有 index-*.js，前端产物缺失'
  throw '前端产物缺失'
} elseif (-not $baked) {
  Write-Warn '没能从产物里读出内嵌地址（压缩变形？），请人工确认 dist\assets\index-*.js'
} elseif ($baked.TrimEnd('/') -eq $targetUrl) {
  Write-Ok "前端产物内嵌后端 = $baked"
} elseif ($NoBuild) {
  Write-Warn "内嵌后端 = $baked（本次 -NoBuild，沿用旧产物）"
} else {
  Write-Err "前端产物内嵌后端 ($baked) 与目标 ($targetUrl) 不一致！"
  throw '内嵌地址校验失败'
}

# --- 5) 自检：目标后端是否可达、协议版本是否一致 ---------------------------
$checker = Join-Path $PSScriptRoot 'verify-online-backend.mjs'
if ((Test-Path -LiteralPath $checker) -and $baked -and ($baked.TrimEnd('/') -eq $targetUrl)) {
  Write-Host ''
  Write-Step '目标后端自检...'
  $env:ONLINE_SERVER = $targetUrl
  $script:CliExitCode = 1
  Push-Location $root
  try {
    Invoke-Cli -Exe 'node' -CliArgs @($checker) -What '目标后端自检' -AllowFailure
  } catch {
    Write-Warn "自检脚本没跑起来（$($_.Exception.Message)）"
  } finally {
    Pop-Location
  }
  if ($script:CliExitCode -ne 0) {
    if ($Mode -eq 'online') {
      Write-Warn '线上自检 FAIL ⇒ 那台后端很可能还是旧代码：把 back\ 里所有文件覆盖上去并**重启进程**'
    } else {
      Write-Warn '本地后端连不上？请先双击 back\start.bat 把后端起起来，再重跑本脚本自检'
    }
  }
} elseif ($NoBuild) {
  Write-Warn '本次 -NoBuild 且内嵌地址与目标不符，已跳过目标自检'
}

# --- 6) 总结 ---------------------------------------------------------------
Write-Host ''
Write-Host '  ----------------------------------------------' -ForegroundColor DarkGray
if ($Mode -eq 'local') {
  Write-Host '  已切到【本地模式】' -ForegroundColor Green
  Write-Host '    后端 : 双击 back\start.bat   → ws://localhost:8787' -ForegroundColor White
  Write-Host '    前端 : 双击 start.bat        → http://localhost:4173/' -ForegroundColor White
  Write-Host '    （数据库仍是宝塔那台，两端共用同一份 back\.env）' -ForegroundColor DarkGray
} else {
  Write-Host '  已切到【线上模式】' -ForegroundColor Green
  Write-Host '    部署（前后端分离，两份产物分别拷）：' -ForegroundColor White
  Write-Host '      后端 : 把 back\ 里所有文件 → 宝塔后端目录，然后重启进程' -ForegroundColor White
  Write-Host '             cd /www/wwwroot/connect4/back && pm2 restart connect4-backend' -ForegroundColor DarkGray
  Write-Host '      前端 : 把 dist\ 里所有文件 → 宝塔前端目录' -ForegroundColor White
  Write-Host "    线上地址 : $targetUrl/" -ForegroundColor White
  Write-Host '    ⚠️ 两份产物必须由**同一次切换**产出，否则协议版本会不一致' -ForegroundColor Yellow
}
Write-Host '  ----------------------------------------------' -ForegroundColor DarkGray
Write-Host ''
