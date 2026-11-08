# Financial Horizon #9 - Google, Яндекс ID и VK ID без Telegram

Решение владельца от 2026-11-08: **приостановить Telegram** и поэтапно проверять Google, Яндекс ID, VK ID. Не создавать второй OAuth-модуль. Код Telegram и разбор ошибки остаются в PR #11, но кнопка и endpoint не должны быть активны, пока Telegram не пройдёт отдельную приёмку.

## Область и безопасность

- Публичная email/password-авторизация и гостевой режим остаются без изменений.
- Проводить проверку только в существующей owner-only канарейке `fh-oauth-canary.service` (loopback `127.0.0.1:9139`, отдельная приватная SQLite). **Не** включать публичные флаги из `/etc/financial-horizon/oauth.env` и не мигрировать рабочую базу.
- Действующий Caddy уже ограничивает `/api/auth/providers`, `/api/auth/oauth/*`, `/api/auth/oauth-canary/status` доверенными Cloudflare CIDR и IP владельца. Проверить его перед переключением, а не открывать для всех.
- Скрипт `scripts/fh_oauth_owner_canary_switch.py` не содержит секретов, не читает финансовые данные и не меняет Caddy, production systemd unit или production SQLite. Он проверяет защищённые env-файлы и SQLite, делает `root:root 0600` резервную копию текущего canary env, атомарно переключает **ровно один** провайдер и проверяет HTTP 303 на доверенный адрес. При ошибке пытается восстановить предыдущую конфигурацию и работоспособность.
- Скрипт **не разрешает выбор Telegram**. Внутри канарейки Telegram всегда получает `FH_TELEGRAM_OAUTH_ENABLED=false`; остальные два из трёх провайдеров тоже выключены.
- В реальном браузере использовать новое окно Инкогнито. Canaries и публичный домен имеют общий origin/cookie name, поэтому нельзя тестировать в обычном браузере с существующей email-сессией.

## Повторное переключение Google после VK - диагностика и исправление (2026-11-08)

Реальный Google вход ещё НЕ проверен. Владелец получил `CANARY_PRECONDITION_OR_SWITCH=FAILED` / `FAILURE_TYPE=CheckFailed`, а открытие `/api/auth/oauth/google/start` вернуло 404 «Этот способ входа недоступен».

Обнаружен дефект самого скрипта: старое имя backup `oauth-canary-env-before-google-switch.env` закреплено за одним провайдером, и возврат к Google после прежней установки Google мог вызывать `CheckFailed` без переключения флагов. Это доказанный дефект кода, но **не подтверждённая пока причина конкретного отказа VPS**. Теперь новый root-only backup 0600 создаётся с уникальным именем при каждом переключении, существующие backup не перезаписываются.

Новая версия имеет `--preflight` (только чтение, без рестарта), а при `CheckFailed` сообщает только `FAILURE_CODE` из безопасного набора констант без исключений, секретов и PII. При `TARGET_CREDENTIALS_NOT_STAGED` проверять наличие собственных Google client_id/secret только локально на VPS. При любом другом отказе не обходить проверки, не менять Caddy/production env и не удалять архивные backup. Пробовать browser Google OAuth можно только после `CANARY_PREFLIGHT=PASS` и `CANARY_SWITCH=PASS`.

## Этап A - тестируем Google

Команда для авторизованного root-оператора, после проверки SHA-256:

```bash
# Загрузить исправленный скрипт на отдельное имя из immutable commit.
# Предыдущий операторский скрипт остаётся нетронутым.
sudo curl --fail --location --silent --show-error \
  https://raw.githubusercontent.com/MikeMoore1337/financial-horizon/68ae8d54c0c6f2a301654624bbd0abfd4a1cbbbc/scripts/fh_oauth_owner_canary_switch.py \
  -o /root/fh_oauth_owner_canary_switch_v2.py

echo 'fabb2dea0ad39d9570b458ac4d1af1a1c5102ec04c69b5a944415060188ccad0  /root/fh_oauth_owner_canary_switch_v2.py' | sudo sha256sum --check
sudo chmod 600 /root/fh_oauth_owner_canary_switch_v2.py

# Read-only preflight не изменяет env, SQLite, Caddy или systemd.
sudo python3 /root/fh_oauth_owner_canary_switch_v2.py --provider google --preflight

# Только после CANARY_PREFLIGHT=PASS:
sudo python3 /root/fh_oauth_owner_canary_switch_v2.py --provider google
```

**Ожидаемый технический результат** (не выдаёт доказательства реального входа):
```text
CANARY_SWITCH=PASS
SELECTED_PROVIDER=google
TELEGRAM_CANARY_DISABLED=YES
OTHER_PROVIDERS_DISABLED=YES
ISOLATED_SQLITE_IN_USE=YES
PRODUCTION_AUTH_AND_CADDY_UNCHANGED=YES
SECRETS_AND_TOKENS_PRINTED=NO
REAL_OAUTH_LOGIN=NOT_YET_VERIFIED
```

Только после этих результатов открыть в новом Инкогнито:
`https://fin-horizon.mikemoore.top/api/auth/oauth/google/start`. Проверить реальный consent → callback → `/api/auth/oauth-canary/status`. Успех требует HTTP 200 и страницы «Тестовый вход выполнен успешно». При ошибке остановиться: не повторять попытки бесконечно, не переходить к следующему провайдеру, диагностировать только безопасные категории.

## Этап B - Яндекс ID

После реального Google PASS (подтверждённая тестовая серверная сессия, logout/repeat login) оператор выполняет `sudo python3 /root/fh_oauth_owner_canary_switch_v2.py --provider yandex`. Тестируется `/api/auth/oauth/yandex/start`, стабильный `id`, ответный `client_id` именно FH-приложения, корректный logout. Никаких неявных объединений по email.

## Этап C - VK ID

После Яндекс PASS выполняется `sudo python3 /root/fh_oauth_owner_canary_switch_v2.py --provider vk`. Тестируется `/api/auth/oauth/vk/start`, связка `state` + `device_id`, токен/профиль, запрет конфликта чужой identity, logout. Скрипт не изменяет параметры VK-регистрации.

## Неподтверждённые релизные условия

Проверки с `httpx.MockTransport`/синтетическими JWKS и существующая зелёная CI **не подтверждают реальный OAuth-вход**. Даже после трёх успешных канареек **не** публиковать login-кнопки без exact-SHA CI, финальной security-приёмки, свежего backup реальной SQLite, проверенной миграции, публичной маршрутизации, PWA smoke и возможности отката. Не нарушать отдельную security-задачу публичной email-регистрации #51 и не включать финансовую синхронизацию #7.

Итоговый статус до живых входов: Google/Яндекс/VK **NOT_RUN**, Telegram **HOLD/FAIL**, production **DISABLED**, PR #11 **Draft**, Issue #9 **OPEN**.
