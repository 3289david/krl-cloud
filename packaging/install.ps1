# KRL Cloud 노드 에이전트 설치 (Windows PowerShell)
#   iwr __SERVER__/install.ps1 -OutFile $env:TEMP/krl.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP/krl.ps1
# 실행하면 연결 코드가 표시됩니다. 대시보드의 "내 PC 연결"에 입력하면 자동으로 호스팅에 참여하고, 로그온 시 자동 시작됩니다.
param([string]$Token = '', [string]$Name = $env:COMPUTERNAME, [string]$Server = '__SERVER__', [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:USERPROFILE '.krl-agent'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Error 'Node.js 20+ 가 필요합니다. https://nodejs.org 에서 설치하세요. (설치 없이 쓰려면 단일 실행 파일 krl-agent-windows-x64.exe 를 받아 "install" 인자로 실행)'; exit 1 }
if ([int]((& $node -p 'process.versions.node.split(".")[0]')) -lt 20) { Write-Error 'Node.js 20 이상이 필요합니다.'; exit 1 }
New-Item -ItemType Directory -Force $dir | Out-Null
Invoke-WebRequest "$Server/agent/agent.js" -OutFile (Join-Path $dir 'agent.js') -UseBasicParsing
if ($Uninstall) { & $node (Join-Path $dir 'agent.js') uninstall; exit 0 }
$a = @((Join-Path $dir 'agent.js'), 'install', '--server', $Server, '--name', $Name)
if ($Token) { $a += @('--token', $Token) }
& $node @a
