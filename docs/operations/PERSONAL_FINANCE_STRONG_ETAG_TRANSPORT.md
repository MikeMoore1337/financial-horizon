# #33/#70 - сохранение сильного ETag через Caddy и Cloudflare

**Подтверждённый production дефект 13.11.2026.** Пользователь уже вошёл в
Financial Horizon через FH email/OAuth; реальный браузерный smoke вернул:

```text
ORIGIN=PASS
FH_AUTH_SESSION=PASS
FINANCE_SESSION=PASS
FINANCE_STATE=PASS
PROFILE_SCOPE=PASS
HTTP_STATUS=200
ETAG_PRESENT=true
ETAG_FORMAT=WEAK
ETAG_LENGTH=27
CACHE_CONTROL=private, no-store
```

В `backend/finance_db/ledger_service.py` `_opaque_etag` создаёт
**сильный** ревизионный тег `"fh.1.<revision>.<digest>"` (для ревизии
0 - длина 25). Переданный браузеру `W/"..."` имеет длину 27:
возможно, промежуточный сервер ослабил тег при смене кодирования тела.
Сам заголовок есть, HTTP 200 и идентичность серверного FH-профиля
прошли; реальные денежные операции ещё не тестировались.

Официальные первоисточники:
- https://developers.cloudflare.com/cache/reference/etag-headers/
  Cloudflare может заменить сильный ETag на слабый при перекодировании
  gzip/brotli/zstd.
- https://developers.cloudflare.com/cache/concepts/cache-control/
  `Cache-Control: no-transform` запрещает преобразование ответа и
  отключает компрессию на Cloudflare.
- https://caddyserver.com/docs/caddyfile/directives/encode
  Caddy не сжимает ответ с `Cache-Control: no-transform`.
- https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
  Caddy `header_down` выставляет заголовок **до** передачи ответа
  клиенту.

**Решение:** не удалять `W/` в JavaScript, не снижать
`If-Match` до слабого ETag. На установленном Caddy добавить
`header_down Cache-Control "private, no-store, no-transform"`
**только** к двум существующим блокам `handle @fh_finance_read`
и `handle @fh_finance_write`. Остальные OAuth, статика, регистрация
и API-ошибки остаются прежними. Это точечная настройка транспорта,
а не изменение финансовой бизнес-логики.

## Сценарий для native production VPS

Только с прямым root SSH к авторизованному серверу, без параллельных
ручных изменений Caddy и после точного SUCCESS post-merge CI на новом SHA:

```bash
bash <<'SH'
set -Eeuo pipefail
cd /opt/financial-horizon-ops
test "$(id -u)" -eq 0
test -z "$(git status --porcelain)"
git -c credential.helper= fetch origin main
git merge --ff-only origin/main
sha="$(git rev-parse HEAD)"

# Только сверка SHA, без повторных миграций / Docker restart.
python3 scripts/fh_finance_ops_repin.py --sha "$sha" --preflight
FH_FINANCE_PERSONAL_OPS_REPIN=YES \
  python3 scripts/fh_finance_ops_repin.py --sha "$sha" --apply

python3 scripts/fh_finance_etag_transport.py --sha "$sha" --preflight
python3 scripts/fh_finance_etag_transport.py --sha "$sha" --apply
python3 scripts/fh_finance_etag_transport.py --sha "$sha" --verify
SH
```

Ожидаемые безопасные квитанции:

```text
FINANCE_POSTGRES_CODE_UNCHANGED=PASS
FINANCE_OPS_SHA_PIN=PASS
FINANCE_ETAG_PREFLIGHT=PASS
PRODUCTION_CADDY_UNCHANGED=YES
FINANCE_ETAG_NO_TRANSFORM=PASS
FINANCE_ETAG_ORIGIN_HTTPS=PASS
FINANCE_ETAG_OAUTH_PRESERVED=PASS
FINANCE_ETAG_CADDY_ONLY=PASS
```

Операторский сценарий:
1. Сверяет exact текущий `main`, 4/4 CI, SHA systemd, что исходные
   финансовые маршруты Caddy соответствуют **ровно** двум известным
   правилам с proxy на `127.0.0.1:9138`.
2. Создаёт root-only 0600 backup **исходного** site
   `/var/backups/financial-horizon-finance/fh-finance-etag-caddy-original.bak`.
   Не заменяет и не читает исходный backup OAuth/финансового выпуска.
3. Атомарно заменяет только две точные конфигурации proxy, выполняет
   `caddy validate` + `systemctl reload caddy`.
4. Проверяет origin HTTPS на `127.0.0.1:8444` с закреплённым
   доверенным Cloudflare Origin CA, HTTP 401 у анонимного
   `GET /api/finance/v1/state`, наличие `private, no-store, no-transform`,
   и сохранение действующего OAuth. При ошибке пытается вернуть прежний Caddy.

**Это не подтверждение сильного ETag у авторизованного браузера**:
анонимный GET отвечает 401 и не содержит финансового ETag. После
успешного `--verify` владелец повторяет ранее созданный только
читающий браузерный smoke и сообщает `ETAG_FORMAT`, не раскрывая
значение заголовка, cookies или JSON. Только `ETAG_FORMAT=STRONG`
и успешный согласованный `If-Match` являются подтверждением исправления
в пользовательском контуре.

## Откат без потери данных

При regressии Caddy/HTTPS:

```bash
cd /opt/financial-horizon-ops
sha="$(git rev-parse HEAD)"
FH_FINANCE_ETAG_ROLLBACK=YES \
  python3 scripts/fh_finance_etag_transport.py --sha "$sha" --rollback
```

Точная оригинальная конфигурация восстанавливается из закрытого backup
только если текущий Caddy в точности соответствует ожидаемому патчу.
Посторонние изменения не перезаписываются. Аварийный откат проверяет
локальный SHA и оригинальный Git-источник, но **не зависит от доступности
GitHub API/CI или работоспособности OAuth**, чтобы им можно было
воспользоваться при неисправной публичной маршрутизации.
Восстановление Caddy не
меняет PostgreSQL, auth SQLite, банковские остатки, IndexedDB, user
cookies или параметры OAuth. Исходный backend finance API остаётся активным
и требует реальной FH-сессии.

**Остаточный риск:** если Cloudflare настроен игнорировать
`no-transform` (например, нестандартным правилом преобразования или
отключённым Origin Cache Control), Edge ETag может оставаться слабым.
Тогда нужно проверять настройки Cloudflare для **только** `/api/finance/`,
а не удалять проверку сильных `ETag` в приложении.
