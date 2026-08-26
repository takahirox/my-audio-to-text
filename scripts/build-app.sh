#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_dir="${project_root}/dist/My Audio to Text.app"

swift build --package-path "${project_root}" -c release --product MyAudioToText
bin_dir="$(swift build --package-path "${project_root}" -c release --show-bin-path)"

rm -rf "${app_dir}"
mkdir -p "${app_dir}/Contents/MacOS" "${app_dir}/Contents/Resources"
cp "${bin_dir}/MyAudioToText" "${app_dir}/Contents/MacOS/MyAudioToText"
cp "${project_root}/Support/Info.plist" "${app_dir}/Contents/Info.plist"
codesign --force --deep --sign - "${app_dir}"

echo "Built ${app_dir}"
