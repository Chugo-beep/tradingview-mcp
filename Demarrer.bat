@echo off
chcp 65001 >nul
title XAUUSD Zones
cd /d "%~dp0"
echo.
echo   XAUUSD Zones - demarrage en un clic
echo.

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

echo   L'application s'ouvre dans une fenetre ^(TradingView Desktop est lance automatiquement^).
echo   Garde cette fenetre ouverte : la fermer arrete le serveur.
echo.
node app\server.js --no-code %*
pause
