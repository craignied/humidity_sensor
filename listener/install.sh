#!/bin/bash
# Install the humidity listener + dashboard as launchd LaunchAgents on this Mac.
# Run from the listener/ directory: ./install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Prefer pyenv's python if present, else fall back to python3 on PATH.
if [ -x "$HOME/.pyenv/shims/python" ]; then
    PYTHON="$HOME/.pyenv/shims/python"
else
    PYTHON="$(command -v python3)"
fi
echo "Using python: $PYTHON"
mkdir -p "$HOME/Library/LaunchAgents"

install_agent() {
    local label="$1" script="$2"
    local src="$SCRIPT_DIR/$label.plist"
    local dst="$HOME/Library/LaunchAgents/$label.plist"
    sed -e "s|__PYTHON__|$PYTHON|g" \
        -e "s|__SCRIPT__|$SCRIPT_DIR/$script|g" \
        -e "s|__HOME__|$HOME|g" \
        "$src" > "$dst"
    launchctl unload "$dst" 2>/dev/null || true
    launchctl load -w "$dst"
    echo "Installed and loaded: $label"
}

install_agent com.niedertronics.humidity.listener  humidity_listener.py
install_agent com.niedertronics.humidity.dashboard dashboard.py

echo "Check:      launchctl list | grep humidity"
echo "Logs:       ~/Library/Logs/humidity-listener.log  /  humidity-dashboard.log"
echo "Dashboard:  http://$(hostname -s).local:8011  (Safari; Chrome can't resolve .local)"
