@echo off
chcp 65001 >nul
title XAUUSD Zones
cd /d "%~dp0"
echo.
echo   XAUUSD Zones - demarrage en un clic
echo.

rem Deja demarre ? On ouvre simplement l'application : ne jamais relancer TradingView ni un 2e serveur.
curl -s -m 2 -H "X-XZ: 1" http://127.0.0.1:3777/api/health 2>nul | findstr /c:"xauusd-zones" >nul
if not errorlevel 1 (
    echo   L'application tourne deja : ouverture de la fenetre.
    start "" msedge --app=http://localhost:3777 2>nul || start "" http://localhost:3777
    exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
    echo   Node.js est absent : installation automatique via winget...
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    where node >nul 2>nul
    if errorlevel 1 (
        echo.
        echo   Installation impossible automatiquement. Installe Node.js LTS : https://nodejs.org
        echo   puis double-clique de nouveau sur Demarrer.bat.
        pause
        exit /b 1
    )
)

if not exist "node_modules\chrome-remote-interface" (
    echo   Premiere utilisation : installation des dependances ^(1 a 2 minutes^)...
    call npm ci --no-fund --no-audit
    if errorlevel 1 ( echo   Echec de l'installation. & pause & exit /b 1 )
)

rem TradingView Desktop doit repondre sur le port de debogage local 127.0.0.1:9222.
rem Sinon on le (re)lance UNE fois et on attend qu'il soit pret AVANT de demarrer le serveur.
curl -s -m 2 http://127.0.0.1:9222/json/version >nul 2>nul
if errorlevel 1 (
    echo   Lancement de TradingView Desktop en mode debogage...
    echo   ^(s'il etait deja ouvert sans ce mode, il est ferme puis rouvert^)
    call "scripts\launch_tv_debug.bat"
)

echo.
echo   L'application s'ouvre dans une fenetre. Attends que le graphique TradingView soit affiche.
echo   Garde cette fenetre ouverte : la fermer arrete le serveur.
echo.
node app\server.js %*
pause
