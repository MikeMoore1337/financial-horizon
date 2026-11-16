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
# Cloudflare Origin CA root (public certificate, pinned; never added to global trust).
origin_ca_source="$source_dir/certs/cloudflare-origin-rsa-root.pem"
origin_ca_dir=/usr/local/lib/financial-horizon/certs
origin_ca_target="$origin_ca_dir/cloudflare-origin-rsa-root.pem"
origin_ca_sha=91a8a5567efa6bf941162aa806b3ba476aaddf7867640e53053b35fb225a5dae
[[ -f "$origin_ca_source" && ! -L "$origin_ca_source" ]] || fail ORIGIN_CA_SOURCE_MISSING
[[ "$(sha256sum "$origin_ca_source" | cut -d' ' -f1)" == "$origin_ca_sha" ]] || fail ORIGIN_CA_SOURCE_HASH
[[ ! -e "$origin_ca_target" && ! -L "$origin_ca_target" ]] || fail ORIGIN_CA_ALREADY_INSTALLED
for ca_directory in /usr/local/lib/financial-horizon "$origin_ca_dir"; do
  [[ ! -L "$ca_directory" ]] || fail ORIGIN_CA_DIR_SYMLINK
  if [[ -e "$ca_directory" ]]; then
    [[ -d "$ca_directory" && "$(stat -c %u "$ca_directory")" == 0 ]] || fail ORIGIN_CA_DIR_UNSAFE
    (( (8#$(stat -c %a "$ca_directory") & 8#22) == 0 )) || fail ORIGIN_CA_DIR_UNSAFE
  fi
done
/usr/bin/openssl x509 -in "$origin_ca_source" -noout >/dev/null || fail ORIGIN_CA_PEM_INVALID
origin_status="$(/usr/bin/curl --noproxy '*' --silent --show-error --fail \
    --connect-timeout 5 --max-time 15 --max-redirs 0 \
    --cacert "$origin_ca_source" \
    --resolve fin-horizon.mikemoore.top:8444:127.0.0.1 \
    --output /dev/null --write-out '%{http_code}' \
    https://fin-horizon.mikemoore.top:8444/index.html)" || fail ORIGIN_TLS_NOT_TRUSTED
[[ "$origin_status" == 200 ]] || fail ORIGIN_HTTP_NOT_200
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
install -d -m 0755 -o root -g root "$origin_ca_dir"
[[ "$(stat -c %u "$origin_ca_dir")" == 0 ]] || fail ORIGIN_CA_DIR_OWNER
install -m 0644 -o root -g root "$origin_ca_source" "$origin_ca_target"
[[ "$(sha256sum "$origin_ca_target" | cut -d' ' -f1)" == "$origin_ca_sha" ]] || fail ORIGIN_CA_INSTALL_HASH
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
printf 'FH_PROVISION_STATUS=PASS\nHANDLER_SHA256=%s\nDEPLOY_USER=%s\nORIGIN_CA_SHA256=%s\nORIGIN_TLS_PREFLIGHT=PASS\nLIVE_DATA_UNCHANGED=YES\n' "$2" "$user" "$origin_ca_sha"
