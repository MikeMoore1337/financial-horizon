# Авторизация Financial Horizon: повторное использование паттернов YFC

**Статус:** архитектурная подготовка, а не рабочий OAuth. По умолчанию production Financial Horizon остаётся гостевой local-first PWA без сервера авторизации. Ни один провайдер входа этим документом не включается.

## Требование владельца

В Financial Horizon должны быть самостоятельные способы входа: **Telegram, Google, Яндекс ID, VK ID, email/password**, плюс «Продолжить без регистрации». **Не требуется «Войти через YFC», общие пользователи и сессии YFC не создаются.**

Задачи: [социальные провайдеры #9](https://github.com/MikeMoore1337/financial-horizon/issues/9), [email/password #8](https://github.com/MikeMoore1337/financial-horizon/issues/8), [БД/синхронизация #7](https://github.com/MikeMoore1337/financial-horizon/issues/7).

## Что переносится из YFC

Для анализа исходников закреплён проверенный SHA YFC `0937ce09f9e199539c78b6558fc205f79548e246` (`master`).

| Источник YFC | Повторное использование |
| --- | --- |
| `backend/fitminiapp_api/services/oauth_login.py` | Адаптеры Authlib для Google и Telegram OIDC, Yandex OAuth/PKCE, VK ID OAuth 2.1/PKCE. Оставить только необходимые маршруты и собственную проверку provider subject. |
| `backend/fitminiapp_api/services/oauth_transactions.py` | Серверные одноразовые OAuth-транзакции, PKCE verifier/nonce/state/TTL. Запрещены stale/replayed callbacks. |
| `backend/fitminiapp_api/api/v1/auth.py` | Безопасная структура start/callback, ограничения частоты и обработка ошибок без выдачи чужих сессий. |
| `backend/fitminiapp_api/models/auth_identity.py`, `services/auth_identities.py` | `(provider, subject)` как уникальная идентичность, без автоматического объединения по email. |
| `frontend/src/features/auth/OAuthButtons.tsx`, `pages/auth/LoginPage.tsx` | Тексты, стиль кнопок, иконки, состояния загрузки. Нынешний Financial Horizon использует обычный JS/PWA, поэтому нельзя просто вставить React-компонент без зависимостей. |
| `services/password_auth.py`, `services/auth_email.py` | Валидация паролей, проверенная Argon2id-библиотека, подтверждение email, сброс пароля. |

Исходники YFC служат **референсом для аудируемого переноса**, а не разрешением копировать весь монолит. При переносе соблюдать зависимости, лицензии, тесты и актуальные версии библиотек; проверить регрессии обеих систем.

## Конфигурация и секреты

Список безопасных имён переменных подготовлен в [deploy/.env.example](../deploy/.env.example). **Никаких секретных значений в нём нет**. Файл не используется статическим приложением до реализации серверного режима.

Нельзя копировать фактический YFC `.env`, session key, `refresh_cookie`, Telegram bot token, OAuth client secrets, SMTP credentials или пользовательскую БД в Financial Horizon. Не отправлять их в чат, Issue, PR и логи.

Регистрация **собственных OAuth-приложений** у провайдеров предпочтительнее: это изолирует скомпрометированные секреты и ротацию. Дополнительный `redirect_uri` в прежнем приложении допускается только при подтверждённой поддержке провайдером и отдельной оценке рисков; такое переиспользование не означает общий аккаунт YFC и не даёт доступа к данным YFC.

Для Telegram использовать проверенный OIDC Web Login поток, если поддерживаемая версия и условия аккаунта подтверждены. **Не путать** Telegram OIDC с Mini App `initData` или старым Login Widget: это разные схемы верификации.

Предлагаемые callback URI после отдельной реализации:
- `https://fin-horizon.mikemoore.top/api/auth/oauth/telegram/callback`
- `https://fin-horizon.mikemoore.top/api/auth/oauth/google/callback`
- `https://fin-horizon.mikemoore.top/api/auth/oauth/yandex/callback`
- `https://fin-horizon.mikemoore.top/api/auth/oauth/vk/callback`

Зарегистрировать адреса точно в кабинете каждого провайдера. URI выше **пока не существуют** на работающем сайте.

## Защита данных и сессий

- Облачная авторизация опциональна: анонимный профиль в IndexedDB доступен без регистрации и офлайн.
- После логина отдельный сервер Financial Horizon выпускает собственную `Secure HttpOnly SameSite`-сессию. Ни JWT, ни refresh token стороннего провайдера нельзя сохранять в `localStorage`.
- OIDC/OAuth: одноразовый state, PKCE S256, nonce для OIDC, точные callback URI, server-side token exchange, проверка issuer/audience/subject/expiry; защита от callback mix-up и OAuth replay.
- Для локального email/password - проверенная Argon2id реализация, подтверждение email, reset tokens с TTL, Cloudflare Turnstile с server-side Siteverify и rate limits/квоты; CAPTCHA одна не заменяет ограничения.
- Никогда не объединять аккаунты только потому, что совпал email у провайдеров. Связывать идентичности только из подтверждённой авторизованной сессии с повторной проверкой провайдера.
- Обычный OAuth-провайдер получает только данные авторизации, **не финансовые суммы**. Сервер Финансового горизонта должен отделять финансовые snapshots от identity и по возможности хранить E2EE ciphertext, см. #7.
- Перед облачной синхронизацией - шифрованная локальная резервная копия, сравнение версий, подтверждение переноса, разрешение конфликтов без silent overwrite.

## Этапы поставки

1. Утвердить модель данных профиля, providers и guest-to-cloud migration; тесты tenant isolation.
2. Создать минимальный независимый backend только в staging, конфиг и миграции, без production-секретов.
3. Реализовать и испытать каждый провайдер по отдельности, без неработающих кнопок в production.
4. Реализовать email/password, антиспам и безопасный account-linking; независимый security review.
5. Подключить E2EE-синхронизацию и автоматические тесты двух пользователей/устройств, восстановление и rollback.
6. Отдельное решение о включении production облачного режима; текущая PWA не изменяется до приёмки.

## Состояние на 2026-11-05

Это **документация и шаблон**. OAuth-сессии, серверная БД, регистрация и вход через провайдеров **ещё не внедрены**. Никакие реальные значения `.env` YFC не читались и не копировались.
