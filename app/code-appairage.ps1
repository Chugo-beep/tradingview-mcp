# Génère un code d'appairage (8 chiffres, 10 min, usage unique) auprès du serveur XAUUSD Zones local.
try {
  $r = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3777/api/admin/pairing' -Headers @{ 'X-XZ' = '1' } -TimeoutSec 5
  $fin = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$r.expiresAt).LocalDateTime.ToString('HH:mm')
  Write-Host "`nCode d'appairage :  $($r.code.Substring(0,4)) $($r.code.Substring(4))" -ForegroundColor Green
  Write-Host "Valable jusqu'à $fin, une seule fois. À saisir dans l'app du téléphone : Réglages → Connexion au PC."
} catch {
  Write-Host "`nServeur XAUUSD Zones injoignable : lance d'abord XAUUSD-Zones.bat (et garde sa fenêtre ouverte)." -ForegroundColor Red
}
Read-Host "`nAppuie sur Entrée pour fermer"
