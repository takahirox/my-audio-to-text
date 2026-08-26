#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
swift test --package-path "${project_root}"
swift build --package-path "${project_root}" -c release --product MyAudioToText
