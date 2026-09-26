@echo off
title XAUUSD Zones - serveur PC
cd /d "%~dp0"
where node 1>NUL 2>NUL
if errorlevel 1 goto nonode
if exist "..\node_modules\chrome-remote-interface" goto deps_ok
echo Installation des dependances du projet, versions figees...
pushd ..
call npm ci --no-fund
popd
:deps_ok
rem TradingView Desktop doit tourner avec le port de debogage local 127.0.0.1:9222
curl -s -m 2 http://127.0.0.1:9222/json/version 1>NUL 2>NUL
if not errorlevel 1 goto tv_ok
echo Lancement de TradingView Desktop en mode debogage local...
call "..\scripts\launch_tv_debug.bat"
:tv_ok
echo.
echo XAUUSD Zones : http://localhost:3777
echo Garde cette fenetre ouverte : la fermer arrete le serveur.
echo Le code d appairage du telephone s affiche ci-dessous (Entree = nouveau code).
node server.js %*
pause
goto :eof
:nonode
echo Node.js est requis : https://nodejs.org
pause
