# Financial Horizon #9 - повторный собственный security-аудит OAuth

**Дата:** 2026-11-07. **Тип:** adversarial self-review / локальные негативные тесты. **Не является независимым ревью другого разработчика.** Код: PR #11, текущая ветка `feat/independent-social-auth`, включая последние изменения React из main. Секреты и пользовательские данные не извлекались.

## Trust boundaries и защищаемые ресурсы

- Browser/PWA → FastAPI по HTTPS через Caddy: cookie `fh_email_session` (Secure, HttpOnly, SameSite=Lax, path `/api/auth`), Origin/Host, отсутствие CORS для внешних сайтов. Публичный API не предоставляет финансовые данные.
- FastAPI → Telegram/Google/Яндекс/VK: только заранее заданные TLS endpoints, Authorization Code и PKCE (Telegram, Google, Яндекс - `S256`; VK ID - `s256` согласно официальному SDK). Google требует `openid profile`, но FH игнорирует личные поля и не запрашивает email.
- IdP → browser callback: state/nonce/verifier хранит только сервер, marker HttpOnly привязан к браузеру; запрет подмены, replay и неоднозначного разбора полей.
- FastAPI ↔ private SQLite: стабильный `users.id`, уникальные `oauth_identities(provider,subject)` и `(user_id,provider)`, общие с email сервера сессии. Ни YFC, ни финансовая IndexedDB сюда не подключаются.
- Операционная граница: отдельные client ID/secret в root-only env, не в GitHub, не в URL ответа, не в логах.

## Выявленные и исправленные проблемы в этом проходе

| Важность | Проблема | Исправление / проверка |
| --- | --- | --- |
| MEDIUM | В callback через GET отсутствовал общий бюджет длины query string, можно передавать много дополнительных параметров | `_MAX_CALLBACK_BYTES=8192`, `_MAX_CALLBACK_PARAMETERS=32`, отказ до state claim; pytest на длинный GET и 40 параметров |
| MEDIUM | JSON `payload` VK допускал повторяющиеся ключи, которые некоторые парсеры интерпретируют неодинаково | Строгий `object_pairs_hook`, отказ при дубликатах на любом уровне; pytest с повторным `state`, затем корректный callback |
| MEDIUM | POST callback читал тело целиком до проверки размера и не учитывал combined query+body | Проверка Content-Length и побайтовый бюджет `request.stream()`; тесты обычного и потокового POST |
| LOW | Очень длинный десятичный Content-Length мог приводить к исключению парсера целых вместо 400 | Ограничение длины числового заголовка до 10 цифр; тест 4500-значного числа |
| TEST | Реальный HTTP loopback pytest использовал фиксированный порт 8791 и конфликтовал с параллельными проверками браузера | Выдача порта ОС (`bind(...,0)`), без изменения публичного origin, PKCE и cookie policy |

В этих негативных тестах **отклонение недопустимого ответа не расходует действующий одноразовый state**, так что нормальный пользователь может продолжить авторизацию. Никакие реальные IdP токены для проверки не использовались.

## Проверка существующих защит

| Защита | Основание | Статус |
| --- | --- | --- |
| Случайные одноразовые state/marker, TTL, replay | `fh_auth.app` / `OAuthStore.begin/claim/finish`, negative pytest | PASS - синтетически |
| PKCE S256 (VK ID `s256`), nonce для OIDC, allowlisted provider URLs | `providers.py`, `exchange.py`, тесты JWKS/PKCE | PASS - синтетически |
| JWT signature, alg allowlist, issuer/audience/azp/exp/iat/nonce | `verify_oidc` и тестовые RSA/JWKS | PASS - синтетически |
| VK state и device_id | сравнение state после token exchange, корректный `device_id` обязателен | PASS - синтетически |
| Строгое explicit linking из действующей сессии, Origin+confirm | `link/start`, `complete_link`, тесты конфликтов/CSRF | PASS - синтетически |
| Нет авто-слияния по email, стабильный user_id, logout/revoke | OAuthStore, email AuthStore, реальные FastAPI/SQLite+cookie тесты | PASS - локально |
| OAuth-only `email=NULL` не активирует парольную смену email | HTTP 403 из `fh_email_auth/app.py` | PASS - локально |
| UI скрывает неподтверждённые провайдеры, guest/IndexedDB не удаляется | Node, Playwright Chromium/WebKit, Vite PWA | PASS - локально |
| Наличие защищённого резервного снимка реальной auth SQLite | root-only backup/restore and off-line clone migration receipts на VPS | PASS - выполнено |
| NPM dependency advisory | `npm audit --audit-level=high` | PASS - 0 уязвимостей |
| Python static check | Bandit `-q -r backend/fh_auth backend/fh_email_auth`; CI CodeQL | PASS - проверка на HEAD обязательна |
| Реальная OAuth-авторизация 4 провайдеров | Нужны настоящие пользовательские интерактивные входы | **NOT_RUN** |
| Физический iOS/desktop установленный PWA | Требуется проверка на реальных устройствах | **NOT_RUN** |
| Независимый security review другого автора | Пользователь поручил выполнить самостоятельно; внешнего ревьюера нет | **NOT_RUN (self-review, не подмена)** |
| Развёртывание public routes, prod auth migration, включение флагов | Live Caddy/SMTP/SQLite review; **не** опубликовано | **NOT_RUN** |

## Неустранённые релизные риски

1. **HIGH / внешний:** действительный вход всех четырёх провайдеров, включая callback GET/POST от VK, подтверждение nonce/JWKS и Browser cookie, не доказан. Синтетический обмен не подтверждает согласие у IdP и настройку клиента.
2. **HIGH / эксплуатационный:** все OAuth-флаги на VPS ещё OFF, Caddy не раскрывает публичные OAuth маршруты; production пользователи и сессии должны остаться защищены. Только изолированная SQLite копия мигрирована, живая база `email NOT NULL`.
3. **HIGH / приёмка:** security reviewer - тот же помощник-разработчик, то есть нет независимого non-author подтверждения. Самопроверка не может логически считаться внешней.
4. **MEDIUM / функциональность:** UI для привязки внешнего провайдера из существующей email-сессии ещё не выпущен, хотя защищённый backend link API существует. Нужны визуальная приёмка, проверка CSRF и пользовательского подтверждения до включения привязки.
5. **MEDIUM / прокси:** перед реальным release проверить авторитетный источник клиентского IP, доверенные reverse-proxy headers, отсутствие URI с `code/state` в access logs на каждом уровне и exact-path allowlist Caddy для session/logout.

## Вывод

**Self-review: выполнено с исправлением найденных дефектов и дополнительными security-тестами.** Это повышает качество PR, но не закрывает внешние ворота. До реальных provider logins, production-specific canary, отката, независимого AppSec approval и физической проверки на устройстве: **NO_GO для публичной активации OAuth**, Issue #9 остаётся OPEN, PR #11 Draft.

Дополнительно: официальные источники протоколов (перепроверка): [Telegram Login](https://core.telegram.org/bots/telegram-login), [Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect), [Яндекс OAuth](https://yandex.ru/dev/id/doc/ru/codes/code-url), [VK ID SDK](https://github.com/VKCOM/vkid-web-sdk).
