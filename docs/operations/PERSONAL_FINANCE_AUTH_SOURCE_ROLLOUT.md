# #66/#70 - безопасная замена исходников FH email/OAuth backend на finance-capable

**Назначение:** заменить только код действующего `fh-email-auth.service` на актуальный
`main`, не включая финансовые маршруты и не меняя существующую авторизацию.

На 13.11.2026 инфраструктура PostgreSQL личного режима подтверждена владельцем:
`RESTORE_DRILL_PASS: 15 finance tables`, обе проверки loopback,
`fh-finance-personal.service=active`,
`fh-finance-personal-backup.timer=active`, backup Result=success.
При этом в работающем `fh-email-auth.service` отсутствует
`_personal_finance_runtime_options` - запущен старый OAuth backend.

## Что НЕ делать

- Не запускать повторно `scripts/fh_oauth_production_release.py --apply`:
  старый сценарий рассчитан на первоначальное включение OAuth и может
  менять Caddy, SQLite и параметры провайдеров.
- Не редактировать `/etc/financial-horizon/email-auth.env` и
  `/etc/financial-horizon/oauth.env`.
- Не пересоздавать `fh-finance-postgres` и не удалять PostgreSQL/SQLite.
- Не включать `FH_FINANCE_RUNTIME_MODE=personal`, v2, импорт или
  клиентские `fh-finance-accounts`/`fh-finance-import` до
  отдельной проверенной интеграции.

## Подготовка source-only backend release

Только с root SSH на **настоящей** VPS, не в изолированном Hermes Agent:

```bash
set -Eeuo pipefail
cd /opt/financial-horizon-ops
test -z "$(git status --porcelain)"
git -c credential.helper= fetch origin main
git merge --ff-only origin/main
sha="$(git rev-parse HEAD)"

python3 scripts/fh_finance_auth_source_rollout.py \
  --sha "$sha" --preflight

python3 scripts/fh_finance_auth_source_rollout.py \
  --sha "$sha" --stage
```

`--preflight` сверяет текущий точный SHA и 4/4 успешных
`main` CI, наличие PostgreSQL/Auth/Caddy служб, пользователя
`fh-email-auth`, связь с оригинальным `current` release, безопасные
аргументы Uvicorn, исходную конфигурацию `70-oauth.conf`,
список **четырёх** OAuth-провайдеров, анонимное `/api/auth/email/me`
и отсутствие смонтированных финансовых маршрутов.
Не печатает значения переменных окружения.

`--stage` создаёт только новую
`/opt/financial-horizon-auth/releases/<main-SHA>` с актуальными
`fh_email_auth`, `fh_auth`, `finance_db`, `finance_api`;
создаёт отдельное `.finance-venv` и устанавливает существующие
`backend/requirements.txt` и `backend/requirements-finance.txt`,
проверяет импорты и отключённые финансовые опции под
непривилегированным пользователем службы.
Текущий Uvicorn, `current`, SQLite, Caddy и настройки OAuth не меняются.

Ожидаемые безопасные результаты:
```text
FINANCE_BACKEND_PREFLIGHT=PASS
LIVE_AUTH_SERVICE_UNCHANGED=YES
FINANCE_BACKEND_STAGED=PASS
FINANCE_RUNTIME_FLAGS=OFF
LIVE_AUTH_SERVICE_UNCHANGED=YES
```

### Исправление ограниченных прав staged Python (2026-11-13)

Если `--preflight` проходит, а `--stage` сообщает
`AUTH_FINANCE_IMPORT_AS_SERVICE_USER_FAILED`, это **не** отказ
PostgreSQL и не доказательство повреждения OAuth. Исходный скрипт
копировал backend через `shutil.copytree()`, который сохраняет
исходные права root-only `0700/0600`. Новый каталог release мог стать
нечитаемым для `fh-email-auth` даже после `umask 022`.

Исправленный `--stage` проверяет владельца каждого inode внутри
нового неактивного релиза, запрещает внешние symlink в исходниках и
совместно используемые hardlink, выдаёт право чтения/доступа **только**
основной группе `fh-email-auth` без права записи и без изменения
старого release. Виртуальное окружение проверяется отдельно.
При последующей ошибке не публикует Python traceback, а возвращает
конкретную безопасную категорию: `STAGED_BACKEND_NOT_TRAVERSABLE`,
`STAGED_VENV_NOT_EXECUTABLE`,
`STAGED_PACKAGE_NOT_READABLE_*`,
`STAGED_MODULE_IMPORT_AUTH_FAILED`,
`STAGED_MODULE_IMPORT_OAUTH_FAILED`,
`STAGED_MODULE_IMPORT_LEDGER_FAILED`,
`STAGED_MODULE_IMPORT_FINANCE_API_FAILED` или
`STAGED_FINANCE_DEFAULT_OFF_FAILED`.
Подготовленный неактивный каталог удаляется при ошибке, работающие
`current`, systemd, OAuth, SQLite и PostgreSQL не изменяются.

Перед повторной попыткой использовать **новый точный `main` SHA**
с успешным 4/4 CI; старый SHA/скрипт не запускайте.
Повторно выполняются только `--preflight`, затем `--stage`;
`--apply` допускается исключительно после `FINANCE_BACKEND_STAGED=PASS`.

При ошибке `NO_GO` не повторять этап с обходом проверок.
Сохранить точный код отказа, не присылать секреты и вывод конфигурационных файлов.

### Исправление проверки Python-интерпретатора после успешного stage (13.11.2026)

Если `--stage` завершился `FINANCE_BACKEND_STAGED=PASS`,
а `--apply` вернул `STAGED_PYTHON_UNAVAILABLE`, первопричина
в прежней проверке `python.is_symlink()`, которая отклоняла обычную
символическую ссылку `.finance-venv/bin/python`. Это происходило
**до** резервной копии SQLite, изменения `current`, systemd и OAuth.

Обновлённый `--apply` разрешает только штатную ссылку на конкретный
Python-интерпретатор оператора, которым создавали виртуальное окружение,
либо файл внутри данного приватного stage. Проверяются владелец,
отсутствие прав записи у посторонних, обычный исполняемый файл,
запрет недействительных и посторонних ссылок. Отдельная проверка
импорта под `fh-email-auth` остаётся обязательной.

После слияния исправления необходимо сделать fast-forward checkout
до нового точного `main` SHA с успешным CI и **заново** выполнить
`--preflight` → `--stage` → `--apply`. Предыдущий stage
на старом SHA не переименовывать и не удалять вручную. Применение
не выполнялось на текущем production до исправления.

## Переключение исходников backend

**Только после успешного `--stage`** и проверки состояния рабочей службы.
Задача владельца - разрешённое production-обновление; это не
разрешение вводить облачные финансовые данные:

```bash
cd /opt/financial-horizon-ops
sha="$(git rev-parse HEAD)"
python3 scripts/fh_finance_auth_source_rollout.py \
  --sha "$sha" --apply
```

Перед изменениями повторно проверяются GitHub SHA/CI, работающие OAuth
и существующая SQLite. Создаётся отдельная защищённая 0600 онлайн-копия
auth SQLite с `integrity_check` и `foreign_key_check`, без дампа в stdout.
Новый drop-in `80-finance-source.conf` только заменяет `ExecStart`,
`WorkingDirectory` и `PYTHONPATH`. Старый `70-oauth.conf`,
учётные данные и Caddy остаются без изменений.
`current` атомарно указывает на тот же release, что и systemd.
После перезапуска проверяются ровно те же Google, Яндекс, VK и Telegram,
анонимная auth-сессия и **404 финансового API** (флаги ещё выключены).
При недоступности/регрессии новый drop-in удаляется, `current`
возвращается на прежний release, старая служба перезапускается.
При откате **не** восстанавливается устаревший SQLite-снимок,
чтобы не потерять новые сессии или записи.

Ожидаемые результаты:
```text
AUTH_SQLITE_PROTECTED_BACKUP=PASS
FINANCE_BACKEND_SOURCE_DEPLOYED=PASS
OAUTH_PROVIDER_SET_PRESERVED=PASS
EMAIL_AUTH_ANONYMOUS_SMOKE=PASS
FINANCE_RUNTIME_FLAGS=OFF
AUTH_SQLITE_RESTORED=NO
CADDY_CHANGED=NO
```

Если `FINANCE_BACKEND_ROLLBACK=FAILED_MANUAL_REVIEW_REQUIRED`,
не продолжать с финансами; оставить API и импорт выключенными,
восстановить доступ к email/OAuth из прежнего release.
Никогда не восстанавливать старую auth SQLite поверх работающей.

## Что следует после source-only обновления

Отдельно подготовить root-only постоянный UUID финансового профиля,
URL runtime PostgreSQL с секретом отдельной роли
`fh_finance_runtime` и systemd EnvironmentFile. До включения API
подтвердить localhost PostgreSQL, реальный AuthStore/FH login-cookie
и повторное чтение finance-контекста на **том же** профиле, а также
отказ 401/403/412 для чужих/просроченных операций и наличие rollback.
После серверного smoke добавить закрытые маршруты Caddy
`/api/finance/v1/*`/`/api/finance/v2/*` к существующему auth backend.
Только затем клиентский `fh-finance-accounts` и отдельный явно
подтверждённый импорт; #68 требует независимой офлайн-резолюции.

Ни `--stage`, ни `--apply` не выполняют эту следующую активацию
и **не** являются основанием для закрытия #33/#68/#69/#70.
