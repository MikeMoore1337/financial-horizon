# Financial Horizon OAuth - Issue #9

Статус: локальная реализация в PR, все реальные провайдеры отключены.
Это независимые клиенты Financial Horizon, без общих сессий или секретов YFC.

## Единая учётная запись

- Источник пользователей: существующая email SQLite по FH_AUTH_DATABASE_PATH.
- Первичный ID: users.id. Для OAuth-only пользователя email=NULL,
  password_hash пуст, verified_at=NULL. Email-аккаунты сохраняют свои ID.
- Идентичности: oauth_identities, уникальный (provider, subject),
  внешний ключ на users.id. Совпадение email не приводит к объединению.
- Сессии: одна таблица sessions, одна cookie fh_email_session,
  одни маршруты /api/auth/email/me, logout, logout-others, rotate.
- SameSite=Lax у обеих схем входа для top-level OAuth callback.
  Все изменяющие email/account state запросы требуют корректного Origin.
- Новый провайдер привязывается только через подтверждённый POST
  /api/auth/oauth/{provider}/link/start с confirm=true, валидным Origin,
  существующей сессией и одноразовой OAuth-транзакцией. Другому аккаунту
  занятая идентичность не передаётся. При привязке cookie ротируется.
- Для обычного входа текущий сеанс нужно сначала завершить.
- Привязка из интерфейса: после явного согласия отправить same-origin
  POST /api/auth/oauth/{provider}/link/start с JSON {"confirm":true},
  credentials=same-origin и заголовком Origin (браузер добавляет его при
  POST). Сервер вернёт {"authorization_url":"https://..."}, а также
  HttpOnly-маркер. Код интерфейса должен проверить HTTP 200 и разрешённый
  origin провайдера, затем выполнить window.location.assign(authorization_url).
  Нельзя переходить к провайдеру через fetch()-редирект: он упрётся в CORS.
  Этот интерфейс пока не опубликован - нужен макет и approval.

## Миграция схемы: явная, с резервной копией

Исходная email-база имеет ограничение users.email NOT NULL, поэтому
OAuth-only пользователи требуют миграции. Эта миграция НЕ запускается
при старте сервиса и НЕ затрагивает финансовые данные IndexedDB.
При выключенном OAuth email-авторизация действует с прежней схемой.

Перед миграцией: остановить сервис, сделать отдельный root-only backup,
проверить восстановление, затем выполнить с Python path backend:

python -m fh_auth.migrate DATABASE_PATH NEW_PRIVATE_BACKUP_PATH

Например, для защищённой директории:
DATABASE_PATH=/var/lib/financial-horizon/auth.sqlite3
NEW_PRIVATE_BACKUP_PATH=/var/lib/financial-horizon/auth.pre-oauth.20261106.sqlite3

Скрипт создаёт собственный консистентный SQLite backup с правами 0600
и атомарно перестраивает только users.email в nullable.
Отклоняет неизвестную схему, небезопасный каталог, существующий путь backup,
несовпадение числа пользователей и ошибки foreign_key_check/integrity_check.
Заранее проверить откат на копии базы. Не выполнять без согласованного окна.

## Конфигурация

FH_ENABLE_CLOUD_AUTH=false по умолчанию. Дополнительно каждый провайдер
включается отдельно флагом FH_{PROVIDER}_OAUTH_ENABLED=false.
Нужны действующий email-auth сервис, одна база, один origin,
собственный FH_SESSION_SECRET (для OAuth HMAC rate limits)
и собственные client ID / secret для Telegram, Google, Яндекс, VK.
Не задавать отдельную FH_OAUTH_DATABASE_PATH.

Файлы auth-ui.js и backend являются черновой интеграцией.
Публичные страницы пока НЕ импортируют OAuth UI; необходимо сначала
утвердить визуальный макет и проверить реальные OAuth приложения.
Никакой cloud-sync #7 не включается. Публичная email-регистрация
подчиняется security gate #51.

Локальные синтетические проверки:
python -m pip install -r backend/requirements-test.txt
python -m pytest -q backend/tests
node --test tests/*.test.mjs

Отрицательные тесты с тестовыми JWKS/MockTransport не равны
настоящему входу через каждый внешний сервис.

Для настройки OAuth и готовности к релизу: docs/OAUTH_SETUP.md.
