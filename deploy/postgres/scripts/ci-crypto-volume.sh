#!/usr/bin/env bash
# Real LUKS2 positive/negative preflight using a disposable GitHub runner.
# Never used on a production device and never prints or uploads crypto keys.
set -Eeuo pipefail
umask 077
if [[ "${GITHUB_ACTIONS:-}" != "true" ||
      "${FH_FINANCE_CI_ALLOW_BOOTSTRAP:-}" != "yes" ]]; then
  echo "CI_LUKS_TEST_REFUSED: synthetic GitHub runner required" >&2
  exit 1
fi
command -v sudo >/dev/null
command -v losetup >/dev/null
command -v mkfs.ext4 >/dev/null
if ! command -v cryptsetup >/dev/null; then
  sudo apt-get update -qq >/dev/null
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cryptsetup-bin >/dev/null
fi

base="$(mktemp -d)"
mapper="fh-finance-ci-$$"
loop=""
cleanup() {
  local status=$?
  if mountpoint -q "$base/data" 2>/dev/null; then
    sudo umount "$base/data" || status=1
  fi
  if [[ -e "/dev/mapper/$mapper" ]]; then
    sudo cryptsetup close "$mapper" || status=1
  fi
  if [[ -n "$loop" ]]; then
    sudo losetup -d "$loop" || status=1
  fi
  rm -rf -- "$base" || status=1
  exit "$status"
}
trap cleanup EXIT

# Sparse 3GiB block image: no existing host disks or services are modified.
truncate -s 3G "$base/ci-image"
head -c 64 /dev/urandom > "$base/ci-only.key"
chmod 600 "$base/ci-only.key"
loop="$(sudo losetup -f --show "$base/ci-image")"
sudo cryptsetup luksFormat --batch-mode --type luks2 \
  --key-file "$base/ci-only.key" "$loop" >/dev/null
sudo cryptsetup open --type luks --key-file "$base/ci-only.key" \
  "$loop" "$mapper" >/dev/null
sudo mkfs.ext4 -q -F "/dev/mapper/$mapper" >/dev/null
mkdir -m 700 "$base/data"
sudo mount -o nodev,nosuid,noatime "/dev/mapper/$mapper" "$base/data"
sudo chown 999:999 "$base/data"
sudo chmod 700 "$base/data"
# Production preflight runs as root. cryptsetup status cannot be queried
# by an unprivileged runner, so the test must exercise the same privilege level.
sudo env FH_FINANCE_DATA_DIR="$base/data" FH_FINANCE_MAPPER_NAME="$mapper" \
  bash deploy/postgres/scripts/storage-preflight.sh
sudo umount "$base/data"

# The same directory without its encrypted mount must fail closed.
if sudo env FH_FINANCE_DATA_DIR="$base/data" FH_FINANCE_MAPPER_NAME="$mapper" \
  bash deploy/postgres/scripts/storage-preflight.sh >/dev/null 2>&1; then
  echo "CI_LUKS_TEST_FAILED: plain directory was accepted" >&2
  exit 1
fi
echo "CI_LUKS2_PASS: encrypted mount accepted; unmounted directory rejected"
