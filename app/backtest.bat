@echo off
REM Backtest long terme (donnees historiques gratuites Dukascopy) - XAUUSD Zones
REM Demande le marche et lance scripts/backtest-dukascopy.mjs depuis ce dossier (app/).

cd /d "%~dp0"

echo.
echo   Marches disponibles : XAUUSD US30 SP500 NAS100 EURUSD GBPUSD USDJPY DAX40 CAC40 WTI BRENT
set /p MARKET="  Marche a tester (defaut XAUUSD) : "
if "%MARKET%"=="" set MARKET=XAUUSD

set /p FROM="  Date de debut (AAAA-MM-JJ, defaut 2023-01-01) : "
if "%FROM%"=="" set FROM=2023-01-01

set /p TO="  Date de fin (AAAA-MM-JJ, vide = aujourd'hui) : "

set /p STRAT="  Strategie (smc ou ob5, defaut smc) : "
if "%STRAT%"=="" set STRAT=smc

set /p MODE="  Mode d'objectif (atr ou pips, defaut atr) : "
if "%MODE%"=="" set MODE=atr

if not exist "node_modules\dukascopy-node" (
    echo   Installation du telechargeur d'historique gratuit (dukascopy-node^)...
    call npm install dukascopy-node --no-save --no-audit --no-fund
)
set TOARG=
if not "%TO%"=="" set TOARG=--to %TO%

echo.
echo   Lancement : node scripts\backtest-dukascopy.mjs --market %MARKET% --from %FROM% %TOARG% --mode %MODE% --strategy %STRAT%
echo.
node scripts\backtest-dukascopy.mjs --market %MARKET% --from %FROM% %TOARG% --mode %MODE% --strategy %STRAT%

echo.
pause
