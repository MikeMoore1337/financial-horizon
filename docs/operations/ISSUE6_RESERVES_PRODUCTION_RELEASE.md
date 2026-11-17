# Issue #6: выпуск накоплений на production VPS

**Статус:** готовая инструкция, НЕ свидетельство выполненного production-релиза.
Выполнять только на исходной доверенной Hermes VPS под root через обычный SSH,
НЕ через изолированную среду Hermes Agent. Не публиковать секреты, базы или дампы.

Требуется: действующая FH auth + PostgreSQL 17 (localhost:54329), личный
режим, активный backup.timer, точно зелёный CI на текущем main. Если
FH_FINANCE_IMPORT_RUNTIME=on, штатное окно #69 нужно **предварительно
завершить его собственным защищённым --disable**, используя SHA того
включения. Не править root-only env и Caddy вручную, не останавливать
задействованный импорт посреди операции. Существующий backend upgrade
проверяет именно import=off и правильно останавливается при import=on.

## 0. Закрыть прежнее окно импорта, прежде чем менять checkout

На проверенной owner-VPS 17.11.2026 получено:
GIT_TREE=CLEAN, IMPORT_RUNTIME=on, ALEMBIC=0003_import_source,
RLS_TABLES=15, auth/finance/backup.timer/Caddy=active.
Текущий checkout: ad5675ace0f7ab926a58fe3715f59a9505004255.

Файл scripts/fh_finance_personal_import_window.py на этом SHA совпадает
по blob SHA с действующим main. Из сохранённой истории #69 установлено:
импортное окно включали именно на SHA ad5675ace0f7ab926a58fe3715f59a9505004255.
В режиме DISABLE его оператор не требует актуального GitHub main, но
строго сверяет два исходных root-only backup и побайтово проверяет Caddy/runtime
перед их восстановлением. Нельзя запускать обычный --preflight с этим
старым SHA: он требует актуального main и откажет.

**Если перенос #69 ещё выполняется или его сетевой исход не выяснен,
не выключать endpoint до урегулирования операции.** После завершения
или осознанной приостановки импорта выполнить ниже. Это закрывает
только HTTP-write окно, не удаляет и не восстанавливает пользовательские данные.

~~~bash
sudo -i
set -Eeuo pipefail
umask 077
cd /opt/financial-horizon-ops
test "$(id -u)" -eq 0
test "$(git rev-parse HEAD)" = ad5675ace0f7ab926a58fe3715f59a9505004255
test -z "$(git status --porcelain)"
test "$(awk -F= '$1=="FH_FINANCE_IMPORT_RUNTIME"{print $2}' \
 /etc/financial-horizon/finance/runtime.env)" = on
FH_PERSONAL_IMPORT_WINDOW=DISABLE \
  python3 scripts/fh_finance_personal_import_window.py \
  --sha ad5675ace0f7ab926a58fe3715f59a9505004255 --disable
test "$(awk -F= '$1=="FH_FINANCE_IMPORT_RUNTIME"{print $2}' \
 /etc/financial-horizon/finance/runtime.env)" = off
test "$(systemctl is-active fh-email-auth.service)" = active
echo FH6_IMPORT_WINDOW_CLOSED=PASS
~~~

Требуются отдельные строки:
FH_IMPORT_WINDOW_BACKEND=DISABLED,
FH_IMPORT_PUBLIC_ROUTES=REMOVED,
FH_IMPORT_USER_FINANCIAL_DATA_UNCHANGED_BY_TOGGLE=YES.
Любой NO_GO/FAILED - прекратить работу и сохранить код ошибки.
Если SSH-сессия оборвалась, сначала проверить состояние чтением,
не повторять --disable автоматически.

## 1. Обновить исходники и сделать preflight

~~~bash
sudo -i
set -Eeuo pipefail
umask 077
export SYSTEMD_PAGER=cat
cd /opt/financial-horizon-ops
test "$(id -u)" -eq 0
test -z "$(git status --porcelain)"
git -c credential.helper= fetch origin main
git merge --ff-only origin/main
sha="$(git rev-parse HEAD)"
test "$(git branch --show-current)" = main
python3 scripts/fh_finance_active_backend_upgrade.py --sha "$sha" --preflight
~~~

Не переходить к следующим шагам, если нет **FH_ACTIVE_BACKEND_PREFLIGHT=PASS**.
При включённом импорте #69 сначала завершить импорт, выполнить штатное
закрытие окна и повторить preflight. Не обходить защитную проверку.

## 2. Убедиться, что схема ровно исходной версии

~~~bash
test "$(systemctl is-active fh-email-auth.service)" = active
test "$(systemctl is-active fh-finance-personal.service)" = active
test "$(systemctl is-active fh-finance-personal-backup.timer)" = active
test "$(systemctl is-active caddy.service)" = active
test "$(docker port fh-finance-postgres 5432/tcp)" = '127.0.0.1:54329'
test "$(docker inspect -f '{{.State.Health.Status}}' fh-finance-postgres)" = healthy
old_version="$(docker exec -u postgres fh-finance-postgres \
 psql -X -U postgres -d fh_finance -Atqc \
 'SELECT version_num FROM finance.alembic_version')"
test "$old_version" = 0003_import_source || {
 echo 'FH6_NO_GO=UNEXPECTED_MIGRATION_HEAD'; exit 1;
}
echo FH6_OLD_SCHEMA=PASS
~~~

Если version_num уже 0006_reserve_events или другой, не повторять
миграцию вслепую. Нужна отдельная постпроверка уже выполненной операции.

До остановки auth подготовить новую версию без изменения работающего процесса:

~~~bash
python3 scripts/fh_finance_active_backend_upgrade.py --sha "$sha" --stage
~~~

Должно появиться **FH_ACTIVE_BACKEND_STAGED=PASS**.

## 3. Остановить запись, зашифровать и восстановить копию, применить Alembic

На время миграции авторизация будет недоступна. Не запускать параллельно
с финансовыми операциями, импортом или другими релизами.

~~~bash
cd /opt/financial-horizon-ops
set -Eeuo pipefail
umask 077
test "$(stat -c '%u:%a' /etc/financial-horizon/finance/start.env)" = 0:600
test "$(stat -c '%u:%a' /etc/financial-horizon/finance/backup.env)" = 0:600
test ! -L /etc/financial-horizon/finance/start.env
test ! -L /etc/financial-horizon/finance/backup.env
set -a
source /etc/financial-horizon/finance/start.env
source /etc/financial-horizon/finance/backup.env
set +a
test "$FH_FINANCE_PERSONAL_MODE" = YES
test "$FH_FINANCE_CHECKOUT_DIR" = /opt/financial-horizon-ops
test "$FH_FINANCE_DATA_DIR" = /srv/financial-horizon-finance/pgdata
test "$(git rev-parse HEAD)" = "$sha"

systemctl stop fh-email-auth.service
recover_auth() {
  if ! systemctl is-active --quiet fh-email-auth.service; then
    systemctl start fh-email-auth.service || true
  fi
}
trap recover_auth EXIT

pre_backup="$(bash deploy/postgres/scripts/backup.sh)"
test -s "$pre_backup"
bash deploy/postgres/scripts/restore-drill.sh "$pre_backup"
echo FH6_ENCRYPTED_BEFORE_RESTORE=PASS

docker compose \
 -f deploy/postgres/compose.yml \
 -f deploy/postgres/personal-loopback.override.yml \
 --profile ops run --no-deps --build --rm migrator

version="$(docker exec -u postgres fh-finance-postgres \
 psql -X -U postgres -d fh_finance -Atqc \
 'SELECT version_num FROM finance.alembic_version')"
test "$version" = 0006_reserve_events || {
 echo 'FH6_NO_GO=EXPECTED_ALEMBIC_0006'; exit 1;
}
rls_tables="$(docker exec -u postgres fh-finance-postgres \
 psql -X -U postgres -d fh_finance -Atqc \
 "SELECT count(*) FROM pg_class c
 JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='finance' AND c.relkind='r'
 AND c.relname<>'alembic_version'
 AND c.relrowsecurity AND c.relforcerowsecurity")"
test "$rls_tables" = 16 || {
 echo 'FH6_NO_GO=EXPECTED_16_RLS_TABLES'; exit 1;
}
post_backup="$(bash deploy/postgres/scripts/backup.sh)"
test -s "$post_backup"
bash deploy/postgres/scripts/restore-drill.sh "$post_backup"
echo FH6_MIGRATION_AND_BACKUPS=PASS
~~~

Никакого downgrade, docker compose down -v или восстановления устаревшей
копии поверх текущей БД. Если команда отказала, оставить накопления
выключенными, сохранить зашифрованные копии и выяснить причину.

## 4. Зафиксировать новый системный SHA и заменить backend

Старый fh_finance_ops_repin.py **запрещает** обновление при изменениях DDL.
Только ПОСЛЕ успешных 0006 + RLS + двух backup/restore можно использовать
существующий защищённый атомарный механизм записи SHA с отдельной
миграционной проверкой:

~~~bash
cd /opt/financial-horizon-ops
python3 - "$sha" <<'PY'
import os, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path.cwd() / "scripts"))
import fh_finance_ops_repin as pin

new = sys.argv[1]
assert os.geteuid() == 0
assert pin.command("git", "-C", pin.CHECKOUT, "rev-parse", "HEAD") == new
assert not pin.command("git", "-C", pin.CHECKOUT, "status", "--porcelain")
pin.verify_exact_ci(new)
raw = pin.private_text(pin.START)
old = pin.parse_start(raw)["FH_FINANCE_APPROVED_SHA"]
assert subprocess.run(
  ["git", "-C", pin.CHECKOUT, "merge-base", "--is-ancestor", old, new],
  check=False, capture_output=True, timeout=15,
).returncode == 0
sql = subprocess.run(
  ["docker", "exec", "-u", "postgres", "fh-finance-postgres",
   "psql", "-X", "-U", "postgres", "-d", "fh_finance", "-Atqc",
   "SELECT version_num FROM finance.alembic_version"],
  check=True, capture_output=True, text=True, timeout=15,
).stdout.strip()
assert sql == "0006_reserve_events"
pin.atomically_repin(new, raw, old)
print("FH6_MIGRATED_SOURCE_PIN=PASS")
PY

systemctl start fh-email-auth.service
test "$(systemctl is-active fh-email-auth.service)" = active
trap - EXIT
python3 scripts/fh_finance_active_backend_upgrade.py --sha "$sha" --publish
~~~

Требуется **FH_ACTIVE_BACKEND_PUBLISHED=PASS**. Штатный --publish
проверяет действующие OAuth, 401 на защищённых finance API, Caddy и
защищённые 80/90 drop-in; при ошибке возвращает предыдущие исходники
без отката актуальных пользовательских денег.

## 5. Включить интерфейс и доставить на сайт

После доказанного шага 4 и отдельной приёмки:

1. Объединить подготовленный Draft PR #189 с новой меткой
   fh-finance-reserves=enabled после точного успешного CI.
2. Убедиться в успешных push **tests** и **security-vault** уже
   на новом main SHA.
3. В GitHub Actions вручную запустить **Financial Horizon production static
   deploy**: workflow_dispatch, ветка main, параметр release_sha =
   точный 40-символьный SHA из шага 2. Авто-деплой отключён политикой
   проекта; не обходить этот gate.
4. Проверить настоящую FH-сессию: создание, пополнение, фактическую оплату,
   отсутствие двойного списания, второй браузер, гостевой доступ, logout,
   доступность существующих OAuth и откат статического релиза.
5. Только после фактических production PASS закрыть Issue #6.

Не объявлять production PASS по одному CI или успешному SQL-контейнеру:
живые пользовательские операции и сам релиз требуют отдельной проверки.
