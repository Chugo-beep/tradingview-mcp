# Publie l'API téléphone (127.0.0.1:3778) en HTTPS dans ton réseau privé Tailscale.
# Rien n'est ouvert sur Internet : seuls tes appareils connectés à ton compte Tailscale y accèdent.
param([switch]$Off)
Start-Transcript -Path (Join-Path $PSScriptRoot 'acces-distant.log') -Force | Out-Null
try {
  # Tailscale peut être installé sur n'importe quel lecteur (ex. B:\Tailscale)
  $cands = @($env:XAUZ_TAILSCALE, "$env:ProgramFiles\Tailscale\tailscale.exe", "${env:ProgramFiles(x86)}\Tailscale\tailscale.exe", "$env:LOCALAPPDATA\Tailscale\tailscale.exe")
  foreach ($d in (Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root })) { $cands += @("$($d.Root)Tailscale\tailscale.exe", "$($d.Root)Program Files\Tailscale\tailscale.exe") }
  $cmd = Get-Command tailscale.exe -ErrorAction SilentlyContinue
  if ($cmd) { $cands += $cmd.Source }
  $ts = $cands | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if ($ts) { Write-Host "Tailscale trouvé : $ts" }
  if (-not $ts) { throw "Tailscale n'est pas installé. Installe-le depuis https://tailscale.com/download/windows, connecte-toi, puis relance ce script. Installe aussi l'app Tailscale sur le téléphone avec le même compte." }
  if ($Off) {
    & $ts serve --https=443 off
    Write-Host "Accès distant désactivé." -ForegroundColor Green
    return
  }
  $st = (& $ts status --json | Out-String | ConvertFrom-Json)
  if ($st.BackendState -ne 'Running') {
    Write-Host 'Connexion à Tailscale (une page de connexion peut s''ouvrir)…'
    & $ts up
    $st = (& $ts status --json | Out-String | ConvertFrom-Json)
  }
  if ($st.BackendState -ne 'Running') { throw 'Tailscale n''est pas connecté.' }
  Write-Host 'Publication HTTPS de l''API téléphone dans le tailnet (tailscale serve)…'
  Write-Host 'Si un lien s''affiche pour activer « HTTPS Certificates » ou MagicDNS, ouvre-le, active l''option, puis relance ce script.'
  $out = (& $ts serve --bg --https=443 http://127.0.0.1:3778 2>&1 | Out-String)
  Write-Host $out
  if ($LASTEXITCODE -or $out -match 'not enabled|Contact your administrator|error|failed') {
    throw ("Tailscale Serve / HTTPS n'est pas activé sur ton compte. Ouvre https://login.tailscale.com/admin/dns, " +
      "active « MagicDNS » puis « HTTPS Certificates » (bouton Enable HTTPS). Si un lien https://login.tailscale.com/f/serve… " +
      "est affiché ci-dessus, ouvre-le et valide. Relance ensuite ce script.")
  }
  $status = (& $ts serve status 2>&1 | Out-String)
  Write-Host $status
  if ($status -notmatch '127\.0\.0\.1:3778') { throw 'La publication n''apparaît pas dans « tailscale serve status » : relance ce script.' }
  $dns = ($st.Self.DNSName -replace '\.$', '')
  Write-Host "`nAdresse à saisir dans l'application sur le téléphone :" -ForegroundColor Green
  Write-Host "   https://$dns" -ForegroundColor Green
  Write-Host "Puis, sur le PC : Réglages → « Générer un code d'appairage »."
} catch {
  Write-Host "`nÉCHEC : $($_.Exception.Message)" -ForegroundColor Red
} finally { Stop-Transcript | Out-Null }
Read-Host "`nAppuie sur Entrée pour fermer"
