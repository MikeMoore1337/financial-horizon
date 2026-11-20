# #38 - выпуск банковского CSV/XLSX импорта на действующей Hermes VPS

Статус: **инструкция, не свидетельство production-выпуска**. Пользователь уже
подтвердил 20.11.2026 копию и отдельное восстановление текущей `0006_reserve_events`
(`RESTORE_DRILL_PASS: 16 finance tables`) при чистом checkout
`2279a91652d66b9b4464a9375d6871c1af7f7d41`. Эти подтверждения не означают,
что схема `0007_bank_statements` уже применена.

Все команды - **только на настоящей доверенной VPS** от root. Не использовать
Hermes Docker sandbox, Codex CLI, публичный SQL или внешний сервис. Никаких
секретов, файлов выписок, пользовательских дампов и cookies в PR/чат.

## Контракт двухэтапного выпуска

1. **Основной PR #86** содержит UI, гостевой IndexedDB и неактивные серверные
   маршруты. `index.html` содержит
   `<meta name="fh-finance-bank-import" content="disabled">`: вошедшие
   пользователи не видят новый серверный UI до готовности VPS. Старый
   `fh-finance-import=enabled` для #69 не включает #38.
2. После точного main push CI выполняется **аддитивная** миграция 0006 -> 0007
   (две новые RLS таблицы) с резервными копиями **до и после** и отдельными
   успешными восстановлениями; никаких downgrade или восстановления старой
   копии поверх живой БД.
3. Обновляется защищённый исходный backend. Отдельный оператор
   `scripts/fh_bank38_release.py` включает строго четыре пути банка
   (GET rows,batches; POST commit,undo), отдельный systemd 95-drop-in и
   точный Caddy allowlist со strong ETag. Legacy #69 остаётся OFF.
4. **Отдельный статический PR** переключает лишь
   `fh-finance-bank-import=enabled`. После автоматического production static
   workflow проверяются точный публичный SHA, авторизация, гостевой режим,
   synthetic bank CSV/XLSX, повтор, откат и защищённый журнал.

## Предусловия

- PR #86 принят в `main`, проверки **на merge SHA**:
  `app-tests`, `finance-postgres`, `email-auth-tests`,
  `e2e-real-browser` = PASS и security-vault = PASS.
- На VPS нет других операторов, не выполняется импорт, `#69` OFF.
- Auth, PostgreSQL, backup.timer, Caddy = active, PostgreSQL healthy.
- Уже существующая зашифрованная копия 0006 восстановлена отдельно.
- Вся работа строго под текущим main SHA и в чистом `/opt/financial-horizon-ops`.

## Этап A - обновить только checkout и подготовить backend без переключения

```bash
bash <<'FH38_PREP'
set -Eeuo pipefail
umask 077
cd /opt/financial-horizon-ops
test "$(id -u)" -eq 0
test "$(git branch --show-current)" = main
test -z "$(git status --porcelain)"
git -c credential.helper= fetch origin main
git merge --ff-only origin/main
sha="$(git rev-parse HEAD)"
test -n "$sha" && test "$(git status --porcelain)" = ""
test "$(docker exec -u postgres fh-finance-postgres psql -X -U postgres -d fh_finance -Atqc   'SELECT version_num FROM finance.alembic_version')" = 0006_reserve_events
test "$(awk -F= '$1=="FH_FINANCE_IMPORT_RUNTIME"{print $2}'   /etc/financial-horizon/finance/runtime.env)" = off
python3 scripts/fh_finance_active_backend_upgrade.py --sha "$sha" --preflight
python3 scripts/fh_finance_active_backend_upgrade.py --sha "$sha" --stage
echo FH38_BACKEND_STAGED_BEFORE_MIGRATION=PASS
FH38_PREP
```

При ошибке preflight/stage не перезапускать службы и не продолжать.

## Этап B - миграция на production с восстановлением обеих копий

Это **плановое окно недоступности авторизации**; финансовые операции не
выполнять. Выводить только контрольные строки, не суммы/ID или секреты.

```bash
bash <<'FH38_MIGRATE'
set -Eeuo pipefail
umask 077
cd /opt/financial-horizon-ops
test "$(id -u)" -eq 0
test -z "$(git status --porcelain)"
sha="$(git rev-parse HEAD)"
test "$(git branch --show-current)" = main
test "$(systemctl is-active fh-email-auth.service)" = active
test "$(systemctl is-active fh-finance-personal.service)" = active
test "$(systemctl is-active fh-finance-personal-backup.timer)" = active
test "$(systemctl is-active caddy.service)" = active
test "$(docker inspect -f '{{.State.Health.Status}}' fh-finance-postgres)" = healthy
test "$(docker port fh-finance-postgres 5432/tcp)" = 127.0.0.1:54329

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
test "$FH_FINANCE_APPROVED_SHA" != "$sha" || {
  echo "FH38_HOLD=SOURCE_PIN_ALREADY_CHANGED"; exit 1;
}
old="$(docker exec -u postgres fh-finance-postgres   psql -X -U postgres -d fh_finance -Atqc   'SELECT version_num FROM finance.alembic_version')"
test "$old" = 0006_reserve_events

systemctl stop fh-email-auth.service
recover_auth() {
  if ! systemctl is-active --quiet fh-email-auth.service; then
    systemctl start fh-email-auth.service || true
  fi
}
trap recover_auth EXIT

before="$(bash deploy/postgres/scripts/backup.sh)"
test -s "$before"
bash deploy/postgres/scripts/restore-drill.sh "$before"
echo FH38_BEFORE_MIGRATION_BACKUP_RESTORE=PASS

docker compose -f deploy/postgres/compose.yml   -f deploy/postgres/personal-loopback.override.yml   --profile ops run --no-deps --build --rm migrator

version="$(docker exec -u postgres fh-finance-postgres   psql -X -U postgres -d fh_finance -Atqc   'SELECT version_num FROM finance.alembic_version')"
test "$version" = 0007_bank_statements

counts="$(docker exec -u postgres fh-finance-postgres   psql -X -U postgres -d fh_finance -Atqc "
  SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='finance' AND c.relkind='r'
    AND c.relname<>'alembic_version'
    AND c.relrowsecurity AND c.relforcerowsecurity
  ")"
test "$counts" = 18
test "$(docker exec -u postgres fh-finance-postgres   psql -X -U postgres -d fh_finance -Atqc "
  SELECT has_table_privilege('fh_finance_runtime','finance.bank_import_rows','SELECT')
    AND NOT has_table_privilege('fh_finance_runtime','finance.bank_import_rows','DELETE')
  ")" = t
echo FH38_SCHEMA_0007_RLS=PASS

after="$(bash deploy/postgres/scripts/backup.sh)"
test -s "$after"
bash deploy/postgres/scripts/restore-drill.sh "$after"
echo FH38_AFTER_MIGRATION_BACKUP_RESTORE=PASS

# The generic ops repin deliberately refuses changed PostgreSQL code.
# Exact 0007/18 and both restore drills above justify the guarded
# atomic-only pin routine, also used by the reviewed #6 migration.
python3 - "$sha" <<'PY'
import os
import subprocess
import sys
from pathlib import Path
sys.path.insert(0, str(Path.cwd() / "scripts"))
import fh_finance_ops_repin as pin

new = sys.argv[1]
assert os.geteuid() == 0
assert pin.command("git", "-C", pin.CHECKOUT, "rev-parse", "HEAD") == new
assert not pin.command("git", "-C", pin.CHECKOUT, "status", "--porcelain")
pin.verify_exact_ci(new)
raw = pin.private_text(pin.START)
old_sha = pin.parse_start(raw)["FH_FINANCE_APPROVED_SHA"]
assert subprocess.run(
    ["git", "-C", pin.CHECKOUT, "merge-base", "--is-ancestor", old_sha, new],
    check=False, capture_output=True, timeout=15,
).returncode == 0
assert pin.command(
    "docker", "exec", "-u", "postgres", "fh-finance-postgres",
    "psql", "-X", "-U", "postgres", "-d", "fh_finance", "-Atqc",
    "SELECT version_num FROM finance.alembic_version",
) == "0007_bank_statements"
pin.atomically_repin(new, raw, old_sha)
print("FH38_MIGRATED_SOURCE_PIN=PASS")
PY

systemctl start fh-email-auth.service
test "$(systemctl is-active fh-email-auth.service)" = active
trap - EXIT
echo FH38_MIGRATION_PREPARED_FOR_BACKEND=PASS
FH38_MIGRATE
```

Если миграция отказала: **не** повторять её вслепую, не выполнять
`alembic stamp`, `downgrade`, `docker compose down -v` и не
восстанавливать старую БД. Проверить текущее Alembic-состояние и только
затем выбрать продолжение. Trap перезапускает прежний auth без изменения
PostgreSQL.

## Этап C - source-only backend, затем отдельный bank API

```bash
cd /opt/financial-horizon-ops
sha="$(git rev-parse HEAD)"
python3 scripts/fh_finance_active_backend_upgrade.py --sha "$sha" --publish
python3 scripts/fh_bank38_release.py --sha "$sha" --preflight
FH_BANK38_RELEASE=ENABLE python3 scripts/fh_bank38_release.py --sha "$sha" --enable
```

Требуется `FH_ACTIVE_BACKEND_PUBLISHED=PASS`,
`FH38_BANK_API_PREFLIGHT=PASS`, `FH38_SCHEMA_0007_AND_RLS=PASS`,
`FH38_BANK_API_PUBLIC_GUARDS=PASS`,
`FH38_BANK_API_BACKEND=ENABLED`.

Оператор не проводит ни одной финансовой операции. Отдельный 95-drop-in
включает `FH_FINANCE_BANK_IMPORT_RUNTIME=on`, не изменяя защищённый
`runtime.env` #69. Caddy маршрутизирует только четыре перечисленных
пути, проверяя anonymous 401 и wrong-Origin 403, сохраняя strong ETag.
Оригинал Caddy лежит в root-only каталоге backup.

## Этап D - финальное включение пользовательского интерфейса

После подтверждённого backend/PG/Caddy gate выпустить отдельный маленький
PR на `main`, который меняет **только** мета-флаг
`fh-finance-bank-import` с `disabled` на `enabled`. Дождаться
точных push `tests` + `security-vault` + штатного статического production
workflow, сверить `/__release.json` и SHA PWA/Service Worker.

С синтетическими данными на настоящем сайте отдельно проверить:
гостевой CSV/XLSX и зашифрованный backup/restore, вошедшего владельца,
настройку колонок, 0 дублей при повторе, частичное пересечение выписки,
суммы счёта после income/expense/transfer, whole batch undo, второй
браузер, logout/CSRF/IDOR. Не отправлять банковские файлы на сервер.

Только после успешной реальной приёмки закрыть #38. CI и
анонимные 401/403 сами по себе **не доказывают** запись/undo реального API.

## Экстренное выключение банковского API

Из исходного checkout того SHA, на котором ранее запускали `--enable`
(не требуется актуальный main для закрытия публичных путей):

```bash
FH_BANK38_RELEASE=DISABLE python3 scripts/fh_bank38_release.py \
  --sha "ША_ВКЛЮЧЕНИЯ_BANK38" --disable
```

Оператор сначала удаляет публичные разрешения Caddy, потом точный
systemd 95-drop-in и перезапускает только auth backend. Содержимое
PostgreSQL и текущие пользовательские проводки не откатываются.
Если к конфигурации успел обратиться другой оператор, отказ
`NO_GO` требует ручной проверки, а не принудительной перезаписи.
