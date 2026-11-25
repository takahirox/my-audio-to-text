#!/usr/bin/env bash
set -euo pipefail

case "$(uname -s)" in
  Darwin) exec node --test "$@" tests/desktop/macos.test.js ;;
  Linux) exec dbus-run-session -- xvfb-run -a -s "-screen 0 1400x900x24" bash tests/desktop/run-x11.sh "$@" ;;
  *) echo "Run the desktop tests on macOS or Linux X11." >&2; exit 1 ;;
esac
