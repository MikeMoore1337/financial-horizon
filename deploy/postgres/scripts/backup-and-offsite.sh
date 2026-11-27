#!/usr/bin/env bash
# The service must fail unless both encrypted local backup and external
# integrity-verified copy succeed. Never infer offsite success from pg_dump.
set -euo pipefail
umask 077
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
archive="$("$script_dir/backup.sh")"
[[ -f "$archive" && -s "$archive" ]] || {
  echo "Local encrypted archive was not created" >&2
  exit 1
}
"$script_dir/offsite-upload.sh" "$archive"
