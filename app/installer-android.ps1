# Compile l'APK XAUUSD Zones (release, signé, durci) et l'installe sur le téléphone branché en USB (débogage USB activé).
# Prérequis : Android Studio installé et ouvert une fois (SDK téléchargé, licences acceptées).
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot
Start-Transcript -Path (Join-Path $PSScriptRoot 'installer-android.log') -Force | Out-Null
function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Yellow }
try {
  Step 'Recherche du JDK et du SDK Android'
  $cands = @('B:\AndroidStudio', "$env:ProgramFiles\Android\Android Studio", "$env:LOCALAPPDATA\Programs\Android Studio", "${env:ProgramFiles(x86)}\Android\Android Studio")
  foreach ($d in (Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root })) {
    $cands += Get-ChildItem -Path $d.Root -Directory -Filter '*Android*' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName; "$($_.FullName)\Android Studio" }
  }
  $studio = $cands | Where-Object { $_ -and (Test-Path "$_\jbr\bin\java.exe") } | Select-Object -First 1
  Write-Host ("Emplacements testés : " + (($cands | Where-Object { $_ }) -join ' ; '))
  if ($studio) { $env:JAVA_HOME = "$studio\jbr" }
  if (-not $env:JAVA_HOME -or -not (Test-Path "$env:JAVA_HOME\bin\java.exe")) { throw "JDK introuvable : installe Android Studio (developer.android.com/studio)." }
  # Gradle (Capacitor) exige un JDK 17 à 21 : si le JDK d'Android Studio est plus récent, on utilise un JDK 21 portable
  $ver = (cmd /c "`"$env:JAVA_HOME\bin\java.exe`" -version 2>&1") -join ' '
  $major = if ($ver -match 'version "(\d+)') { [int]$Matches[1] } else { 0 }
  Write-Host "Version du JDK d'Android Studio : $major"
  if ($major -lt 17 -or $major -gt 21) {
    $jdk = Join-Path $env:USERPROFILE '.jdks\temurin-21'
    if (-not (Test-Path "$jdk\bin\java.exe")) {
      Step 'Téléchargement du JDK 21 portable (Eclipse Temurin, adoptium.net)'
      $zip = Join-Path $env:TEMP 'temurin-21.zip'
      $ProgressPreference = 'SilentlyContinue'
      Invoke-WebRequest -UseBasicParsing -Uri 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse' -OutFile $zip
      $tmp = Join-Path $env:USERPROFILE '.jdks\_tmp21'
      if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
      Expand-Archive -Path $zip -DestinationPath $tmp -Force
      $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
      New-Item -ItemType Directory -Force -Path (Split-Path $jdk) | Out-Null
      Move-Item $inner.FullName $jdk
      Remove-Item $tmp -Recurse -Force; Remove-Item $zip -Force
    }
    $env:JAVA_HOME = $jdk
    Write-Host "JDK utilisé pour Gradle : $jdk"
  }
  $sdkCands = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, "$env:LOCALAPPDATA\Android\Sdk")
  foreach ($d in (Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root })) { $sdkCands += @("$($d.Root)Android\Sdk", "$($d.Root)AndroidSdk", "$($d.Root)Android\android-sdk") }
  Write-Host ("SDK testés : " + (($sdkCands | Where-Object { $_ }) -join ' ; '))
  $sdk = $sdkCands | Where-Object { $_ -and (Test-Path "$_\platform-tools\adb.exe") } | Select-Object -First 1
  if (-not $sdk) { $sdk = "$env:LOCALAPPDATA\Android\Sdk" }
  if (-not (Test-Path "$sdk\platform-tools\adb.exe")) { throw "SDK Android introuvable dans $sdk : ouvre Android Studio une fois et termine l'assistant d'installation." }
  $env:ANDROID_HOME = $sdk; $env:ANDROID_SDK_ROOT = $sdk
  $env:Path = "$env:JAVA_HOME\bin;$sdk\platform-tools;$env:Path"
  Write-Host "JDK : $env:JAVA_HOME`nSDK : $sdk"

  Step 'Dépendances (versions figées, npm ci) et audit de sécurité'
  cmd /c "npm ci --no-fund 2>&1" | ForEach-Object { Write-Host $_ }
  if ($LASTEXITCODE) {
    Write-Host 'Fichier de verrouillage désynchronisé : régénération contrôlée.'
    cmd /c "npm install --no-fund 2>&1" | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE) { throw 'Installation des dépendances échouée' }
  }
  cmd /c "npm audit --omit=dev --audit-level=critical 2>&1" | ForEach-Object { Write-Host $_ }
  if ($LASTEXITCODE) { throw 'Vulnérabilité CRITIQUE dans une dépendance : compilation arrêtée (OWASP A03).' }

  Step 'Projet Android (Capacitor) et durcissement'
  if (-not (Test-Path 'android')) { & npx cap add android; if ($LASTEXITCODE) { throw 'cap add android a échoué' } }
  Step 'Préconfiguration du téléphone (adresse Tailscale du PC)'
  $prov = Join-Path $PSScriptRoot 'www\provision.json'
  $pv = @{}
  try {
    $cands = @($env:XAUZ_TAILSCALE, "$env:ProgramFiles\Tailscale\tailscale.exe", "${env:ProgramFiles(x86)}\Tailscale\tailscale.exe", "$env:LOCALAPPDATA\Tailscale\tailscale.exe")
    foreach ($d in (Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root })) { $cands += @("$($d.Root)Tailscale\tailscale.exe", "$($d.Root)Program Files\Tailscale\tailscale.exe") }
    $tsCmd = Get-Command tailscale.exe -ErrorAction SilentlyContinue
    if ($tsCmd) { $cands += $tsCmd.Source }
    $ts = $cands | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if ($ts) {
      $st = (& $ts status --json | Out-String | ConvertFrom-Json)
      $dns = ([string]$st.Self.DNSName) -replace '\.$', ''
      if ($dns -match '^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$') { $pv.remoteUrl = "https://$dns/" }
    }
  } catch { }
  if ($pv.remoteUrl) { Write-Host "Adresse préréglée dans l'application : $($pv.remoteUrl)" -ForegroundColor Green }
  else { Write-Host 'Tailscale introuvable ou non connecté : l''application garde son adresse par défaut (https://joshua.taila406c5.ts.net/).' -ForegroundColor Yellow }

  Step 'Code d''appairage préconfiguré dans l''APK'
  # 1) si le serveur PC tourne déjà, on lui demande un code (30 min, purpose=apk) ;
  # 2) sinon, on le génère directement avec le même code que le serveur (scripts/new-pairing-code.mjs),
  #    qui écrit dans le même DATA_DIR (pairing.json, hash seul) : le serveur, une fois relancé ou
  #    interrogé, le charge depuis le disque (chargement paresseux / fichier le plus récent).
  $pairCode = $null; $pairExpiresAt = $null
  try {
    $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:3777/api/admin/pairing' -Method Post -Headers @{ 'X-XZ' = '1' } -ContentType 'application/json' -Body '{"ttlMin":30,"purpose":"apk"}' -TimeoutSec 5
    $pairCode = $resp.code; $pairExpiresAt = $resp.expiresAt
    Write-Host 'Code obtenu auprès du serveur PC en cours d''exécution (127.0.0.1:3777).'
  } catch {
    Write-Host 'Serveur PC injoignable sur 127.0.0.1:3777 : génération directe du code (scripts\new-pairing-code.mjs).' -ForegroundColor Yellow
    try {
      $out = (& node (Join-Path $PSScriptRoot 'scripts\new-pairing-code.mjs') --ttl 30 --purpose apk --json 2>&1 | Out-String).Trim()
      $j = $out | ConvertFrom-Json
      $pairCode = $j.code; $pairExpiresAt = $j.expiresAt
    } catch { Write-Host "Génération du code d'appairage impossible : $($_.Exception.Message)" -ForegroundColor Yellow }
  }
  if ($pairCode) {
    $pv.pairCode = $pairCode; $pv.expiresAt = $pairExpiresAt
    $fin = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$pairExpiresAt).ToLocalTime().ToString('HH:mm')
    Write-Host "CODE D'APPAIRAGE : $pairCode (valable jusqu'à $fin, une seule fois) — préconfiguré dans l'APK." -ForegroundColor Green
    Write-Host 'Sur le téléphone, l''appairage se fera automatiquement au premier lancement de l''application (aucune saisie).'
  } else {
    Write-Host 'Aucun code d''appairage préconfiguré : saisis-en un manuellement sur le téléphone (code-appairage.bat sur le PC).' -ForegroundColor Yellow
  }

  # provision.json doit rester UTF-8 AVEC BOM (attendu par les outils Capacitor/Gradle qui le relisent) :
  # écrit via Python (encoding='utf-8-sig') plutôt que [IO.File]::WriteAllText, qui omet le BOM.
  function Write-ProvisionJson([string]$jsonText) {
    $tmp = "$prov.tmp"
    [IO.File]::WriteAllText($tmp, $jsonText, (New-Object Text.UTF8Encoding($false)))
    $pyScript = @"
import io
with open(r'$tmp', 'r', encoding='utf-8') as f:
    data = f.read()
with open(r'$prov', 'w', encoding='utf-8-sig') as f:
    f.write(data)
"@
    $pyFile = "$prov.py"
    [IO.File]::WriteAllText($pyFile, $pyScript, (New-Object Text.UTF8Encoding($false)))
    try {
      $pyBin = Get-Command python -ErrorAction SilentlyContinue
      if (-not $pyBin) { $pyBin = Get-Command py -ErrorAction SilentlyContinue }
      if ($pyBin) { & $pyBin.Source $pyFile } else { Write-Host 'Python introuvable : provision.json écrit sans passer par Python (BOM ajouté directement).' -ForegroundColor Yellow; [IO.File]::WriteAllText($prov, $jsonText, (New-Object Text.UTF8Encoding($true))) }
    } finally { Remove-Item $tmp, $pyFile -Force -ErrorAction SilentlyContinue }
  }
  Write-ProvisionJson ($pv | ConvertTo-Json -Compress)
  try {
    & npx cap sync android; if ($LASTEXITCODE) { throw 'cap sync a échoué' }
  } finally {
    Write-ProvisionJson '{}'
  }
  "sdk.dir=$($sdk -replace '\\','\\')" | Set-Content -Encoding ASCII 'android\local.properties'
  $javaDir = 'android\app\src\main\java\fr\xauusd\zones'
  $xmlDir = 'android\app\src\main\res\xml'
  New-Item -ItemType Directory -Force -Path $javaDir, $xmlDir | Out-Null
  Copy-Item 'native\android\TokenVaultPlugin.java', 'native\android\MainActivity.java', 'native\android\LiveKeeperPlugin.java', 'native\android\LiveKeeperService.java' $javaDir -Force
  Copy-Item 'native\android\network_security_config.xml', 'native\android\data_extraction_rules.xml' $xmlDir -Force
  $mf = 'android\app\src\main\AndroidManifest.xml'
  $m = Get-Content $mf -Raw
  $m = $m -replace '\s+android:(allowBackup|fullBackupContent|dataExtractionRules|networkSecurityConfig|usesCleartextTraffic)="[^"]*"', ''
  $m = $m -replace '<application', '<application android:allowBackup="false" android:fullBackupContent="false" android:dataExtractionRules="@xml/data_extraction_rules" android:networkSecurityConfig="@xml/network_security_config" android:usesCleartextTraffic="false"'
  # notifications + analyse en direct en arrière-plan (service au premier plan, usage spécial)
  $m = [regex]::Replace($m, '\s*<!-- xauz-live -->[\s\S]*?<!-- /xauz-live -->', '')
  $perms = @'
    <!-- xauz-live -->
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />
    <!-- /xauz-live -->
'@
  $svc = @'
        <!-- xauz-live -->
        <service android:name=".LiveKeeperService" android:exported="false" android:foregroundServiceType="specialUse">
            <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="Analyse de marché en direct demandée par l'utilisateur (notifications de trading)" />
        </service>
        <!-- /xauz-live -->
'@
  $m = $m -replace '(\s*<application)', ("`n" + $perms + '$1')
  $m = $m -replace '(\s*</application>)', ("`n" + $svc + '$1')
  [IO.File]::WriteAllText((Resolve-Path $mf).Path, $m)  # UTF-8 sans BOM (exigé par Gradle / aapt)
  $vg = 'android\variables.gradle'
  [IO.File]::WriteAllText((Resolve-Path $vg).Path, ((Get-Content $vg -Raw) -replace 'minSdkVersion = \d+', 'minSdkVersion = 26'))
  Write-Host 'Manifeste : sauvegarde désactivée, HTTPS uniquement, coffre Keystore, captures bloquées, notifications, analyse en arrière-plan, Android 8+.'

  Step 'Compilation de l''APK release (Gradle)'
  Push-Location android
  # « .\ » explicite : sans lui, cmd ne trouve pas gradlew.bat si NoDefaultCurrentDirectoryInExePath est défini
  cmd /c ".\gradlew.bat clean assembleRelease --console=plain > ..\build-android.log 2>&1"; $code = $LASTEXITCODE
  Get-Content ..\build-android.log -Tail 30 | ForEach-Object { Write-Host $_ }
  Pop-Location
  if ($code) { throw 'La compilation Gradle a échoué (voir ci-dessus).' }

  Step 'Signature (clé privée locale, mot de passe protégé par Windows DPAPI)'
  $keyDir = Join-Path $env:USERPROFILE '.xauusd-zones'
  New-Item -ItemType Directory -Force -Path $keyDir | Out-Null
  $ks = Join-Path $keyDir 'release.jks'; $pf = Join-Path $keyDir 'release.pass'
  if (-not (Test-Path $ks)) {
    $bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $plain = [Convert]::ToBase64String($bytes) -replace '[+/=]', 'x'
    ConvertTo-SecureString $plain -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -Path $pf
    $env:XAUZ_KS_PASS = $plain
    & "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -keystore $ks -storetype PKCS12 -alias xauz -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=XAUUSD Zones, O=Personnel, C=FR' -storepass:env XAUZ_KS_PASS -keypass:env XAUZ_KS_PASS
    if ($LASTEXITCODE) { throw 'Création de la clé de signature échouée' }
    icacls $keyDir /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
  } else {
    $sec = Get-Content $pf | ConvertTo-SecureString
    $env:XAUZ_KS_PASS = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  }
  $bt = Get-ChildItem "$sdk\build-tools" -Directory | Sort-Object { [version]($_.Name -replace '[^\d.]', '') } -Descending | Select-Object -First 1
  if (-not $bt) { throw 'build-tools Android introuvables (SDK Manager).' }
  $unsigned = 'android\app\build\outputs\apk\release\app-release-unsigned.apk'
  $aligned = 'android\app\build\outputs\apk\release\app-release-aligned.apk'
  $apk = Join-Path $PSScriptRoot 'XAUUSD-Zones.apk'
  & "$($bt.FullName)\zipalign.exe" -p -f 4 $unsigned $aligned; if ($LASTEXITCODE) { throw 'zipalign a échoué' }
  cmd /c "`"$($bt.FullName)\apksigner.bat`" sign --ks `"$ks`" --ks-key-alias xauz --ks-pass env:XAUZ_KS_PASS --key-pass env:XAUZ_KS_PASS --out `"$apk`" `"$aligned`""
  if ($LASTEXITCODE) { throw 'Signature échouée' }
  cmd /c "`"$($bt.FullName)\apksigner.bat`" verify --print-certs `"$apk`"" | Select-Object -First 3 | ForEach-Object { Write-Host $_ }
  Remove-Item Env:\XAUZ_KS_PASS
  Write-Host "APK signé : $apk"

  Step 'Téléphone'
  & adb start-server | Out-Null
  $ok = $false
  for ($i = 0; $i -lt 24 -and -not $ok; $i++) {
    $devices = (& adb devices) | Select-Object -Skip 1 | Where-Object { $_ -match '\S' }
    if ($devices | Where-Object { $_ -match '\tdevice$' }) { $ok = $true; break }
    if ($i -eq 0) { Write-Host "En attente du téléphone (2 min max) : débloque-le, active le débogage USB et accepte « Autoriser le débogage USB »…" }
    Write-Host ("  état : " + ($(if ($devices) { $devices -join ', ' } else { 'aucun appareil' })))
    Start-Sleep -Seconds 5
  }
  if (-not $ok) { throw "APK prêt dans app\XAUUSD-Zones.apk, mais aucun téléphone autorisé en débogage USB. Active-le puis relance ce script (la compilation sera rapide)." }
  Write-Host ($devices -join "`n")

  Step 'Installation sur le téléphone'
  $out = (cmd /c "adb install -r `"$apk`" 2>&1") -join "`n"; Write-Host $out
  if ($out -match 'INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match') {
    Write-Host 'Ancienne version (signature de débogage) détectée : désinstallation puis installation de la version signée.'
    cmd /c "adb uninstall fr.xauusd.zones" | Out-Null
    $out = (cmd /c "adb install `"$apk`" 2>&1") -join "`n"; Write-Host $out
  }
  if ($out -notmatch 'Success') { throw 'adb install a échoué' }
  & adb shell monkey -p fr.xauusd.zones -c android.intent.category.LAUNCHER 1 | Out-Null
  Write-Host "`nTERMINÉ : XAUUSD Zones est installée et lancée sur le téléphone. APK copié dans app\XAUUSD-Zones.apk" -ForegroundColor Green
} catch {
  Write-Host "`nÉCHEC : $($_.Exception.Message)" -ForegroundColor Red
} finally {
  Stop-Transcript | Out-Null
}
Read-Host "`nAppuie sur Entrée pour fermer"
