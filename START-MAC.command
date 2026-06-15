#!/bin/bash
cd "$(dirname "$0")"

# make node visible even when Terminal is launched from Finder
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "[ERROR] Node.js is not installed."
  echo "Download and install it from https://nodejs.org (LTS version), then run this file again."
  echo
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run — installing dependencies, this takes a minute..."
  if ! npm install; then
    echo
    echo "[ERROR] npm install failed. Check your internet connection and try again."
    echo
    read -n 1 -s -r -p "Press any key to close..."
    exit 1
  fi
fi

echo
echo "Starting Conveyer Treso..."
echo "The app will open at http://localhost:3777 (keep this window open)"
echo "To stop the app: close this window or press Ctrl+C"
echo
( sleep 6 && open "http://localhost:3777" ) &
npm run dev
