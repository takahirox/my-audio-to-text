#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
swift test --package-path "${project_root}"
swift build --package-path "${project_root}" -c release --product MyAudioToText
swift build --package-path "${project_root}" -c release --product PersonalizationEval
swift build --package-path "${project_root}" -c release --product AudioBenchmarkBridge
python3 -m unittest discover -s "${project_root}/Tests/benchmark" -v
