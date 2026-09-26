# Installe app\XAUUSD-Zones.apk sur le téléphone branché en USB (débogage USB autorisé). Attend jusqu'à 10 minutes.
Set-Location -Path $PSScriptRoot
Start-Transcript -Path (Join-Path $PSScriptRoot 'installer-telephone.log') -Force | Out-Null
try {
  $sdkCands = @($env:ANDROID_HOME, "$env:LOCALAPPDATA\Android\Sdk")
  $sdk = $sdkCands | Where-Object { $_ -and (Test-Path "$_\platform-tools\adb.exe") } | Select-Object -First 1
  if (-not $sdk) { throw 'adb introuvable (SDK Android).' }
  $adb = "$sdk\platform-tools\adb.exe"
  if (-not (Test-Path 'XAUUSD-Zones.apk')) { throw 'XAUUSD-Zones.apk absent : lance d''abord installer-android.bat.' }
  & $adb start-server | Out-Null
  Write-Host "En attente du téléphone (10 min max). Sur le OnePlus : Options pour les développeurs > Débogage USB, puis « Autoriser » sur la fenêtre qui apparaît."
  $ok = $false
  for ($i = 0; $i -lt 120; $i++) {
    $devices = (cmd /c "`"$adb`" devices 2>&1") | Select-Object -Skip 1 | Where-Object { $_ -match '\S' }
    if ($devices | Where-Object { $_ -match '\tdevice$' }) { $ok = $true; break }
    if ($i % 6 -eq 0) { Write-Host ("  état : " + $(if ($devices) { $devices -join ', ' } else { 'aucun appareil' })) }
    Start-Sleep -Seconds 5
  }
  if (-not $ok) { throw 'Aucun téléphone autorisé en débogage USB après 10 minutes.' }
  Write-Host ($devices -join "`n")
  $out = (cmd /c "`"$adb`" install -r XAUUSD-Zones.apk 2>&1") -join "`n"; Write-Host $out
  if ($out -match 'INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match') {
    Write-Host 'Ancienne version (autre signature) : désinstallation puis installation.'
    cmd /c "`"$adb`" uninstall fr.xauusd.zones" | Out-Null
    $out = (cmd /c "`"$adb`" install XAUUSD-Zones.apk 2>&1") -join "`n"; Write-Host $out
  }
  if ($out -notmatch 'Success') { throw 'adb install a échoué.' }
  cmd /c "`"$adb`" shell monkey -p fr.xauusd.zones -c android.intent.category.LAUNCHER 1" | Out-Null
  Write-Host "`nTERMINÉ : XAUUSD Zones est installée et lancée sur le téléphone." -ForegroundColor Green
} catch {
  Write-Host "`nÉCHEC : $($_.Exception.Message)" -ForegroundColor Red
} finally { Stop-Transcript | Out-Null }
Read-Host "`nAppuie sur Entrée pour fermer"
