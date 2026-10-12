# =============================================================================
#  四子棋 · 3D  ——  一键启动脚本（build 后 preview，并打开浏览器）
#
#  用法：
#    scripts\start.ps1              构建 + 启动预览 + 打开浏览器（联机连**本机后端**）
#    scripts\start.ps1 -NoBuild     跳过构建（沿用已有 dist）
#    scripts\start.ps1 -Port 5200   指定端口
#    scripts\start.ps1 -Stop        停止占用该端口的预览服务
#    scripts\start.ps1 -NoBrowser   不自动打开浏览器
#    scripts\start.ps1 -Online      联机连**线上**那台后端（默认连本机 localhost:8787）
#    scripts\start.ps1 -ServerUrl http://1.2.3.4:8787   指定后端地址
#
#  ⚠️ 这个脚本是**本机自用**入口：默认把前端编成"连本机后端"。
#     要打"连线上"的前端产物，用 `pnpm build`（读 .env.production），别用这个脚本。
#
#  兼容 Windows PowerShell 5.1 与 PowerShell 7+。
#  真正干活的是本脚本；start.bat 只是双击入口（cmd 对中文编码不友好）。
# =============================================================================

[CmdletBinding()]
param(
  [int]$Port = 4173,
  [switch]$NoBuild,
  [switch]$Stop,
  [switch]$NoBrowser,
  [switch]$Online,
  [string]$ServerUrl = ''
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$url = "http://localhost:$Port/"

# ---------------------------------------------------------------- 输出工具
function Write-Step([string]$text) { Write-Host "  $text" -ForegroundColor Cyan }
function Write-Ok([string]$text) { Write-Host "  [OK] $text" -ForegroundColor Green }
function Write-Warn([string]$text) { Write-Host "  [!!] $text" -ForegroundColor Yellow }
function Write-Err([string]$text) { Write-Host "  [XX] $text" -ForegroundColor Red }

function Write-Banner {
  Write-Host ''
  Write-Host '  ==============================================' -ForegroundColor DarkGray
  Write-Host '     四子棋 · 9x9 连珠对战  (3D)' -ForegroundColor White
  Write-Host '     Connect Four · three.js + Vue 3' -ForegroundColor DarkGray
  Write-Host '  ==============================================' -ForegroundColor DarkGray
  Write-Host ''
}

# ---------------------------------------------------------------- 定位包管理器
# 先找全局安装（最稳定），再退回 PATH —— 避免命中其它工程 node_modules/.bin 里的临时 shim
function Resolve-Pnpm {
  $globalCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'pnpm\pnpm.exe'),
    (Join-Path $env:APPDATA 'npm\pnpm.cmd'),
    (Join-Path $env:ProgramFiles 'nodejs\pnpm.cmd'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\pnpm.cmd'),
    'D:\nvm\nodejs\pnpm.cmd',
    'C:\nvm\nodejs\pnpm.cmd'
  )
  foreach ($candidate in $globalCandidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }

  $command = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($command) {
    if ($command.Source -match '\\node_modules\\') {
      Write-Warn "命中的 pnpm 来自其它工程: $($command.Source)"
      Write-Warn '如启动失败，请先全局安装: npm i -g pnpm'
    }
    return $command.Source
  }
  return $null
}

function Resolve-Npm {
  $command = Get-Command npm -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return $null
}

function Invoke-PackageManager {
  param([string[]]$Arguments)
  & $script:pm @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "命令执行失败: $($script:pm) $($Arguments -join ' ')"
  }
}

# ---------------------------------------------------------------- 端口工具
function Get-PortListeners([int]$port) {
  try {
    return @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop)
  } catch {
    return @()
  }
}

function Test-PreviewReady([string]$target) {
  try {
    $response = Invoke-WebRequest -Uri $target -UseBasicParsing -TimeoutSec 2
    return ($response.StatusCode -eq 200) -and ($response.Content -match '<div id="app">')
  } catch {
    return $false
  }
}

function Stop-PortListeners([int]$port) {
  $listeners = Get-PortListeners $port
  if ($listeners.Count -eq 0) {
    Write-Warn "端口 $port 当前没有监听进程"
    return
  }
  foreach ($listener in $listeners) {
    $targetPid = $listener.OwningProcess
    try {
      $process = Get-Process -Id $targetPid -ErrorAction Stop
      Stop-Process -Id $targetPid -Force
      Write-Ok "已停止 PID $targetPid ($($process.ProcessName))"
    } catch {
      Write-Warn "无法停止 PID $targetPid : $($_.Exception.Message)"
    }
  }
}

function Open-Browser([string]$target) {
  try {
    Start-Process $target | Out-Null
    Write-Ok "已打开浏览器: $target"
  } catch {
    Write-Warn "自动打开浏览器失败，请手动访问: $target"
  }
}

# =============================================================================
#  主流程
# =============================================================================
Write-Banner

if ($Stop) {
  Write-Step "停止端口 $Port 上的预览服务..."
  Stop-PortListeners $Port
  Write-Host ''
  exit 0
}

# 1) 包管理器检查 -----------------------------------------------------------
$script:pm = Resolve-Pnpm
if (-not $script:pm) {
  $npmPath = Resolve-Npm
  if ($npmPath) {
    $script:pm = $npmPath
    Write-Warn '未找到 pnpm，回退使用 npm'
  } else {
    Write-Err '未找到 pnpm / npm，请先安装 Node.js 18+（推荐 Node 22）'
    Write-Host '       下载地址: https://nodejs.org/' -ForegroundColor DarkGray
    throw '缺少包管理器'
  }
}
Write-Step "包管理器: $script:pm"

# 2) 依赖 -------------------------------------------------------------------
if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules'))) {
  Write-Step '首次运行，安装依赖（可能需要 1-2 分钟）...'
  Invoke-PackageManager @('install')
  Write-Ok '依赖安装完成'
} else {
  Write-Ok '依赖已就绪 (node_modules 存在)'
}

# 3) 构建 -------------------------------------------------------------------
# 联机后端地址：本脚本默认连**本机**（localhost:8787），可用 -Online / -ServerUrl 覆盖。
# 用环境变量交给 vite：它优先级高于 .env.production / .env.development，构建时会被内嵌进产物。
if (-not $ServerUrl) {
  $ServerUrl = if ($Online) { 'http://113.45.13.149:8787' } else { 'http://localhost:8787' }
}
$env:VITE_SERVER_URL = $ServerUrl
Write-Step "联机后端: $ServerUrl"

$needsBuild = -not $NoBuild
if ($NoBuild -and -not (Test-Path -LiteralPath (Join-Path $root 'dist\index.html'))) {
  Write-Warn 'dist 不存在，忽略 -NoBuild 并执行构建'
  $needsBuild = $true
}

if ($needsBuild) {
  Write-Step '构建生产版本 (vite build)...'
  Invoke-PackageManager @('run', 'build')
  $baked = Select-String -Path (Join-Path $root 'dist\assets\index-*.js') -Pattern '113\.45\.13\.149:8787|localhost:8787' -AllMatches -ErrorAction SilentlyContinue |
    ForEach-Object { $_.Matches.Value } | Select-Object -Unique
  if ($baked -and ($baked -notcontains $ServerUrl -replace '^https?://', '')) {
    Write-Warn "产物里内嵌的后端地址 ($($baked -join ', ')) 与预期 ($ServerUrl) 不一致"
  } else {
    Write-Ok "构建完成，产物已内嵌后端 $ServerUrl"
  }
} else {
  Write-Step '已跳过构建 (-NoBuild)；产物里的后端地址取决于**上次构建**时传入的值'
}

# 4) 端口检查 ---------------------------------------------------------------
$reused = $false
if ((Get-PortListeners $Port).Count -gt 0) {
  if (Test-PreviewReady $url) {
    Write-Warn "端口 $Port 已有本项目的预览服务在运行，直接复用"
    Write-Warn '注意：它服务的是**上一次构建**的产物，可能内嵌了别的后端地址。'
    Write-Warn "要确保连 $ServerUrl 生效，先停掉再启动：scripts\start.ps1 -Stop"
    $reused = $true
  } else {
    Write-Err "端口 $Port 已被其它程序占用，请换端口: scripts\start.ps1 -Port 5200"
    throw '端口被占用'
  }
}

# 5) 启动预览服务 -----------------------------------------------------------
$server = $null
if (-not $reused) {
  Write-Step "启动预览服务 (端口 $Port)..."

  # Windows 上进程环境表里可能同时存在**只有大小写不同**的重名变量
  # （`Path` / `PATH`、`http_proxy` / `HTTP_PROXY` …，bash、Git Bash、nvm 之类都会贡献）。
  # Windows PowerShell 5.1 的 `Start-Process` 内部用大小写不敏感的字典塞这些变量，
  # 于是抛 "已添加项。字典中的关键字:X 所添加的关键字:Y" —— 直接起不来。
  # 这里按**原始大小写**（用 `cmd /c set` 读，.NET 的接口在旧版会折叠大小写）找出重复项，
  # 每个名字只保留第一份。只影响本脚本进程，子进程照样继承剩下的那一份。
  try {
    $seen = @{}
    $removed = 0
    foreach ($line in (& cmd.exe /c set 2>$null)) {
      if (-not $line) { continue }
      $idx = $line.IndexOf('=')
      if ($idx -lt 1) { continue }          # 跳过 `=C:` 这类盘符变量
      $name = $line.Substring(0, $idx)
      $key = $name.ToLowerInvariant()
      if ($seen.ContainsKey($key)) {
        [System.Environment]::SetEnvironmentVariable($name, $null, 'Process')
        $removed += 1
      } else {
        $seen[$key] = $name
      }
    }
    if ($removed -gt 0) { Write-Step "清理了 $removed 个大小写重复的环境变量（避免 Start-Process 报错）" }
  } catch {
    Write-Warn "环境变量去重失败（$($_.Exception.Message)），继续尝试启动"
  }

  try {
    $server = Start-Process -FilePath $script:pm `
      -ArgumentList @('exec', 'vite', 'preview', '--port', "$Port", '--strictPort', '--host') `
      -WorkingDirectory $root -NoNewWindow -PassThru
  } catch {
    Write-Warn "Start-Process 失败（$($_.Exception.Message)），改用 cmd 启动"
    $cmdLine = '"' + $script:pm + '" exec vite preview --port ' + $Port + ' --strictPort --host'
    $server = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $cmdLine) `
      -WorkingDirectory $root -NoNewWindow -PassThru
  }

  $deadline = (Get-Date).AddSeconds(60)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    if ($server.HasExited) { break }
    if (Test-PreviewReady $url) { $ready = $true; break }
    Start-Sleep -Milliseconds 400
  }

  if (-not $ready) {
    if ($server -and -not $server.HasExited) {
      Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    }
    Write-Err '预览服务启动失败或超时'
    throw '预览服务未就绪'
  }
  Write-Ok "服务已就绪 (PID $($server.Id))"
}

# 6) 打开浏览器 -------------------------------------------------------------
if (-not $NoBrowser) { Open-Browser $url }

Write-Host ''
Write-Host "  游戏地址: $url" -ForegroundColor White
Write-Host "  联机后端: $ServerUrl" -ForegroundColor White
if ($ServerUrl -match 'localhost|127\.0\.0\.1') {
  Write-Host '           (本机后端需另开一个窗口: cd back && pnpm dev 或双击 back\start.bat)' -ForegroundColor DarkGray
}
Write-Host '  停止服务: 关闭本窗口，或运行 scripts\start.ps1 -Stop' -ForegroundColor DarkGray
Write-Host '  快捷键  : H 跳过动画 · R 重开一局 · Esc 关闭弹窗' -ForegroundColor DarkGray
Write-Host ''

if ($server) {
  Write-Host '  （按 Ctrl+C 结束服务）' -ForegroundColor DarkGray
  try {
    Wait-Process -Id $server.Id -ErrorAction Stop
    if ($server.ExitCode -ne 0) {
      Write-Warn "预览服务已退出 (退出码 $($server.ExitCode))"
    }
  } catch {
    # Ctrl+C / 窗口关闭：忽略
  }
} else {
  Write-Host '  （服务由其它窗口托管，本窗口可关闭）' -ForegroundColor DarkGray
}
