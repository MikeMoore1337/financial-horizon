#!/usr/bin/env bash
# #66 - one-time, minimal preparation for OWNER-APPROVED PERSONAL PostgreSQL.
# Generates secrets only inside FH-private paths. Does NOT start Docker,
# change FH email auth, format disks, enable finance routes, or delete data.
set -Eeuo pipefail
umask 077

deny() { printf 'FINANCE_PERSONAL_PREPARE_NO_GO: %s\n' "$1" >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || deny ROOT_REQUIRED
[[ "${GITHUB_ACTIONS:-}" != true ]] || deny NEVER_RUN_IN_CI
[[ "${FH_FINANCE_PERSONAL_MODE:-}" = YES ]] || deny EXPLICIT_OWNER_PERSONAL_MODE_REQUIRED
[[ "${FH_FINANCE_DATA_DIR:-}" = /srv/financial-horizon-finance/pgdata ]] ||
  deny FIXED_PRIVATE_DATA_PATH_REQUIRED
[[ "${FH_FINANCE_APPROVED_SHA:-}" =~ ^[0-9a-f]{40}$ ]] ||
  deny EXACT_RELEASE_SHA_REQUIRED
for command in git gpg python3 stat realpath; do
  command -v "$command" >/dev/null || deny "MISSING_${command}"
done

root="$(git rev-parse --show-toplevel)" || deny NOT_IN_REPOSITORY
cd "$root"
[[ "$(git rev-parse HEAD)" = "$FH_FINANCE_APPROVED_SHA" ]] || deny CHECKOUT_SHA_MISMATCH
[[ -z "$(git status --porcelain)" ]] || deny DIRTY_CHECKOUT
[[ "$(git remote get-url origin)" =~ ^(https://github.com/|git@github.com:)MikeMoore1337/financial-horizon(\.git)?$ ]] ||
  deny UNTRUSTED_ORIGIN
[[ -f deploy/postgres/scripts/personal-bootstrap.sh ]] || deny MISSING_BOOTSTRAP

# The selected paths are fixed intentionally. Existing finance data must be
# inspected, never reset by a convenience setup command.
for path in /etc/financial-horizon/finance \
  /etc/financial-horizon/finance/secrets \
  /etc/financial-horizon/finance/gnupg \
  /srv/financial-horizon-finance/pgdata \
  /var/backups/financial-horizon-finance; do
  [[ ! -L "$path" ]] || deny SYMLINK_FORBIDDEN
  [[ ! -e "$path" || -d "$path" ]] || deny NON_DIRECTORY_IN_FINANCE_PATH
done
if [[ -d "$FH_FINANCE_DATA_DIR" ]]; then
  [[ -z "$(find "$FH_FINANCE_DATA_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]] ||
    deny EXISTING_FINANCE_DATABASE_DO_NOT_REINITIALIZE
fi
install -d -o root -g root -m 0700 /etc/financial-horizon/finance
install -d -o root -g root -m 0700 /etc/financial-horizon/finance/secrets
install -d -o root -g root -m 0700 /etc/financial-horizon/finance/gnupg
install -d -o root -g root -m 0700 /var/backups/financial-horizon-finance
install -d -o 999 -g 999 -m 0700 /srv/financial-horizon-finance/pgdata

# Secrets are random hex with no shell-sensitive characters, never printed,
# never passed in CLI arguments, and created O_EXCL against accidental overwrite.
python3 - <<'PY'
import os
import secrets
import stat
from pathlib import Path

directory = Path("/etc/financial-horizon/finance/secrets")
names = ("admin_password", "migrator_password", "runtime_password")
existing = [directory / n for n in names if (directory / n).exists()]
if len(existing) not in (0, len(names)):
    raise SystemExit("FINANCE_PERSONAL_PREPARE_NO_GO=PARTIAL_SECRETS_REQUIRE_MANUAL_REVIEW")
if not existing:
    for name in names:
        path = directory / name
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o400)
        try:
            os.fchown(fd, 999, 999)
            os.fchmod(fd, 0o400)
            os.write(fd, secrets.token_hex(32).encode("ascii"))
            os.fsync(fd)
        finally:
            os.close(fd)
seen = set()
for name in names:
    path = directory / name
    meta = path.lstat()
    if not stat.S_ISREG(meta.st_mode) or stat.S_IMODE(meta.st_mode) != 0o400 or meta.st_uid != 999:
        raise SystemExit("FINANCE_PERSONAL_PREPARE_NO_GO=UNSAFE_SECRET_FILE")
    raw = path.read_bytes()
    if len(raw) != 64 or not all(chr(ch) in "0123456789abcdef" for ch in raw):
        raise SystemExit("FINANCE_PERSONAL_PREPARE_NO_GO=UNKNOWN_SECRET_FORMAT")
    seen.add(raw)
if len(seen) != len(names):
    raise SystemExit("FINANCE_PERSONAL_PREPARE_NO_GO=DUPLICATE_SECRETS")
PY

keyring=/etc/financial-horizon/finance/gnupg
# Prefer a pre-existing FH-specific recovery key. Never overwrite it.
keys="$(gpg --homedir "$keyring" --batch --with-colons --list-secret-keys 2>/dev/null |
  awk -F: '$1 == "sec" { n++ } END { print n + 0 }')"
[[ "$keys" =~ ^[0-9]+$ ]] || deny KEYRING_UNREADABLE
(( keys <= 1 )) || deny MULTIPLE_RECOVERY_KEYS_REQUIRE_REVIEW
if (( keys == 0 )); then
  gpg --homedir "$keyring" --batch --pinentry-mode loopback --passphrase '' \
    --quick-generate-key 'Financial Horizon Personal Backup <backup@localhost>' \
    rsa3072 encr 0 >/dev/null 2>&1 ||
    deny GPG_KEY_GENERATION_FAILED
fi
fingerprint="$(gpg --homedir "$keyring" --batch --with-colons --list-secret-keys 2>/dev/null |
  awk -F: '$1 == "fpr" { print $10; exit }')"
[[ "$fingerprint" =~ ^[0-9A-Fa-f]{40}$ ]] || deny INVALID_PRIVATE_GPG_FINGERPRINT

# Prove encryption AND decryption work before any financial dump exists.
teststring='FH_PERSONAL_RECOVERY_SELF_TEST'
recovered="$(printf %s "$teststring" |
  gpg --homedir "$keyring" --batch --no-tty --trust-model always \
    --recipient "$fingerprint" --encrypt 2>/dev/null |
  gpg --homedir "$keyring" --batch --no-tty --decrypt 2>/dev/null)" ||
  deny RECOVERY_KEY_SELF_TEST_FAILED
[[ "$recovered" = "$teststring" ]] || deny GPG_RECOVERY_MISMATCH
unset recovered teststring

backup_env=/etc/financial-horizon/finance/backup.env
start_env=/etc/financial-horizon/finance/start.env
if [[ -e "$backup_env" ]]; then
  [[ ! -L "$backup_env" && -f "$backup_env" &&
     "$(stat -c '%a:%u' "$backup_env")" = 600:0 ]] ||
    deny EXISTING_BACKUP_CONFIG_UNSAFE
  grep -Fxq "FH_FINANCE_GPG_RECIPIENT=$fingerprint" "$backup_env" ||
    deny EXISTING_BACKUP_KEY_MISMATCH
  grep -Fxq 'FH_FINANCE_GPG_HOME=/etc/financial-horizon/finance/gnupg' "$backup_env" ||
    deny EXISTING_BACKUP_KEYRING_MISMATCH
  grep -Fxq 'FH_FINANCE_BACKUP_DIR=/var/backups/financial-horizon-finance' "$backup_env" ||
    deny EXISTING_BACKUP_PATH_MISMATCH
else
  (set -C; printf 'FH_FINANCE_GPG_RECIPIENT=%s\nFH_FINANCE_GPG_HOME=%s\nFH_FINANCE_BACKUP_DIR=%s\n' \
    "$fingerprint" "$keyring" /var/backups/financial-horizon-finance > "$backup_env") ||
    deny BACKUP_CONFIG_ALREADY_EXISTS
  chmod 0600 "$backup_env"
fi
if [[ -e "$start_env" ]]; then
  [[ ! -L "$start_env" && -f "$start_env" &&
     "$(stat -c '%a:%u' "$start_env")" = 600:0 ]] ||
    deny EXISTING_START_CONFIG_UNSAFE
  grep -Fxq "FH_FINANCE_APPROVED_SHA=$FH_FINANCE_APPROVED_SHA" "$start_env" ||
    deny START_CONFIG_PINNED_TO_ANOTHER_SHA
  grep -Fxq "FH_FINANCE_CHECKOUT_DIR=$root" "$start_env" ||
    deny START_CONFIG_PINNED_TO_ANOTHER_CHECKOUT
else
  (set -C; printf 'FH_FINANCE_PERSONAL_MODE=YES\nFH_FINANCE_APPROVED_SHA=%s\nFH_FINANCE_DATA_DIR=/srv/financial-horizon-finance/pgdata\nFH_FINANCE_CHECKOUT_DIR=%s\n' \
    "$FH_FINANCE_APPROVED_SHA" "$root" > "$start_env") ||
    deny START_CONFIG_ALREADY_EXISTS
  chmod 0600 "$start_env"
fi
bash deploy/postgres/scripts/personal-storage-preflight.sh ||
  deny STORAGE_PREFLIGHT_FAILED

printf 'FINANCE_PERSONAL_PREPARE=PASS\n'
printf 'FINANCE_PRIVATE_SECRETS=CREATED_OR_VERIFIED\n'
printf 'FINANCE_LOCAL_GPG_ENCRYPT_DECRYPT=PASS\n'
printf 'FINANCE_DATABASE_NOT_STARTED=YES\n'
printf 'FINANCE_AUTH_AND_PWA_UNCHANGED=YES\n'
