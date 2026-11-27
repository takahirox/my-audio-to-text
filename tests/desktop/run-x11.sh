#!/usr/bin/env bash
set -euo pipefail
export XDG_SESSION_TYPE=x11
export GTK_MODULES=gail:atk-bridge
export GNOME_ACCESSIBILITY=1
desktop_tmp=$(mktemp -d)
export XDG_CONFIG_HOME="$desktop_tmp/config"
export XDG_CACHE_HOME="$desktop_tmp/cache"
export XDG_DATA_HOME="$desktop_tmp/data"
export XDG_RUNTIME_DIR="$desktop_tmp/runtime"
mkdir -m 700 -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_RUNTIME_DIR"
export PULSE_SERVER="unix:$XDG_RUNTIME_DIR/pulse/native"

cleanup() {
  kill "${tray_pid:-}" "${wm_pid:-}" 2>/dev/null || true
  pulseaudio -k 2>/dev/null || true
  wait "${tray_pid:-}" "${wm_pid:-}" 2>/dev/null || true
  rm -rf "$desktop_tmp" 2>/dev/null || true
}
trap cleanup EXIT

openbox --sm-disable >"$desktop_tmp/openbox.log" 2>&1 &
wm_pid=$!
trayer --edge top --align right --widthtype pixel --width 32 --height 28 >"$desktop_tmp/tray.log" 2>&1 &
tray_pid=$!
pulseaudio --daemonize=yes --exit-idle-time=-1 --log-target=syslog
pactl load-module module-null-sink sink_name=voice_fixture rate=16000 channels=1 >/dev/null
pactl load-module module-remap-source master=voice_fixture.monitor source_name=voice_mic channels=1 >/dev/null
pactl set-default-source voice_mic
node --test --test-concurrency=1 "$@" tests/desktop/x11.test.js tests/desktop/graph-parity.test.js
