# #35 — выпуск бюджетов на production

**Статус: инструкция для владельца, не квитанция о выполнении.**
Production VPS не подключается к Desktop Commander. Все действия на ней
выполняются владельцем через обычный SSH. GitHub CI использует только
синтетические данные. Не отправлять в чат секреты, файлы БД, cookies,
персональные UUID, расшифрованные backup или финансовые записи.

## Контракт

- PR #99: независимый review, принятый UI v1.1, точный HEAD CI,
  security-vault и двухустройственная регрессия должны быть подтверждены
  до merge. Не закрывать #35 автоматически.
- Первый merge содержит выключенный статический флаг бюджетов и
  выключенный по умолчанию серверный budget runtime.
- Выпуск только с текущего main SHA после push CI, security-vault и
  проверки статического CD. Владелец получает именно этот SHA, не SHA
  исходной ветки PR.
- Использовать действующий персональный backend, только уже разрешённого
  владельца #68. Legacy import #69 должен остаться OFF; #38, #68,
  регистрация и OAuth не переключаются ради бюджетов. Новых маршрутов
  Caddy или прав доступа не требуется.

## A. Безопасная диагностика до выпуска

Команды ниже только читают метаданные. Их можно выполнять до merge.

~~~bash
sudo bash <<'FH35_READONLY'
set -Eeuo pipefail
cd /opt/financial-horizon-ops
printf 'OPS_SHA='; git rev-parse HEAD
if test -z "$(git status --porcelain)"; then echo OPS_CLEAN=YES; else echo OPS_CLEAN=NO; fi
for u in fh-email-auth.service fh-finance-personal.service fh-finance-personal-backup.timer caddy.service; do
  printf '%s=' "$u"; systemctl is-active "$u" || true
done
printf 'DB_HEALTH='; docker inspect -f '{{.State.Health.Status}}' fh-finance-postgres
printf 'DB_BIND='; docker port fh-finance-postgres 5432/tcp
printf 'DB_REVISION='; docker exec -u postgres fh-finance-postgres psql -X -U postgres -d fh_finance -Atqc 'SELECT version_num FROM finance.alembic_version'
printf 'RLS_TABLES='; docker exec -u postgres fh-finance-postgres psql -X -U postgres -d fh_finance -Atqc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='finance' AND c.relkind='r' AND c.relname<>'alembic_version' AND c.relrowsecurity AND c.relforcerowsecurity"
python3 - <<'PY'
import re
import subprocess
from pathlib import Path
p = subprocess.check_output(["systemctl", "show", "-p", "MainPID", "--value", "fh-email-auth.service"], text=True).strip()
if not p.isdecimal() or int(p) <= 1:
    raise SystemExit("FH35_AUTH_PROCESS_UNAVAILABLE")
env = dict(v.split(b"=", 1) for v in Path("/proc", p, "environ").read_bytes().split(b"\0") if b"=" in v)
for key, allowed in {
    "FH_FINANCE_RUNTIME_MODE": (b"off", b"personal"),
    "FH_FINANCE_V2_RUNTIME": (b"off", b"on"),
    "FH_FINANCE_IMPORT_RUNTIME": (b"off", b"on"),
    "FH_FINANCE_BANK_IMPORT_RUNTIME": (b"off", b"on"),
    "FH_FINANCE_SYNC_CREDENTIAL": (b"off", b"on"),
    "FH_FINANCE_BUDGET_RUNTIME": (b"off", b"on"),
}.items():
    value = env.get(key.encode(), b"off")
    print(key + "=" + (value.decode() if value in allowed else "UNEXPECTED"))
wd = subprocess.check_output(["systemctl", "show", "-p", "WorkingDirectory", "--value", "fh-email-auth.service"], text=True).strip()
sha = Path(wd).parent.name
print("BACKEND_SHA=" + (sha if re.fullmatch(r"[0-9a-f]{40}", sha) else "UNEXPECTED"))
PY
FH35_READONLY
~~~

Ожидаемая база для первой миграции: 0007_bank_statements, 18 FORCE RLS
таблиц, active services, healthy DB, loopback 127.0.0.1:54329,
personal/v2 ON, import OFF, budget OFF. #68 должен уже быть разрешён для
владельца; если он OFF, остановиться и разбирать фактическое состояние,
не включать его в рамках #35.

## B. После merge и проверки точного main SHA — подготовка backend

Не выполнять B–D до подтверждения всех предыдущих gates. Вписать только
сообщённый проверенный main SHA. Работать из root-сессии. Не выполнять
действия параллельно с другим оператором.

~~~bash
bash <<'FH35_STAGE'
set -Eeuo pipefail
umask 077
cd /opt/financial-horizon-ops
test "$(id -u)" -eq 0
test "$(git branch --show-current)" = main
test -z "$(git status --porcelain)"
sha=REPLACE_WITH_VERIFIED_MAIN_SHA
[[ "$sha" =~ ^[0-9a-f]{40}$ ]]
git -c credential.helper= fetch origin main
test "$(git rev-parse origin/main)" = "$sha"
git merge --ff-only "$sha"
test "$(git rev-parse HEAD)" = "$sha"
python3 scripts/fh_finance_active_backend_upgrade.py --sha "$sha" --preflight
PYTHONPATH=scripts python3 - <<'PY'
import fh_finance_sync_routes_68 as sync
sync.owner_ready()
sync.local_guards()
for path in (sync.READ, *sync.WRITES):
    method = "GET" if path == sync.READ else "POST"
    kwargs = {} if method == "GET" else {"origin": sync.finance.ORIGIN}
    if sync.finance.public_probe(path, method=method, **kwargs) != 401:
        sync.deny("FH35_EXISTING_SYNC_ROUTE_UNAVAILABLE")
print("FH35_EXISTING_OWNER_AND_SYNC=PASS")
PY
python3 scripts/fh_finance_active_backend_upgrade.py --sha "$sha" --stage
echo FH35_STAGE=PASS
FH35_STAGE
~~~

## C. Миграция с проверкой восстановления до и после

Это плановое окно недоступности авторизации. До запуска убедиться,
что оператор получил FH35_STAGE=PASS и выбранный main SHA не изменился.
Используются существующие защищённые backup/restore и additive migration.
Любой отказ — остановиться, сообщить код, не повторять миграцию вслепую.

~~~bash
bash <<'FH35_MIGRATE'
set -Eeuo pipefail
umask 077
cd /opt/financial-horizon-ops
test "$(id -u)" -eq 0
test "$(git branch --show-current)" = main
test -z "$(git status --porcelain)"
sha=REPLACE_WITH_VERIFIED_MAIN_SHA
[[ "$sha" =~ ^[0-9a-f]{40}$ ]]
test "$(git rev-parse HEAD)" = "$sha"
python3 scripts/fh_finance_active_backend_upgrade.py --sha "$sha" --preflight
for u in fh-email-auth.service fh-finance-personal.service fh-finance-personal-backup.timer caddy.service; do
  test "$(systemctl is-active "$u")" = active
done
test "$(docker inspect -f '{{.State.Health.Status}}' fh-finance-postgres)" = healthy
test "$(docker port fh-finance-postgres 5432/tcp)" = 127.0.0.1:54329
sql() { docker exec -u postgres fh-finance-postgres psql -X -U postgres -d fh_finance -Atqc "$1"; }
test "$(sql 'SELECT version_num FROM finance.alembic_version')" = 0007_bank_statements
for key in start.env backup.env; do
  f="/etc/financial-horizon/finance/$key"
  test -f "$f" && test ! -L "$f"
  test "$(stat -c '%u:%a' "$f")" = 0:600
done
set -a
source /etc/financial-horizon/finance/start.env
source /etc/financial-horizon/finance/backup.env
set +a
test "$FH_FINANCE_PERSONAL_MODE" = YES
test "$FH_FINANCE_CHECKOUT_DIR" = /opt/financial-horizon-ops
test "$FH_FINANCE_DATA_DIR" = /srv/financial-horizon-finance/pgdata
test "$FH_FINANCE_GPG_HOME" = /etc/financial-horizon/finance/gnupg
test "$FH_FINANCE_BACKUP_DIR" = /var/backups/financial-horizon-finance
git merge-base --is-ancestor "$FH_FINANCE_APPROVED_SHA" "$sha"
PYTHONPATH=scripts python3 - "$sha" <<'PY'
import sys
import fh_finance_auth_source_rollout as source
import fh_finance_ops_repin as pin
import fh_finance_sync_routes_68 as sync
source.release_ready(sys.argv[1])
pin.verify_exact_ci(sys.argv[1])
sync.owner_ready()
if sync.live_environment().get(b"FH_FINANCE_BUDGET_RUNTIME", b"off") != b"off":
    sync.deny("FH35_BUDGET_ALREADY_ENABLED")
print("FH35_PRE_MIGRATION_GATES=PASS")
PY
recover_auth() {
  if ! systemctl is-active --quiet fh-email-auth.service; then
    systemctl start fh-email-auth.service || echo FH35_AUTH_RECOVERY=MANUAL_REVIEW_REQUIRED
  fi
}
trap recover_auth EXIT
systemctl stop fh-email-auth.service
before="$(bash deploy/postgres/scripts/backup.sh)"
test -s "$before"
bash deploy/postgres/scripts/restore-drill.sh "$before"
echo FH35_PRE_MIGRATION_RESTORE=PASS
docker compose -f deploy/postgres/compose.yml -f deploy/postgres/personal-loopback.override.yml --profile ops run --no-deps --build --rm migrator
test "$(sql 'SELECT version_num FROM finance.alembic_version')" = 0008_budget_rules
test "$(sql "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='finance' AND c.relkind='r' AND c.relname<>'alembic_version' AND c.relrowsecurity AND c.relforcerowsecurity")" = 21
for t in budget_categories budget_rules budget_assignments; do
  test "$(sql "SELECT has_table_privilege('fh_finance_runtime','finance.$t','SELECT') AND has_table_privilege('fh_finance_runtime','finance.$t','INSERT') AND NOT has_table_privilege('fh_finance_runtime','finance.$t','DELETE') AND NOT has_column_privilege('fh_finance_runtime','finance.$t','profile_id','UPDATE') AND NOT has_column_privilege('fh_finance_runtime','finance.$t','id','UPDATE')")" = t
done
echo FH35_SCHEMA_0008_RLS=PASS
after="$(bash deploy/postgres/scripts/backup.sh)"
test -s "$after"
bash deploy/postgres/scripts/restore-drill.sh "$after"
echo FH35_POST_MIGRATION_RESTORE=PASS
# Same atomic-only repin after a verified schema upgrade as in #38.
PYTHONPATH=scripts python3 - "$sha" <<'PY'
import sys
import fh_finance_ops_repin as pin
sha = sys.argv[1]
pin.verify_exact_ci(sha)
assert pin.command("git", "-C", pin.CHECKOUT, "rev-parse", "HEAD") == sha
assert not pin.command("git", "-C", pin.CHECKOUT, "status", "--porcelain")
raw = pin.private_text(pin.START)
old = pin.parse_start(raw)["FH_FINANCE_APPROVED_SHA"]
pin.command("git", "-C", pin.CHECKOUT, "merge-base", "--is-ancestor", old, sha)
assert pin.command("docker", "exec", "-u", "postgres", "fh-finance-postgres",
                   "psql", "-X", "-U", "postgres", "-d", "fh_finance", "-Atqc",
                   "SELECT version_num FROM finance.alembic_version") == "0008_budget_rules"
pin.atomically_repin(sha, raw, old)
print("FH35_MIGRATED_SOURCE_PIN=PASS")
PY
systemctl start fh-email-auth.service
test "$(systemctl is-active fh-email-auth.service)" = active
trap - EXIT
python3 scripts/fh_finance_active_backend_upgrade.py --sha "$sha" --publish
echo FH35_BACKEND_SOURCE=PASS
FH35_MIGRATE
~~~

Не выполнять downgrade, stamp, down -v или восстановление старого backup
поверх рабочей базы. Оставить аддитивную схему и проверенные копии.

## D. Включить только owner-scoped budget runtime

Только после двух квитанций restore, source pin и FH35_BACKEND_SOURCE=PASS.
Отдельный файл systemd, без изменений Caddy и остальных rollout flags.
При отказе до записи бюджета допустим source rollback существующим
оператором на предыдущую совместимую версию.

~~~bash
cd /opt/financial-horizon-ops
sudo env PYTHONPATH=scripts python3 - REPLACE_WITH_VERIFIED_MAIN_SHA <<'PY'
import os
import sys
from pathlib import Path
import fh_finance_active_backend_upgrade as backend
import fh_finance_sync_routes_68 as sync
import fh_finance_private_api_release as finance
sha = sys.argv[1]
flag = Path("/etc/systemd/system/fh-email-auth.service.d/97-budget35.conf")
data = b"[Service]\nEnvironment=FH_FINANCE_BUDGET_RUNTIME=on\n"
backend.check_checkout(sha)
assert backend.live_state() == backend.release(sha)
sync.owner_ready()
sync.local_guards()
sync.check_owner_directories()
keys = (b"FH_FINANCE_RUNTIME_MODE", b"FH_FINANCE_V2_RUNTIME",
        b"FH_FINANCE_IMPORT_RUNTIME", b"FH_FINANCE_BANK_IMPORT_RUNTIME",
        b"FH_FINANCE_SYNC_CREDENTIAL")
env = sync.live_environment()
before = {k: env.get(k, b"off") for k in keys}
assert before[keys[0]] == b"personal" and before[keys[1]] == b"on"
assert before[keys[2]] == b"off" and before[keys[4]] == b"on"
assert env.get(b"FH_FINANCE_BUDGET_RUNTIME", b"off") == b"off"
assert not flag.exists() and not flag.is_symlink()
def guards():
    for probe in (finance.local_probe, finance.public_probe):
        assert probe("/api/finance/v1/state") == 401
        assert probe(sync.READ) == 401
        for path in ("/api/finance/v2/commands", *sync.WRITES):
            assert probe(path, method="POST", origin=finance.ORIGIN) == 401
            assert probe(path, method="POST", origin="https://untrusted.example") == 403
guards()
finance.write_exclusive(flag, data, mode=0o644)
try:
    sync.restart_auth()
    sync.owner_ready()
    assert backend.live_state() == backend.release(sha)
    env = sync.live_environment()
    assert env.get(b"FH_FINANCE_BUDGET_RUNTIME") == b"on"
    assert {k: env.get(k, b"off") for k in keys} == before
    guards()
except Exception:
    if finance.secure_file(flag, 0, 0o644) == data:
        flag.unlink()
        sync.restart_auth()
        print("FH35_FLAG_ROLLBACK=PASS")
    raise
print("FH35_OWNER_BUDGET_RUNTIME=ON")
print("FH35_EXISTING_RUNTIME_PRESERVED=PASS")
print("FH35_ANONYMOUS_AND_ORIGIN_GUARDS=PASS")
print("FH35_NO_FINANCIAL_COMMAND_EXECUTED=YES")
PY
~~~

Не использовать Python -O: проверки assert являются обязательными.

## E. Статический выпуск, приёмка и rollback

Отдельный маленький PR меняет только fh-finance-budgets с disabled на
enabled, после подтверждённого backend gate. Точный push SHA должен
пройти CI и штатный static CD; проверить публичный /__release.json и
связанные хэши. До первого budget write обновить старые вкладки/PWA
на совместимый с новыми entity kinds bundle.

В браузере владельца проверить сессии, доступ к бюджетам, отсутствие
ложной записи в offline, подтверждение после reconnect, второй браузер,
guest isolation, старые и новые backup, переключение месяцев, темы,
доступ к кредитам на мобильном, 1500/10000 => 8500 и архив/переклассификацию
на разрешённых синтетических данных. Не менять реальные финансовые
операции без явного согласия; не публиковать скриншоты личных сумм.
Физический iOS отдельно от WebKit.

Rollback после первой бюджетной записи: выключить 97-budget35.conf
(проверить точное содержимое, удалить только этот файл, daemon-reload,
restart auth, проверить budget OFF и остальные flags без изменений),
выпустить совместимый статический SHA с выключенным бюджетным флагом.
Не возвращать до-бюджетный snapshot decoder или до-бюджетный backend,
который не сохраняет новые entity kinds, после появления бюджетных
сущностей. Схему/историю, защищённые локальные очереди и backup сохранить.
Если состояние отличается от ожидаемого — ручное расследование.

Закрытие #35 только после независимого review, exact-SHA CI,
подтверждённых серверного и статического SHA, smoke/backup/rollback
квитанций и фактической приёмки владельца. Отсутствие VPS-коннектора
само по себе не является причиной держать разработку открытой.
