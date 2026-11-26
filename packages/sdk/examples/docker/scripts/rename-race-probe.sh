#!/usr/bin/env bash
# Measure reads of a host file while the host replaces it by atomic rename.
# Report stale-size reads and their timing for a bind mount or local volume.
set -euo pipefail

if [[ $# -ne 1 || ( $1 != bind && $1 != volume ) ]]; then
  printf 'Run %s with bind or volume.\n' "${0##*/}" >&2
  exit 2
fi

kind=$1
image='node@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c'
directory=$(mktemp -d "$HOME/.byos-rename-probe.XXXXXX")
container=''
volume=''

cleanup() {
  if [[ -n $container ]]; then
    docker rm --force "$container" >/dev/null 2>&1 || true
  fi
  if [[ -n $volume ]]; then
    docker volume rm "$volume" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$directory"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'AAAAAAAA' > "$directory/file"
printf 'BBBBBBBBBBBBBBBBBBBBBBBB' > "$directory/replacement"

if [[ $kind == volume ]]; then
  volume="byos-rename-probe-$RANDOM$RANDOM"
  docker volume create --driver local --opt type=none --opt o=bind \
    --opt "device=$directory" "$volume" >/dev/null
  mount="type=volume,source=$volume,target=/workspace"
else
  mount="type=bind,source=$directory,target=/workspace"
fi

container=$(docker run --detach --rm --pull=never --network=none --mount "$mount" "$image" node -e '
const fs = require("node:fs");
const samples = [];
const start = Date.now();
fs.writeFileSync("/tmp/ready", "");
while (Date.now() - start < 6000) {
  try {
    const value = fs.readFileSync("/workspace/file", "latin1");
    samples.push([Date.now(), value]);
  } catch (error) {
    samples.push([Date.now(), "ERR " + error.code]);
  }
}
fs.writeFileSync("/tmp/samples.json", JSON.stringify(samples));
setTimeout(() => {}, 30000);
')

for ((attempt = 0; attempt < 20; attempt++)); do
  if docker exec "$container" test -f /tmp/ready; then
    break
  fi
  sleep 0.1
done
if [[ $attempt -eq 20 ]]; then
  printf 'The reader did not start.\n' >&2
  exit 1
fi

rename_ms=$(node -e '
require("node:fs").renameSync(process.argv[1], process.argv[2]);
console.log(Date.now());
' "$directory/replacement" "$directory/file")

sleep 6
docker exec "$container" cat /tmp/samples.json | node -e '
const samples = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
const renamed = Number(process.argv[1]);
const counts = new Map();
let firstComplete = null;
let lastTruncated = null;
for (const [time, value] of samples) {
  let kind;
  if (value === "A".repeat(8)) {
    kind = "old";
  } else if (value === "B".repeat(24)) {
    kind = "complete";
    firstComplete ??= time - renamed;
  } else if (value === "B".repeat(8)) {
    kind = "truncated";
    lastTruncated = time - renamed;
  } else {
    kind = "other: " + JSON.stringify(value);
  }
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
}
console.log(JSON.stringify({
  mount: process.argv[2],
  reads: Object.fromEntries(counts),
  firstCompleteMsAfterRename: firstComplete,
  lastTruncatedMsAfterRename: lastTruncated
}));
' "$rename_ms" "$kind"
