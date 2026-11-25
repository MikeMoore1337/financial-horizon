# #66 - защита автозапуска PostgreSQL после обновления backend

**Состояние на 13.11.2026:** владелец подтвердил на настоящей VPS:
`FINANCE_PERSONAL_BACKUP_RESTORE=PASS`, 15 FORCE RLS, реальный
loopback-порт, `fh-finance-personal.service=active`,
`fh-finance-personal-backup.timer=active` и обновлённый OAuth/backend
`FINANCE_BACKEND_CUTOVER=PASS` с четырьмя провайдерами.

При первом bootstrap личная PostgreSQL получила закреплённый SHA в
`/etc/financial-horizon/finance/start.env`. После этого исходники в
`/opt/financial-horizon-ops` несколько раз обновлялись через Git.
Служба `personal-start.sh` проверяет совпадение SHA с checkout.
**Текущая работающая база может быть здоровой, но следующий перезапуск
systemd/перезагрузка VPS откажет в старте при расхождении SHA.**

Это не повод переустанавливать БД или редактировать unit вручную.

## Контролируемое согласование SHA (без остановки БД)

В root SSH на настоящей VPS, только после успешного CI нового merge-коммита:

```bash
bash <<'SH'
set -Eeuo pipefail
cd /opt/financial-horizon-ops
test "$(id -u)" = 0
test -z "$(git status --porcelain)"
git -c credential.helper= fetch origin main
git merge --ff-only origin/main

sha="$(git rev-parse HEAD)"
python3 scripts/fh_finance_ops_repin.py --sha "$sha" --preflight

export FH_FINANCE_PERSONAL_OPS_REPIN=YES
python3 scripts/fh_finance_ops_repin.py --sha "$sha" --apply
python3 scripts/fh_finance_ops_repin.py --sha "$sha" --preflight
SH
```

Скрипт сверяет саму конфигурацию `start.env` (строго четыре известные
строки, root:root 0600), old SHA как предка новой версии и **побайтовое
отсутствие изменений в `deploy/postgres`** между old и new SHA.
Обязательно подтверждаются `main` и 4/4 CI на exact SHA,
здоровая PostgreSQL 17 с loopback-портом, активная
`fh-finance-personal.service`, backup timer, Caddy и auth,
результат последней backup-службы = success.

При применении прежний `start.env` сохраняется как root-only
`/var/backups/financial-horizon-finance/fh-finance-ops-start-<oldSHA>.env.bak`
с правами 0600, новый файл создаётся атомарно и читается обратно.
`systemctl restart`, миграции, `docker compose up/down`,
изменения SQLite, GPG, OAuth, API и финансовых данных **не выполняются**.

Ожидаемые строки:
```text
FINANCE_OPS_EXACT_SHA_CI=PASS
FINANCE_POSTGRES_CODE_UNCHANGED=PASS
FINANCE_OPS_ORIGINAL_PIN=STALE
FINANCE_OPS_PREFLIGHT=PASS
FINANCE_OPS_PREVIOUS_CONFIG_BACKUP=PASS
FINANCE_OPS_SHA_PIN=PASS
FINANCE_OPS_ORIGINAL_PIN=CURRENT
FINANCE_DATABASE_AND_AUTH_UNCHANGED=YES
```

При `POSTGRES_RUNTIME_CHANGED_REQUIRES_SEPARATE_REVIEW`, неуспешном CI,
недоступности backup или другом `NO_GO` необходимо остановиться:
обновлённый код PostgreSQL уже требует **отдельного** процесса миграции.
Нельзя удалять каталог `pgdata`, снижать права, обходить pin или
подменять GitHub-результаты.

Штатное восстановление после этого не требует проверки `systemctl restart`
на работающем production: точный SHA проверяется при каждом дальнейшем
стартовом вызове, а источник PostgreSQL подтверждён неизменным.
