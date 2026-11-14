# #69 - ограниченное окно ручного импорта для одного владельца

**Состояние на 14.11.2026:** production backend и статический интерфейс
установлены и подтверждены. Владелец самостоятельно проверил, что
сохранённая AES-GCM-копия совпадает с локальной IndexedDB, затем восстановил
её в отдельном гостевом профиле браузера и сверил суммы после перезагрузки.
Это два подтверждённых владельцем этапа. Реальных операций импорта в
PostgreSQL ещё не выполнялось.

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

# Только чтение: точный main+CI, исходники backend, OAuth,
# PostgreSQL/backup.timer, TLS Origin CA, 70/80/90, runtime=off,
# исходный Caddy и анонимное отсутствие import endpoints.
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
4. добавляет в Caddy только три пути и только для POST:
   `/api/finance/v1/import/manifest`, `/commit`, `/restore`;
5. валидирует Caddy и выполняет только **анонимные отрицательные** запросы
   к каждой из трёх операций (HTTP 401 с правильным Origin, 403 с
   неправильным Origin), а также проверяет действующие OAuth и API.
6. при ошибке пытается восстановить два исходных конфигурационных файла
   и перезапустить только auth backend.

Ожидается:

```text
FH_IMPORT_WINDOW_BACKEND=ENABLED
FH_IMPORT_ANONYMOUS_AND_CSRF_DENY=PASS
FH_IMPORT_WINDOW_FINANCIAL_WRITE=NOT_PERFORMED
FH_IMPORT_FRONTEND=INDEPENDENTLY_GATED
```

## Отдельный выпуск интерфейса

В исходном `index.html` флаг
`<meta name="fh-finance-import" content="disabled">` **остаётся
выключенным в этом PR**. После PASS на backend нужно отдельным
точным PR переключить его на `enabled`, пройти тесты/CodeQL,
выпустить конкретный SHA через штатный production static workflow
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
