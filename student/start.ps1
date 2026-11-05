# PowerShell로 켜기:  .\student\start.ps1                (실제 PC 상태)
#                     .\student\start.ps1 -Demo          (예제 값, 화면에 "예제" 표시)
#                     .\student\start.ps1 -NoSave        (공용 PC용: 기록을 파일에 남기지 않음)
param([switch]$Demo, [switch]$NoSave)
Set-Location (Join-Path $PSScriptRoot '..')
$node = 'node'
$portable = Join-Path $PSScriptRoot 'node\node.exe'
if (Test-Path $portable) { $node = $portable }
if (-not (Get-Command $node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js를 찾지 못했어요. student\README.md 의 "Node.js가 없는 PC" 안내를 보세요.'
  exit 1
}
$args2 = @('student/server.mjs', '--open')
if ($Demo) { $args2 += '--demo' }
if ($NoSave) { $args2 += '--no-save' }
& $node @args2
