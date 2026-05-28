#!/usr/bin/env bash
set -euo pipefail

COLLECTION="${1:-CC-MAIN-2026-21}"
COUNT="${2:-30}"
PARALLEL="${3:-4}"
ROOT="data/commoncrawl/${COLLECTION}"
PATHS_GZ="${ROOT}/cc-index.paths.gz"
PATHS="${ROOT}/cc-index.paths"
SAMPLE="${ROOT}/cc-index.sample-${COUNT}.paths"
SHARDS="${ROOT}/shards"
BASE="https://data.commoncrawl.org"

mkdir -p "${ROOT}" "${SHARDS}"

if [[ ! -s "${PATHS_GZ}" ]]; then
  curl -fL --retry 8 --retry-delay 5 -o "${PATHS_GZ}" "${BASE}/crawl-data/${COLLECTION}/cc-index.paths.gz"
fi

if [[ ! -s "${PATHS}" ]]; then
  gzip -cd "${PATHS_GZ}" > "${PATHS}"
fi

python3 - "${PATHS}" "${COUNT}" "${SAMPLE}" <<'PY'
import sys
from pathlib import Path
paths = [
    path
    for path in Path(sys.argv[1]).read_text().splitlines()
    if Path(path).name.startswith("cdx-") and path.endswith(".gz")
]
count = int(sys.argv[2])
out = Path(sys.argv[3])
if not paths:
    raise SystemExit("empty cdx path list")
if count >= len(paths):
    selected = paths
else:
    indexes = sorted({round(i * (len(paths) - 1) / (count - 1)) for i in range(count)})
    selected = [paths[i] for i in indexes]
out.write_text("\n".join(selected) + "\n")
print(f"selected {len(selected)} of {len(paths)} cdx shards -> {out}")
PY

cd "${SHARDS}"
xargs -a "../cc-index.sample-${COUNT}.paths" -P "${PARALLEL}" -I{} bash -c '
  set -euo pipefail
  path="$1"
  file="$(basename "$path")"
  if [[ -s "$file" ]]; then
    echo "exists $file"
    exit 0
  fi
  echo "downloading $file"
  curl -fL --retry 8 --retry-delay 5 -C - -O "https://data.commoncrawl.org/$path"
' _ {}

du -sh .
