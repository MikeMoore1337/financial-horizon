# Financial Horizon #9 - Google, Яндекс ID и VK ID без Telegram

Решение владельца от 2026-11-08: **приостановить Telegram** и поэтапно проверять Google, Яндекс ID, VK ID. Не создавать второй OAuth-модуль. Код Telegram и разбор ошибки остаются в PR #11, но кнопка и endpoint не должны быть активны, пока Telegram не пройдёт отдельную приёмку.

## Область и безопасность

- Публичная email/password-авторизация и гостевой режим остаются без изменений.
- Проводить проверку только в существующей owner-only канарейке `fh-oauth-canary.service` (loopback `127.0.0.1:9139`, отдельная приватная SQLite). **Не** включать публичные флаги из `/etc/financial-horizon/oauth.env` и не мигрировать рабочую базу.
- Действующий Caddy уже ограничивает `/api/auth/providers`, `/api/auth/oauth/*`, `/api/auth/oauth-canary/status` доверенными Cloudflare CIDR и IP владельца. Проверить его перед переключением, а не открывать для всех.
- Скрипт `scripts/fh_oauth_owner_canary_switch.py` не содержит секретов, не читает финансовые данные и не меняет Caddy, production systemd unit или production SQLite. Он проверяет защищённые env-файлы и SQLite, делает `root:root 0600` резервную копию текущего canary env, атомарно переключает **ровно один** провайдер и проверяет HTTP 303 на доверенный адрес. При ошибке пытается восстановить предыдущую конфигурацию и работоспособность.
- Скрипт **не разрешает выбор Telegram**. Внутри канарейки Telegram всегда получает `FH_TELEGRAM_OAUTH_ENABLED=false`; остальные два из трёх провайдеров тоже выключены.
- В реальном браузере использовать новое окно Инкогнито. Canaries и публичный домен имеют общий origin/cookie name, поэтому нельзя тестировать в обычном браузере с существующей email-сессией.

## Этап A - тестируем Google

Команда для авторизованного root-оператора, после проверки SHA-256:

```bash
# Загрузить exact-commit версию скрипта, не использовать moving main:
sudo curl --fail --location --silent --show-error \
  https://raw.githubusercontent.com/MikeMoore1337/financial-horizon/d88346320db20767216c5df9a9c304c4234ac355/scripts/fh_oauth_owner_canary_switch.py \
  -o /root/fh_oauth_owner_canary_switch.py

echo '16ef1a36735823dfc617ab38a4765a18d8a9d1e6a768315b835ee6b0d22c21ba  /root/fh_oauth_owner_canary_switch.py' | sudo sha256sum --check
sudo chmod 600 /root/fh_oauth_owner_canary_switch.py
sudo python3 /root/fh_oauth_owner_canary_switch.py --provider google
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

После реального Google PASS (подтверждённая тестовая серверная сессия, logout/repeat login) оператор выполняет `sudo python3 /root/fh_oauth_owner_canary_switch.py --provider yandex`. Тестируется `/api/auth/oauth/yandex/start`, стабильный `id`, ответный `client_id` именно FH-приложения, корректный logout. Никаких неявных объединений по email.

## Этап C - VK ID

После Яндекс PASS выполняется `sudo python3 /root/fh_oauth_owner_canary_switch.py --provider vk`. Тестируется `/api/auth/oauth/vk/start`, связка `state` + `device_id`, токен/профиль, запрет конфликта чужой identity, logout. Скрипт не изменяет параметры VK-регистрации.

## Неподтверждённые релизные условия

Проверки с `httpx.MockTransport`/синтетическими JWKS и существующая зелёная CI **не подтверждают реальный OAuth-вход**. Даже после трёх успешных канареек **не** публиковать login-кнопки без exact-SHA CI, финальной security-приёмки, свежего backup реальной SQLite, проверенной миграции, публичной маршрутизации, PWA smoke и возможности отката. Не нарушать отдельную security-задачу публичной email-регистрации #51 и не включать финансовую синхронизацию #7.

Итоговый статус до живых входов: Google/Яндекс/VK **NOT_RUN**, Telegram **HOLD/FAIL**, production **DISABLED**, PR #11 **Draft**, Issue #9 **OPEN**.
