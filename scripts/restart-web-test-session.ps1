param([switch]$EnablePublicTests)
$ErrorActionPreference='Stop'
$projectRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$allowedTestAccounts=@('2b3d797b-397f-4e9a-8078-bc073df43c49','c7834eeb-19c7-4ebc-aba4-630e37e80746','bf879f5d-469f-4401-92dc-a9282187cc2c')
$projectBrowsers=Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*$projectRoot*browser-profiles*" -and $_.CommandLine -notlike '*--type=*' }
foreach ($browserProcess in $projectBrowsers) {
  $accountMatch=[regex]::Match($browserProcess.CommandLine,'browser-profiles[\\/]([a-f0-9-]{36})')
  if ($accountMatch.Groups[1].Value -notin $allowedTestAccounts) { throw '存在非本次测试账号，停止重启' }
}
$base='http://127.0.0.1:34080'
function Invoke-TestRpc($method,$params) {
  $body=@{id='test-session-restart';method=$method;params=$params} | ConvertTo-Json -Depth 10 -Compress
  $result=Invoke-RestMethod -Uri "$base/__rpc" -Method Post -Headers @{Origin=$base} -ContentType 'application/json' -Body $body
  if ($result.error) { throw $result.error.message }
  return $result.result
}
$snapshot=Invoke-TestRpc 'snapshot' $null
if ($snapshot.tasks | Where-Object { $_.status -in @('publishing','validating') }) { throw '任务仍在执行，停止重启' }
$lockData=Get-Content (Join-Path $projectRoot '.data/.turbopush-engine.lock') -Raw | ConvertFrom-Json
$serviceProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$($lockData.pid)"
if (!$serviceProcess -or !$serviceProcess.CommandLine.Contains($projectRoot) -or !$serviceProcess.CommandLine.Contains('vite.js')) { throw '服务进程身份不匹配，停止操作' }
foreach ($accountId in $allowedTestAccounts) { $null=Invoke-TestRpc 'account.close' @{id=$accountId} }
Stop-Process -Id $serviceProcess.ProcessId
$env:TURBOPUSH_BROWSER_CHANNEL='msedge'
$env:TURBOPUSH_EXPERIMENTAL_PUBLISH=if($EnablePublicTests){'1'}else{'0'}
$nodePath=(Get-Command node).Source
$server=Start-Process -FilePath $nodePath -ArgumentList (Join-Path $projectRoot 'apps/desktop/node_modules/vite/bin/vite.js'),'preview','--host','127.0.0.1','--port','34080' -WorkingDirectory (Join-Path $projectRoot 'apps/desktop') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $projectRoot 'test-results/web-server.log') -RedirectStandardError (Join-Path $projectRoot 'test-results/web-server-error.log') -PassThru
foreach ($attempt in 1..20) {
  try { $null=Invoke-RestMethod "$base/"; Write-Output "Web test service ready: PID=$($server.Id), port=34080"; exit 0 } catch { Start-Sleep -Milliseconds 250 }
}
throw '服务未在5秒内就绪，请检查本地服务日志'
