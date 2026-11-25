# Financial Horizon #9 - использование проверенной реализации YFC

Дата сравнительного аудита: 2026-11-07.

## Проверенная исходная ревизия

Источник только для чтения:
[MikeMoore1337/your-fitness-coach](https://github.com/MikeMoore1337/your-fitness-coach/tree/0937ce09f9e199539c78b6558fc205f79548e246)
(`master`, точный SHA `0937ce09f9e199539c78b6558fc205f79548e246`).

Financial Horizon сохраняет отдельную собственную SQLite, `users.id`,
`fh_email_session`, домен, OAuth-клиенты и все производственные секреты.
Данные пользователей YFC, cookie, Telegram bot token, клиентские секреты,
конфигурации VPS и платные сервисы **не переносились**.

| YFC source | Переносимый приём | FH Issue #9 |
| --- | --- | --- |
| `services/oauth_login.py` | Telegram/Google OIDC, Яндекс Code+PKCE, VK ID Code+PKCE и `device_id` | Уже реализовано в `fh_auth/providers.py` и `fh_auth/exchange.py`, без YFC endpoints для аккаунтов |
| `services/oauth_transactions.py` | Одноразовый `state`, TTL, browser marker, purpose=login/link, verifier и nonce | `fh_auth/store.py` содержит собственные SQLite-транзакции |
| `models/auth_identity.py`, `services/auth_identities.py` | Уникальность пары `(provider,subject)` **и** пары `(user_id,provider)`; запрет конфликта при привязке | Добавлен уникальный индекс `oauth_identities_one_provider_per_user`; тест на попытку вторичного link и сохранение первой сессии |
| `services/auth_redirects.py`, `api/v1/auth.py` | Константные callback paths и обобщённые ошибки без кодов/токенов | FH использует строго `/api/auth/oauth/{provider}/callback` и безопасные локальные редиректы |
| `frontend/src/features/auth/OAuthButtons.tsx` | Порядок Telegram, Google, Яндекс, VK; вывод кнопок только настроенных провайдеров | `auth-ui.js` сохраняет порядок; его адаптер подключён к `account.html` по утверждённому варианту C, но server feature flag OFF |
| `backend/tests/test_vk_oauth.py` | Проверять повторный/wrong `state`, отсутствие `device_id`, JSON payload и конфликт идентичностей | Синтетические тесты `test_provider_exchange.py` / `test_social_auth.py` |
| `backend/tests/test_telegram_oauth_proxy.py` | Не наследовать окружение proxy, изолировать сетевые ошибки Telegram, не писать прокси-секреты в логи | FH использует `httpx(trust_env=False)`; необходимости копировать сетевой proxy YFC нет |

## Проверки прямой сетевой доступности Hermes VPS

На устройстве с существующими директориями Financial Horizon
выполнены только read-only HTTPS GET через curl с `--noproxy '*'`.
При проверке от 2026-11-07 каждый запрос завершился `curl_exit=0`,
HTTP 200:

- Telegram `/.well-known/openid-configuration`
- Telegram `/.well-known/jwks.json`
- Google `/.well-known/openid-configuration`
- Яндекс `/authorize`
- VK ID `/authorize`

Это свидетельствует только о текущей **доступности публичных
эндпоинтов** и не проверяет зарегистрированный клиент, token exchange,
issuer validation с реальным `id_token`, callback, связь с БД, мобильный
браузер или PWA. Конфигурацию прокси/секреты из YFC не копировать.

## Различия протоколов и уровней доступа

- YFC запрашивает `openid profile` для Telegram и `openid profile email`
  для Google. FH запрашивает `openid` для Telegram, а Google требует
  `openid profile` либо `openid email`; мы выбрали `openid profile`,
  не запрашиваем email и используем только проверенный `sub`.
  Данные Google-профиля не сохраняются; адрес почты не используется для
  автоматического объединения аккаунтов.
- YFC запрашивает `login:info login:email` у Яндекс, FH - `login:info`
  только для стабильного ID. UserInfo запрашивается с заголовком
  `Authorization: OAuth` и проверкой `client_id` собственного FH OAuth-клиента.
- YFC запрашивает `email` у VK; FH не запрашивает e-mail/телефон.
  **Не доказано**, что пустой scope разрешён всем конфигурациям VK:
  реальная OAuth-проверка остаётся обязательной. При несовместимости
  нужно исправлять именно адаптер FH с минимальными правами.
- YFC `oauth_proxy_url` и `telegram_oauth_proxy_url` относятся к
  другому окружению. Отдельные данные и credentials прокси FH
  потребуются только при диагностированном сбое сети.
- В YFC browser сессии используют собственную серверную политику,
  несовместимую с FH email-auth; в FH остаётся единая `fh_email_session`.
- Даже если какой-либо IdP разрешает несколько redirect URI у одного
  клиента, это **не** создаёт независимый OAuth-клиент FH. По текущим
  требованиям нужно зарегистрировать отдельные приложения и получить
  их собственные credentials без передачи их в GitHub или чат.

## Что остаётся заблокировано

`FH_*_OAUTH_ENABLED=false` для всех четырёх провайдеров.
Создание приложений и точные callback URI - см.
[OAUTH_SETUP.md](OAUTH_SETUP.md).
Перед включением обязательны реальные provider browser E2E,
проверенный независимый security reviewer, утверждённый визуальный
макет, подготовленный/проверенный backup и контролируемый production
релиз. Синтетический PASS из YFC не является PASS в Financial Horizon.

См. официальную документацию:

- https://core.telegram.org/bots/telegram-login
- https://developers.google.com/identity/openid-connect/openid-connect
- https://yandex.ru/dev/id/doc/ru/codes/code-url
- https://github.com/VKCOM/vkid-web-sdk
