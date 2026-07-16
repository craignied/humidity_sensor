#!/bin/bash
# Install the humidity listener as a launchd LaunchAgent on this Mac.
# Run from the listener/ directory: ./install.sh
set -euo pipefail

LABEL="com.niedertronics.humidity.listener"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_SRC="$SCRIPT_DIR/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

# Prefer pyenv's python if present, else fall back to python3 on PATH.
if [ -x "$HOME/.pyenv/shims/python" ]; then
    PYTHON="$HOME/.pyenv/shims/python"
else
    PYTHON="$(command -v python3)"
fi
echo "Using python: $PYTHON"

# Fill in the placeholders, pointing at THIS checkout's listener script.
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|__PYTHON__|$PYTHON|g" \
    -e "s|__HOME__/code/humidity-node/listener/humidity_listener.py|$SCRIPT_DIR/humidity_listener.py|g" \
    -e "s|__HOME__|$HOME|g" \
    "$PLIST_SRC" > "$PLIST_DST"

# Reload if already installed.
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load -w "$PLIST_DST"

echo "Installed and loaded: $LABEL"
echo "Check:  launchctl list | grep humidity"
echo "Logs:   ~/Library/Logs/humidity-listener.log"
