# #33/#70 - защищённое включение финансового API на существующем FH backend

**Состояние 13.11.2026:** владелец проверил production-хост:
`AUTH_BIND_HOST=127.0.0.1`, `AUTH_BIND_PORT=9138`,
`FINANCE_FLAGS=OFF`, `AUTH_SOURCE_DROPIN=PRESENT`,
оба OAuth-обработчика Caddy присутствуют. Финансовые маршруты Caddy отсутствуют.
`FINANCE_OPS_REPIN_COMPLETE=PASS` на `main@2408589...`.
PostgreSQL 17 с 15 FORCE RLS, зашифрованным резервированием и
успешным реальным restore уже принята в #66.

## Что изменяет выпуск

Операторский `scripts/fh_finance_private_api_release.py` подключает
**тот же** `fh-email-auth.service` к PostgreSQL через локальный
`127.0.0.1:54329` с минимальной ролью `fh_finance_runtime`.
Стабильный случайный UUID финансового пространства создаётся **один раз**
и сохраняется в закрытом `runtime.env` с root-only резервной копией.
**Пароль PostgreSQL не копируется в этот файл и его backup:** он остаётся
только в существующем `secrets/runtime_password` (UID 999, 0400),
а systemd `LoadCredential` передаёт его через закрытый runtime каталог
`/run/credentials/fh-email-auth.service`. Небольшой проверенный Python
launcher собирает DSN только **в памяти процесса** до запуска Uvicorn.
В `ExecStart`, Caddy, GitHub, журнал и PWA секрет не передаётся.
Не использовать мигратор или суперпользователя PostgreSQL для HTTP.

В отдельном `90-finance-runtime.conf` включаются
`FH_FINANCE_RUNTIME_MODE=personal`, `FH_FINANCE_V2_RUNTIME=on`
(ранее одобренный кандидат счетов v2), но
`FH_FINANCE_IMPORT_RUNTIME=off`.
`70-oauth.conf`, `80-finance-source.conf`, текущая auth SQLite,
OAuth-провайдеры, пароль пользователя, PWA, IndexedDB не меняются.

После проверки приватного API добавляется **только пять точных Caddy
маршрутов** (без wildcard): GET `/api/finance/v1/state`,
GET `/api/finance/v1/changes`,
POST `/api/auth/email/finance/session`,
POST `/api/finance/v1/commands`,
POST `/api/finance/v2/commands`.
Маршруты импорта **не** публикуются. Все запросы должны пройти
действующую FH SQLite-сессию, Origin-проверку и PostgreSQL RLS;
анонимный доступ не разрешается.

## Порядок на настоящей production VPS

Перед работой убедиться, что другой оператор не обновляет сайт,
OAuth или финансовую базу. Подключиться под `root`:

```bash
bash <<'SH'
set -Eeuo pipefail
cd /opt/financial-horizon-ops
test "$(id -u)" -eq 0
test -z "$(git status --porcelain)"
git -c credential.helper= fetch origin main
git merge --ff-only origin/main
sha="$(git rev-parse HEAD)"

# Проверка и безопасное согласование SHA без остановки PostgreSQL.
python3 scripts/fh_finance_ops_repin.py --sha "$sha" --preflight
FH_FINANCE_PERSONAL_OPS_REPIN=YES \
  python3 scripts/fh_finance_ops_repin.py --sha "$sha" --apply

# Чтение текущего OAuth/PG status и GitHub CI.
python3 scripts/fh_finance_private_api_release.py --sha "$sha" --preflight

# Готовим private runtime ID, секреты и проверяем соединение от сервисного user.
python3 scripts/fh_finance_private_api_release.py --sha "$sha" --prepare

# Backend доступен только через 127.0.0.1:9138. Caddy ещё не изменён.
python3 scripts/fh_finance_private_api_release.py --sha "$sha" --enable-local
SH
```

При успешном `--enable-local` ожидаются:

```text
FINANCE_PRIVATE_API_PREFLIGHT=PASS
FINANCE_RUNTIME_CREDENTIALS=PASS
FINANCE_PROFILE_NAMESPACE_BACKUP=PASS
FINANCE_API_PREPARED=PASS
FINANCE_API_LOCAL_ROUTES=PASS
FINANCE_API_OAUTH_PRESERVED=PASS
FINANCE_API_IMPORT=OFF
FINANCE_API_LOCAL_ENABLED=PASS
CADDY_UNCHANGED=YES
```

Проверки от непривилегированного `fh-email-auth` обязаны подтвердить
роль `fh_finance_runtime` в собственной finance PostgreSQL, 15 RLS
таблиц и право только чтения собственного RLS-visible scope.
HTTP проверяет те же четыре OAuth provider, анонимный 401 для
finance v1/v2 и 403 для постороннего `Origin`. При сбое
`90-finance-runtime.conf` снимается и auth-служба откатывается
автоматически, без восстановления устаревшей auth SQLite.

## Публикация точных защищённых маршрутов

Только после подтверждения предыдущего `PASS`:

```bash
cd /opt/financial-horizon-ops
sha="$(git rev-parse HEAD)"
python3 scripts/fh_finance_private_api_release.py --sha "$sha" --publish
```

Сценарий принимает лишь узнаваемый существующий Caddy OAuth handler,
создаёт root-only 0600 копию исходного Caddy site, валидирует
`caddy validate`, перезагружает Caddy и проверяет origin HTTPS
на **реальном порту 8444** с **закреплённым доверенным Origin CA**,
не применяя `--insecure`.
Анонимные GET/POST к finance v1/v2 должны возвращать **401**;
наличие OAuth-провайдеров также проверяется.
При ошибке исходный Caddy site восстанавливается и перечитывается,
автоматический откат не затрагивает auth SQLite/PostgreSQL.

Ожидается:

```text
FINANCE_HTTPS_ORIGIN_ROUTING=PASS
FINANCE_PUBLIC_ANONYMOUS_REJECTED=PASS
FINANCE_API_PUBLISHED=PASS
FINANCE_IMPORT_PWA=OFF
```

Публичный URL финансового API теперь доступен, но только
**авторизованным** FH-пользователям. Отсутствуют кнопка счетов,
автосинхронизация и автоматический импорт IndexedDB.

## Отдельная пользовательская проверка (обязательна до #33/#70)

В уже открытом сеансе FH необходимо проверить:
- Same-origin `POST /api/auth/email/finance/session` с реальной
  HttpOnly cookie и корректным Origin - успешный ответ и отдельная
  finance-cookie, без передачи токенов в чат или GitHub.
- `GET /api/finance/v1/state` возвращает профиль того же FH-пользователя;
  новый серверный профиль пуст до **явных** действий владельца,
  никакая локальная финансовая база при входе не загружается.
- `POST /api/finance/v2/commands` для утверждённого тестового счёта
  только после личного согласия на проверочную запись, затем реальный
  GET и повтор запроса с тем же идемпотентным ключом без дубля.
- После logout доступ к finance должен стать 401; другой FH-пользователь
  не должен прочитать тот же профиль. Эти проверки не имитируются
  анонимными smoke и требуют осознанной тестовой операции.
- `If-Match`, conflict 412, CSRF, учет отмен связанных операций и
  восстановление UI/IndexedDB проходят отдельную матрицу #33/#70.

## Безопасный откат

Если появится проблема после локального или публичного включения:

```bash
cd /opt/financial-horizon-ops
sha="$(git rev-parse HEAD)"
FH_FINANCE_ROLLBACK=YES \
  python3 scripts/fh_finance_private_api_release.py --sha "$sha" --rollback
```

Сначала возвращается точная резервная копия Caddy (при наличии),
потом удаляется только `90-finance-runtime.conf` и перезапускается
прежний auth backend. Файлы профилей/паролей сохраняются для
последующего восстановления, **финансовая PostgreSQL, SQLite и
IndexedDB не удаляются**. При неожиданной сторонней правке Caddy
выполнение останавливается вместо её перезаписи.

**Ограничения:** не считать успешную публикацию достаточной для закрытия
#33/#68/#69/#70. Эти задачи требуют реальных владельческих E2E,
офлайн-синхронизации, управляемого импорта и возврата денег без дублей.
