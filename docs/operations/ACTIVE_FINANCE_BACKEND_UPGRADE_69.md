# Financial Horizon #69/#70 - обновление уже включённого финансового backend

**Область:** обновить исходники `fh-email-auth.service`, когда уже действуют
`70-oauth.conf`, `80-finance-source.conf`, `90-finance-runtime.conf`
и закрытый PostgreSQL `fh-finance-personal.service`.

Это **не** процедура первоначального включения `fh_finance_private_api_release.py`
или `fh_finance_auth_source_rollout.py` - они отказываются работать при уже
включённом финансовом runtime. Не снимать `90-finance-runtime.conf`
и не удалять PostgreSQL.

## Подтверждённый исходный профиль VPS

14.11.2026 оператор показал:

- `/opt/financial-horizon-ops` на `bcd6c7851a42bc62099eb5c52c5465c759dabdea`, рабочее дерево чистое.
- `fh-email-auth.service` запускается из выпуска `7a2d2fae1a8c4bca0d8926479489ae3bf4db5f2b`.
- Все службы `fh-email-auth.service`, `fh-finance-personal.service`,
  `fh-finance-personal-backup.timer`, `caddy.service` активны.
- `80-finance-source.conf` и `90-finance-runtime.conf` уже установлены.
- `main` на `261626314f0f5222611c95dbf1b3ee7e5359a2a7` -
  CI app/auth/PostgreSQL/browser и security PASS, импорт и синхронизация выключены.

Эти результаты **не доказывают** фактический импорт/restore владельца или
работоспособность нового backend: до и после выпуска обязателен отдельный smoke.

## Порядок (root SSH на доверенном VPS, без второго параллельного оператора)

После слияния PR, **только когда CI на актуальном main PASS**, выполнить:

```bash
set -Eeuo pipefail
export SYSTEMD_PAGER=cat
cd /opt/financial-horizon-ops
test "$(id -u)" -eq 0
test -z "$(git status --porcelain)"
git -c credential.helper= fetch origin main
git merge --ff-only origin/main
sha="$(git rev-parse HEAD)"

# Согласовать источник PostgreSQL без рестарта PostgreSQL или миграций.
python3 scripts/fh_finance_ops_repin.py --sha "$sha" --preflight
FH_FINANCE_PERSONAL_OPS_REPIN=YES \
  python3 scripts/fh_finance_ops_repin.py --sha "$sha" --apply

# Проверить, что финансы уже активны, импорт выключен, API закрыт и
# в активных 80/90 допустимы только доверенные пути прежнего выпуска.
python3 scripts/fh_finance_active_backend_upgrade.py --sha "$sha" --preflight

# Отдельно собрать и проверить новый backend под uid/gid fh-email-auth.
python3 scripts/fh_finance_active_backend_upgrade.py --sha "$sha" --stage

# Создать root-only копии двух drop-in + непротиворечивую копию auth SQLite,
# атомарно переключить release symlink, обновить оба 80/90,
# перезапустить только fh-email-auth, проверить origin HTTPS и 4 OAuth.
# При ошибке source/80/90 восстанавливаются автоматически без
# возврата устаревшей базы SQLite и без модификации PostgreSQL.
python3 scripts/fh_finance_active_backend_upgrade.py --sha "$sha" --publish
```

Ожидаемые признаки:

```text
FINANCE_OPS_PREFLIGHT=PASS
FINANCE_OPS_SHA_PIN=PASS
FH_ACTIVE_BACKEND_PREFLIGHT=PASS
FH_ACTIVE_BACKEND_STAGED=PASS
FH_SERVICE_NOT_RESTARTED=YES
FH_ACTIVE_BACKEND_PUBLISHED=PASS
FH_FINANCE_V2=ON
FH_IMPORT_AND_BACKGROUND_SYNC=OFF
FH_AUTH_AND_FINANCE_DATA_UNCHANGED=YES
```

Точные коды `NO_GO` и `FAILED` требуют остановки, а не ручного обхода
владельческих/защитных проверок. **Не создавать аккаунты, проводки,
кредиты или импортные batches для production smoke** - без разрешения
владельца здесь используются только анонимные отрицательные запросы.

## Явный откат после выпуска

Если установленная версия `sha` оказалась проблемной, до следующего
релиза разрешён только указанный ниже безопасный откат её **исходников**:

```bash
cd /opt/financial-horizon-ops
sha="$(git rev-parse HEAD)"
python3 scripts/fh_finance_active_backend_upgrade.py --sha "$sha" --rollback
```

Заново устанавливаются исходные **точные** 80/90 drop-in из root-only
backup, возвращается предыдущий `current` и перезапускается только auth.
Финансовые и OAuth базы данных не копируются обратно из старого снимка,
поскольку пользователь мог продолжать совершать операции.
Откат запрещается, если конфигурацию уже изменил другой оператор.

## Ограничения после публикации

Импорт `FH_FINANCE_IMPORT_RUNTIME` остаётся `off`, фронтенд
`fh-finance-import=disabled`. PR #176 закрывает кодовый блокер единственного
нулевого счёта, но не загружает персональную IndexedDB. PR #177 добавляет
read-only кандидат server snapshot, но не включает фоновую синхронизацию.
Реальная проверенная AES-GCM копия, пользовательский перенос, сравнение
исходных данных и restore, две вкладки/устройства, logout, конфликт
и rollback E2E обязательны до закрытия #33/#68/#69/#70.
