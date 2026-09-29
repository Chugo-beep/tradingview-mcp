#!/usr/bin/env bash
# Démarrage en une commande (macOS / Linux) : ./start.sh
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null || { echo "Installe Node.js LTS : https://nodejs.org"; exit 1; }
[ -d node_modules/chrome-remote-interface ] || npm ci --no-fund --no-audit
exec node app/server.js --no-code "$@"
