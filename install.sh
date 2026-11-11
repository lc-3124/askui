#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="${ASKUI_HOME:-$HOME/.local/share/askui/app}"
SKILLS="${DSH_SKILLS:-$HOME/.dsh/skills}"
SKILL_DIR="$SKILLS/askui"

mkdir -p "$APP" "$SKILL_DIR" "$HOME/.local/bin"
rm -rf "$APP/engine" "$APP/web" "$APP/templates"
cp -R "$ROOT/engine" "$ROOT/web" "$ROOT/templates" "$APP/"
mkdir -p "$APP/bin"
cp "$ROOT/bin/askui" "$APP/bin/askui"
chmod +x "$APP/bin/askui" "$APP"/engine/*.mjs
ln -sfn "$APP/bin/askui" "$HOME/.local/bin/askui"
cp "$ROOT/skill/SKILL.md" "$SKILL_DIR/SKILL.md"

echo "installed:"
echo "  $APP"
echo "  $HOME/.local/bin/askui"
echo "  $SKILL_DIR/SKILL.md"

"$HOME/.local/bin/askui" init >/dev/null
echo "first-run setup done. try: askui status"
