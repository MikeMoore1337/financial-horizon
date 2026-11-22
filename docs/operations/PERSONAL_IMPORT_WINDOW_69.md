# #69 - ограниченное окно ручного импорта для одного владельца

**Состояние на 14.11.2026:** production backend и статический интерфейс
установлены и подтверждены. Владелец самостоятельно проверил, что
сохранённая AES-GCM-копия совпадает с локальной IndexedDB, затем восстановил
её в отдельном гостевом профиле браузера и сверил суммы после перезагрузки.
Это два подтверждённых владельцем этапа. Реальных операций импорта в
PostgreSQL ещё не выполнялось.

## Уточнение схемы Caddy по реальной диагностике (14.11.2026)

Владелец подтвердил read-only квитанции production:

```text
FINANCE_ROUTES_EXACT=0
FINANCE_ROUTES_NORMALIZED=0
OAUTH_MARKER_EXACT=1
FINANCE_READ_MATCHER=2
FINANCE_READ_HANDLER=1
FINANCE_WRITE_MATCHER=2
FINANCE_WRITE_HANDLER=1
FINANCE_STATE_PATH=1
FINANCE_COMMAND_PATH=1
FINANCE_V2_COMMAND_PATH=1
IMPORT_PATH_OCCURRENCES=0
IMPORT_MATCHER=0
```

Подстрока `@fh_finance_read {` встречается **два** раза, потому что
включена также в `handle @fh_finance_read {`. Это не означает два
маршрута. Старый скрипт требовал, чтобы все finance matcher/handler
располагались одним цельным блоком `finance.ROUTES`, хотя такой порядок
не является частью политики безопасности.

Исправленный `caddy_import_patch` **не копирует и не меняет** имеющиеся
finance/OAuth-блоки и не допускает wildcard. Он отдельно валидирует
ровно четыре существующих именованных блока: read GET c точным списком
`/state` и `/changes`; write POST с тремя разрешёнными путями;
и два обработчика `reverse_proxy 127.0.0.1:9138`.
Любые дополнительные методы/пути/директивы, дубли или другое назначение
proxy отклоняются. Допускаются разделённые существующими правилами
блоки и иной порядок альтернативных путей. Новый import-only POST-блок
вставляется непосредственно перед прежним уникальным маркером OAuth,
**без редактирования остальных байтов**. После включения Caddy и
backend обязательны отрицательные HTTP 401/403 со всех трёх import routes,
иначе исходная конфигурация восстанавливается.

Если реальный VPS после исправления всё ещё сообщает
`CADDY_FINANCE_BLOCK_UNEXPECTED_DIRECTIVES` или
`CADDY_FINANCE_BLOCK_MISSING_OR_DUPLICATE`, **не обходить отказ**:
проверять и согласовать реальные matcher/handler без публикации
конфиденциальных строк site.

## Уточнение: вложенный Caddy `reverse_proxy` для сильных ETag

Найден не предположительный, а **уже предусмотренный проектом** источник
вложенности: `scripts/fh_finance_etag_transport.py` ранее отдельно
преобразовал оба действующих финансовых обработчика в:

```caddy
handle @fh_finance_read {
    reverse_proxy 127.0.0.1:9138 {
        header_down Cache-Control "private, no-store, no-transform"
    }
}
```

Ровно такой же вложенный обработчик применён к
`handle @fh_finance_write`. Директива `no-transform` сохраняет
сильные `ETag` финансового API при прохождении Caddy/Cloudflare.
Это защищает согласованность операций, выполняемых с `If-Match`.

Первый скрипт #69 требовал смежного блока Caddy, второй ошибочно отвергал
любую вложенность. Исправленный проверяющий код принимает **только
согласованную вложенность** `reverse_proxy 127.0.0.1:9138` с точной
директивой `header_down Cache-Control "private, no-store, no-transform"`
в обоих обработчиках. Он отклоняет отсутствие `no-transform`,
дополнительные заголовки, новые вложенные `route`, изменённые пути
или адрес прокси. Раздельное расположение правил Caddy по-прежнему
допускается, а исходные байты действующих обработчиков сохраняются.

Кодовый CI с фиктивной конфигурацией **не является** проверкой реального
Caddy. На VPS до подтверждённого `FH_IMPORT_WINDOW_PREFLIGHT=PASS`
**не выполнять `--enable`** и не менять сайт вручную.

## Исправление системного загрузчика после rollback (15.11.2026)

Первая попытка оператора открыть импорт завершилась безопасно:

```text
FH_IMPORT_WINDOW_PREFLIGHT=PASS
AUTH_SQLITE_PROTECTED_BACKUP=PASS
FH_IMPORT_WINDOW_ROLLBACK=STARTED
FH_IMPORT_WINDOW_ROLLBACK=PASS
FH_IMPORT_WINDOW=NO_GO
FAILURE_CODE=LOCAL_HTTP_PROBE_UNAVAILABLE
```

Последующая независимая диагностика подтвердила
`IMPORT_RUNTIME=OFF`, `fh-email-auth.service=active`,
`fh-finance-personal.service=active`, `caddy.service=active`,
`AUTH_HTTP=200`, `FINANCE_HTTP=401`, `IMPORT_HTTP=404`,
`IMPORT_CHECK=PASS` и `PYDANTIC_VERSION=2.14.3`.

Точная причина найдена **в существующем системном загрузчике**, а не в
состоянии PostgreSQL, Pydantic или вложенном Caddy: установленный
`scripts/fh_finance_api_launcher.py` имел проверку
`FH_FINANCE_IMPORT_RUNTIME != "off" → FINANCE_LAUNCHER_NO_GO` и
останавливал Uvicorn при переводе разрешённого backend флага в `on`.
Никакого автоматического обхода старой защиты не предусмотрено.

Требуется обновить **только** установленную копию загрузчика по сравнению
с точным ранее выпущенным хешем SHA-256. Новая версия принимает только
`FH_FINANCE_RUNTIME_MODE=personal`, `FH_FINANCE_V2_RUNTIME=on`,
**явно указанный** `FH_FINANCE_IMPORT_RUNTIME=off|on`, а также обязательный
systemd `LoadCredential`, существующий личный UID/namespace/OAuth-сервис.
Не меняются PostgreSQL/SQLite, токены, порт, Caddy, пути и подписки.
В режиме OFF загрузчик работает по-прежнему.

Порядок на VPS после успешного CI новой версии:

```bash
# Предварительные проверки и repin PostgreSQL SHA выполняются как описано ниже.
# НЕ менять флаг импорта и НЕ запускать --enable до обновления загрузчика.
python3 scripts/fh_finance_personal_launcher_upgrade.py --sha "$sha" --preflight

FH_PERSONAL_LAUNCHER_UPGRADE=YES \
  python3 scripts/fh_finance_personal_launcher_upgrade.py --sha "$sha" --install

# Проверяет, что root-owned installed launcher точь-в-точь новый reviewed
# source, mode=0640, group=fh-email-auth, auth/PG/Caddy и import OFF.
python3 scripts/fh_finance_personal_import_window.py --sha "$sha" --preflight
```

Установка не перезапускает сервис. Она сохраняет точную старую программу
в режиме 0600 в root-only каталоге backup, заменяет файл атомарно с
`root:fh-email-auth 0640` и повторно проверяет действующий OAuth/finance.
При ошибке установки предусмотрен побайтовый откат файла загрузчика.
**Не удалять** старые резервные файлы после предыдущего отказа.
`--enable` теперь допускает использовать их повторно, только если
оба root-only файла совпадают с текущими защищёнными исходными конфигурациями.

## Не делать

- Не запускать `fh_finance_private_api_release.py` и
  `fh_finance_auth_source_rollout.py`: финансовый API уже работает.
- Не сбрасывать PostgreSQL, тестовый нулевой RUB-счёт, OAuth, IndexedDB,
  шифрованный архив, cookie, Caddy и backup.timer.
- Не включать фоновую синхронизацию #68 в рамках этой задачи.
- Не передавать файл или пароль финансовой копии оператору, в CI, GitHub
  либо по Telegram.
- Не выполнять импорт из консоли сервера: его подтверждает только владелец
  в браузере, дважды прочитав предварительный просмотр.

## Перед включением backend

На VPS с ограниченным root-доступом, **только после слияния PR этой задачи
и успешного exact-main CI + security checks**, выполнить:

```bash
set -Eeuo pipefail
export SYSTEMD_PAGER=cat
cd /opt/financial-horizon-ops
test "$(id -u)" -eq 0
test -z "$(git status --porcelain)"
git -c credential.helper= fetch origin main
git merge --ff-only origin/main
sha="$(git rev-parse HEAD)"

# Обновить только SHA-привязку к неизменённому PostgreSQL-коду,
# без рестарта PostgreSQL и без миграции схемы.
python3 scripts/fh_finance_ops_repin.py --sha "$sha" --preflight
FH_FINANCE_PERSONAL_OPS_REPIN=YES \
  python3 scripts/fh_finance_ops_repin.py --sha "$sha" --apply

# Проверить установленный СТАРЫЙ загрузчик и атомарно заменить его
# новой проверенной программой БЕЗ перезапуска живого OAuth/backend.
python3 scripts/fh_finance_personal_launcher_upgrade.py --sha "$sha" --preflight
FH_PERSONAL_LAUNCHER_UPGRADE=YES \
  python3 scripts/fh_finance_personal_launcher_upgrade.py --sha "$sha" --install

# Только чтение: точный main+CI, исходники backend, OAuth,
# PostgreSQL/backup.timer, TLS Origin CA, 70/80/90, runtime=off,
# установленный новый загрузчик, Caddy и отсутствие import endpoints.
python3 scripts/fh_finance_personal_import_window.py --sha "$sha" --preflight
```

Ожидается:

```text
FH_IMPORT_WINDOW_PREFLIGHT=PASS
FH_IMPORT_RUNTIME_BEFORE=OFF
FH_FINANCIAL_DATA_UNCHANGED=YES
```

**Если `NO_GO`, ничего не обходить.** Дать точный `FAILURE_CODE`
для исправления причины.

## Открыть только приватный write API

После разрешённого preflight:

```bash
FH_PERSONAL_IMPORT_WINDOW=ENABLE \
  python3 scripts/fh_finance_personal_import_window.py --sha "$sha" --enable
```

Механизм не меняет ни одной финансовой записи. Он делает только:

1. root-only backup исходного `/etc/financial-horizon/finance/runtime.env`
   и Caddy site, плюс непротиворечивый backup OAuth SQLite;
2. точно заменяет `FH_FINANCE_IMPORT_RUNTIME=off` на `on`, оставляя
   личный namespace, пароль БД и OAuth-конфигурацию неизменными;
3. перезапускает **только** `fh-email-auth.service`;
4. добавляет в Caddy только три пути для POST:
   `/api/finance/v1/import/manifest`, `/commit`, `/restore`, а также
   ровно один защищённый GET `/api/finance/v1/import/bank/rows` для сверки;
5. валидирует Caddy и выполняет только **анонимные отрицательные** запросы
   к каждой из трёх операций (HTTP 401 с правильным Origin, 403 с
   неправильным Origin), проверяет анонимный отказ GET сверки, а также
   проверяет действующие OAuth и API.
6. при ошибке пытается восстановить два исходных конфигурационных файла
   и перезапустить только auth backend.

Ожидается:

```text
FH_IMPORT_WINDOW_BACKEND=ENABLED
FH_IMPORT_ANONYMOUS_AND_CSRF_DENY=PASS
FH_IMPORT_WINDOW_FINANCIAL_WRITE=NOT_PERFORMED
FH_IMPORT_FRONTEND=INDEPENDENTLY_GATED
```

## Реальная квитанция включённого backend

15.11.2026 после подтверждённого `FH_LAUNCHER_UPGRADE=PASS` и
`FH_IMPORT_WINDOW_PREFLIGHT=PASS` команда `--enable` разорвала
операторский терминал, но последующая **читающая** проверка непосредственно
на VPS зафиксировала:

```text
IMPORT_RUNTIME=ON
fh-email-auth.service=active
fh-finance-personal.service=active
caddy.service=active
IMPORT_CADDY_ROUTE=PRESENT
AUTH_HTTP=200
FINANCE_HTTP=401
IMPORT_LOCAL_HTTP=401
IMPORT_PUBLIC_HTTP=401
DIAGNOSTICS_COMPLETE=YES
CONFIGURATION_UNCHANGED=YES
```

Это доказательство включённой маршрутизации и отрицательного доступа
анонимного пользователя, **не** выполненного переноса средств. Не вызывать
`--enable` повторно. Проверка отрицательного Origin/CSRF для всех трёх
POST endpoints ещё не представлена как отдельная квитанция; не считать
одного ответа HTTP 401 доказательством всей авторизации и защиты.

## Отдельный выпуск интерфейса

В отдельном статическом PR #69 флаг `index.html`
`<meta name="fh-finance-import" content="enabled">` включается только
после подтверждённого на VPS `IMPORT_RUNTIME=ON` и защиты анонимного
доступа. Нужны полные app/auth/PG/Chromium+WebKit CI, CodeQL и публикация
конкретного SHA через штатный production static workflow
и сверить `PRODUCTION_DEPLOYED=<sha>`.

После этого кнопка «Настройки → Зашифрованная копия →
Перенести данные в аккаунт» становится видимой **только** после
подтверждённого входа. Владелец выбирает проверенный внешний AES-файл,
вводит пароль, видит число операций/кредитов и подтверждает
сохранение единственного пустого RUB-счёта отдельной галочкой.
Только после второго согласия выполняются стадирование,
атомарная запись и проверка точного восстановления исходного содержимого.
Ошибки/обрыв сети могут означать неизвестный исход, поэтому
**автоматический повтор запрещён**.

## Закрыть окно после результата

Вне зависимости от успеха/ошибки операции, после расследования
неизвестного исхода (при необходимости) закрыть публичный путь:

```bash
FH_PERSONAL_IMPORT_WINDOW=DISABLE \
  python3 scripts/fh_finance_personal_import_window.py --sha "$sha" --disable
```

Ожидается:

```text
FH_IMPORT_WINDOW_BACKEND=DISABLED
FH_IMPORT_PUBLIC_ROUTES=REMOVED
FH_IMPORT_USER_FINANCIAL_DATA_UNCHANGED_BY_TOGGLE=YES
```

Закрытие вначале убирает Caddy POST-маршруты, затем выключает импорт
в backend. Оно **не удаляет уже импортированные данные** и не откатывает
подтверждённые транзакции. Не отменять изменения PostgreSQL, если
после переноса уже появились подтверждённые операции.

После завершения #69 можно отдельным статическим выпуском выключить
кнопку, оставив read-only проверку зашифрованной копии доступной.

## Граница приёмки

До реального пользовательского `PREVIEW → consent → stage → commit →
byte-exact restore` **#69 остаётся OPEN**. Операционный скрипт
и CI подтверждают безопасность включения маршрутов, но не заменяют
фактическую приёмку. #68 (2 устройства и офлайн-очередь)
также остаётся самостоятельной задачей.
