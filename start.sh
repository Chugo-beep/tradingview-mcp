#!/usr/bin/env bash
# Démarrage en une commande (macOS / Linux) : ./start.sh
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null || { echo "Installe Node.js LTS : https://nodejs.org"; exit 1; }
[ -d node_modules/chrome-remote-interface ] || npm ci --no-fund --no-audit
# TradingView Desktop doit répondre sur le port de débogage : sinon on le lance une fois et on attend qu'il soit prêt.
if ! curl -s -m 2 http://127.0.0.1:9222/json/version >/dev/null; then
  if [ "$(uname)" = "Darwin" ]; then bash scripts/launch_tv_debug_mac.sh; else bash scripts/launch_tv_debug_linux.sh; fi
fi
exec node app/server.js "$@"
