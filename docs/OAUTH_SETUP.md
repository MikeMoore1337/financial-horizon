# Financial Horizon #9 - регистрация OAuth клиентов

Владелец зарегистрировал отдельные OAuth-приложения Financial Horizon для
Telegram, Google, Яндекс ID и VK ID. Наличие соответствующих учётных данных
в защищённом серверном окружении проверено **без вывода их значений**.
Реальная авторизация и client token exchange ещё НЕ подтверждены, а все
production-флаги остаются OFF. Ниже только публичные параметры; секреты
нельзя отправлять в чат, GitHub, CI или переносить из YFC.

Общий HTTPS origin: https://fin-horizon.mikemoore.top
Backend: существующий FastAPI email-auth, одна SQLite auth.sqlite3.

| Провайдер | Тип клиента и scope | Точный Redirect URI |
| --- | --- | --- |
| Telegram | BotFather Login Widget, OIDC Authorization Code + PKCE S256, openid | https://fin-horizon.mikemoore.top/api/auth/oauth/telegram/callback |
| Google | Google Cloud Web application, OIDC Code + PKCE S256, openid | https://fin-horizon.mikemoore.top/api/auth/oauth/google/callback |
| Яндекс | Yandex OAuth web app, Code + PKCE S256, login:info | https://fin-horizon.mikemoore.top/api/auth/oauth/yandex/callback |
| VK ID | VK ID Web application, OAuth 2.1 + PKCE S256, пустой scope | https://fin-horizon.mikemoore.top/api/auth/oauth/vk/callback |

## Telegram
В @BotFather создать отдельного бота для Financial Horizon.
Открыть Login Widget, разрешить сайт
https://fin-horizon.mikemoore.top и полный callback URI выше.
Полученные Client ID и Client Secret хранить только на сервере
в FH_TELEGRAM_OAUTH_CLIENT_ID / FH_TELEGRAM_OAUTH_CLIENT_SECRET.
Использовать RSA RS256 (значение по умолчанию) либо ES256:
текущий верификатор не включает EdDSA/ES256K.
Проверяются signature, issuer, audience, exp, nonce, subject.
Официально: https://core.telegram.org/bots/telegram-login

## Google
Создать отдельный проект и OAuth Client типа Web application в
Google Cloud Console, настроить OAuth consent screen, test users и
Authorized redirect URI выше. Authorized origin при необходимости:
https://fin-horizon.mikemoore.top
Задать FH_GOOGLE_OAUTH_CLIENT_ID / FH_GOOGLE_OAUTH_CLIENT_SECRET.
Проверяются issuer, audience, azp, nonce, exp, iat, JWKS signature.
Официально: https://developers.google.com/identity/openid-connect/openid-connect

## Яндекс ID
Создать OAuth приложение в https://oauth.yandex.ru/client/new/
с полным redirect URI выше. Требуется только право login:info.
Секретные поля FH_YANDEX_OAUTH_CLIENT_ID / FH_YANDEX_OAUTH_CLIENT_SECRET.
Сервер меняет code на token и запрашивает стабильный id из
https://login.yandex.ru/info?format=json без хранения профиля.
Официально: https://yandex.ru/dev/id/doc/ru/codes/code-url

## VK ID
В кабинете подключения VK ID создать отдельное веб-приложение с
редиректом выше; FH_VK_OAUTH_CLIENT_ID - свой APP_ID, без YFC.
VK использует code, state и device_id в callback, PKCE S256 и
POST к https://id.vk.ru/oauth2/auth, затем
https://id.vk.ru/oauth2/user_info с полученным access token.
Требуется подтвердить реальный GET callback и возврат из VK app;
POST callback не считать проверенным без браузерного E2E.
Официальная реализация: https://github.com/VKCOM/vkid-web-sdk

## Требования к активации

1. Сервер: secure env с FH_EMAIL_AUTH_ENABLED=true,
   FH_ENABLE_CLOUD_AUTH=true и собственным FH_SESSION_SECRET
   (не меньше 32 случайных символов). Содержимое переменных не логировать.
2. Все FH_TELEGRAM_OAUTH_ENABLED, FH_GOOGLE_OAUTH_ENABLED,
   FH_YANDEX_OAUTH_ENABLED, FH_VK_OAUTH_ENABLED остаются false
   до независимой проверки каждого реального клиента.
3. База: только FH_AUTH_DATABASE_PATH, без второй OAuth SQLite.
   Отдельно остановить сервис, создать root-only backup,
   выполнить и проверить миграцию согласно backend/README.md.
4. Отдельно разрешить Caddy маршруты /api/auth/oauth/* и
   /api/auth/providers на существующий FastAPI сервис.
   Не открывать публичную email-регистрацию в обход Issue #51.
5. После зелёных tests/CI, независимой security проверки и
   реального входа с четырьмя отдельными OAuth приложениями:
   физический Safari PWA, Chrome/Edge, вход, привязка, IDOR, logout,
   revoke-others, 2 аккаунта и гостевой IndexedDB.
6. Готовить отдельный откат и точный deployed SHA; feature flags
   включаются только для провайдеров, прошедших все проверки.

Пока подтверждение отсутствует, production = DISABLED для всех.
Никакой синхронизации финансов или переноса IndexedDB по этому Issue.
