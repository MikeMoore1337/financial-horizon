#!/usr/bin/env bash
# Root/operator-only one-time provisioning. NEVER executed by GitHub Actions.
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/bin
umask 077
fail() { echo "FH_PROVISION_FAILED=$1" >&2; exit 1; }
[[ "$EUID" -eq 0 ]] || fail ROOT_REQUIRED
[[ "${1:-}" == --initial-setup && "$#" -eq 3 ]] || fail USAGE_INITIAL_SETUP_ONLY
[[ "$2" =~ ^[a-f0-9]{64}$ && "$3" =~ ^[a-f0-9]{64}$ ]] || fail DIGEST_REQUIRED
source_dir="$(cd "$(dirname "$0")" && pwd -P)"
source_file="$source_dir/fh_static_deploy.py"
[[ -f "$source_file" && ! -L "$source_file" ]] || fail SOURCE_INVALID
[[ "$(sha256sum "$source_file" | cut -d' ' -f1)" == "$2" ]] || fail HANDLER_HASH_MISMATCH
[[ "$(sha256sum "$0" | cut -d' ' -f1)" == "$3" ]] || fail INSTALLER_HASH_MISMATCH
/usr/bin/python3 -m py_compile "$source_file" || fail HANDLER_SYNTAX
root=/srv/www/fin-horizon
releases="$root/releases"
[[ -d "$root" && ! -L "$root" && -d "$releases" && ! -L "$releases" ]] || fail STATIC_ROOT_UNKNOWN
for dir in "$root" "$releases"; do
  [[ "$(stat -c %u "$dir")" == 0 ]] || fail STATIC_ROOT_NOT_ROOT_OWNED
  (( (8#$(stat -c %a "$dir") & 8#22) == 0 )) || fail STATIC_ROOT_WRITABLE
done
[[ -L "$root/current" ]] || fail CURRENT_NOT_SYMLINK
current="$(readlink -f "$root/current")"
[[ -d "$current" && "$(dirname "$current")" == "$releases" ]] || fail CURRENT_TARGET_UNKNOWN
[[ -f "$current/index.html" && -f "$current/sw.js" ]] || fail CURRENT_STATIC_INVALID
systemctl is-active --quiet caddy.service || fail CADDY_NOT_RUNNING
systemctl is-active --quiet fh-email-auth.service || fail AUTH_NOT_RUNNING
command -v visudo >/dev/null || fail VISUDO_REQUIRED
command -v sudo >/dev/null || fail SUDO_REQUIRED
read -r public_key || fail PUBLIC_KEY_REQUIRED
[[ "$public_key" =~ ^ssh-ed25519[[:space:]][A-Za-z0-9+/=]+([[:space:]][A-Za-z0-9_.@+-]+)?$ ]] || fail PUBLIC_KEY_INVALID
ssh-keygen -lf <(printf '%s\n' "$public_key") >/dev/null || fail PUBLIC_KEY_INVALID
user=fh-deploy
home=/var/lib/fh-static-deploy
handler=/usr/local/sbin/fh-main-deploy
[[ ! -e "$handler" && ! -L "$handler" ]] || fail HANDLER_ALREADY_INSTALLED
[[ ! -e /etc/sudoers.d/fh-static-deploy ]] || fail SUDOERS_ALREADY_EXISTS
if id "$user" >/dev/null 2>&1; then fail DEPLOY_USER_ALREADY_EXISTS; fi
if [[ -e "$home" || -L "$home" ]]; then fail STATE_DIRECTORY_ALREADY_EXISTS; fi
ssh_home=/var/lib/fh-deploy-ssh
[[ ! -e "$ssh_home" && ! -L "$ssh_home" ]] || fail SSH_HOME_ALREADY_EXISTS
useradd --system --home-dir "$ssh_home" --create-home --shell /bin/sh "$user"
install -d -m 0700 -o root -g root "$home"
install -m 0750 -o root -g root "$source_file" "$handler"
[[ "$(sha256sum "$handler" | cut -d' ' -f1)" == "$2" ]] || fail INSTALLED_HASH_MISMATCH
install -d -m 0700 -o "$user" -g "$user" "$ssh_home/.ssh"
printf '%s%s\n' 'restrict,command="sudo -n /usr/local/sbin/fh-main-deploy" ' "$public_key" > "$ssh_home/.ssh/authorized_keys"
chown "$user:$user" "$ssh_home/.ssh/authorized_keys"
chmod 0600 "$ssh_home/.ssh/authorized_keys"
cat >/etc/sudoers.d/fh-static-deploy <<'SUDOERS'
Defaults:fh-deploy env_keep += "SSH_ORIGINAL_COMMAND"
fh-deploy ALL=(root) NOPASSWD: /usr/local/sbin/fh-main-deploy
SUDOERS
chmod 0440 /etc/sudoers.d/fh-static-deploy
visudo -cf /etc/sudoers.d/fh-static-deploy >/dev/null || fail SUDOERS_INVALID
if runuser -u "$user" -- env SSH_ORIGINAL_COMMAND='not-an-approved-command' sudo -n "$handler" >/dev/null 2>&1; then
  fail RESTRICTION_BYPASS
fi
[[ "$(stat -c %a "$home")" == 700 && "$(stat -c %u "$home")" == 0 ]] || fail STATE_PERMISSIONS
printf 'FH_PROVISION_STATUS=PASS\nHANDLER_SHA256=%s\nDEPLOY_USER=%s\nLIVE_DATA_UNCHANGED=YES\n' "$2" "$user"
