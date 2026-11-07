# Financial Horizon #9 - production readiness and independent acceptance

Дата read-only инфраструктурного осмотра: 2026-11-07. **NO_GO для активации OAuth.** Это документ технической готовности, не квитанция деплоя или реального входа. Секреты не сохранялись в GitHub.

## Подтверждено на живом VPS (без изменения активного сервиса)

- Сервис `fh-email-auth.service` active, запускается отдельным пользователем `fh-email-auth`.
- Используется существующая **отдельная от YFC** email-auth SQLite в приватном каталоге mode 0700, без символьных ссылок; файл mode 0600.
- Проверка текущей таблицы `users`: ожидаемые 7 колонок, `email NOT NULL`, нет пользовательских индексов/триггеров для `users`, `PRAGMA foreign_key_check` без ошибок, журнал SQLite WAL.
- Защищённый staging-файл `/etc/financial-horizon/oauth.env` принадлежит root:root, mode 0600. Поля client ID/secret для Telegram, Google, Яндекс ID и VK ID (у VK ID только client ID) присутствуют; **не проверялись реальные OAuth credentials в провайдере**.
- Для этого приложения сформирован отдельный случайный `FH_SESSION_SECRET` (не от YFC); значение никогда не выводилось.
- `FH_ENABLE_CLOUD_AUTH=false` и четыре `FH_<PROVIDER>_OAUTH_ENABLED=false`. Этот staging env **не подключён** к работающему systemd service. `/api/auth/providers` и `/api/auth/oauth/*` **не добавлены** в Caddy.
- Uvicorn выполняется с `--no-access-log`, поэтому OAuth `code`/ `state` не должны попадать в access log Uvicorn. Для будущего публичного callback дополнительно проверить все уровни reverse proxy и ошибок.

### Почему сейчас нельзя просто включить флаги

Production `users.email` по-прежнему `NOT NULL`; OAuth-only создание пользователя невозможно до явной проверенной offline-миграции. Caddy разрешает сейчас только email-auth каналы, отдельного OAuth маршрута нет. Настоящий вход четырёх провайдеров, независимый неавторский AppSec-review и физическая приёмка мобильного PWA не проводились. Подстановка credentials из YFC запрещена.

## Фактические ворота перед публичным включением

1. Точный HEAD PR #11 без конфликтов с актуальным main; все обязательные checks зелёные, включая PWA/IndexedDB, frontend, backend и CodeQL.
2. Независимый AppSec-review **другим проверяющим**, не разработчиком PR. Проверить auth state + marker, nonce/PKCE, JWKS/iss/aud/azp/exp, rate limiting, cookie CSRF, account linking и расхождения email/OAuth, reverse proxy, запросы с поддельными заголовками, сохранность секретов.
3. Отдельный приватный SQLite backup с проверенным read-only integrity и полноценным восстановлением на **изолированной копии**. Подтвердить операторский откат без потери финансовых записей.
4. В согласованном окне остановить email-auth сервис и выполнить явную миграцию `python -m fh_auth.migrate DB_PATH NEW_BACKUP_PATH` с новым защищённым резервным файлом. Миграция никогда не должна исполняться при старте сервиса. Проверить реальные email-вход, сессии и SQLite foreign keys после миграции.
5. Сервисный user + systemd: подключить staging OAuth env отдельным `EnvironmentFile`, **не** выводя ключи в консоль/журналы. Проверить точный `FH_PUBLIC_URL`, единый путь базы, собственный HMAC-ключ, приватные права доступа и отсутствие ссылок на YFC.
6. Caddy: добавить только необходимые `/api/auth/providers`, `/api/auth/oauth/{provider}/start`, `/api/auth/oauth/{provider}/callback` и авторизованную привязку; не открывать email регистрацию в обход Issue #51. Проверить Host, HTTPS redirect, Origin на link POST, rate limit и выключенные access logs на callback. До `reload` сохранить Caddy backup и выполнить `caddy validate`.
7. Провести проверку четырех независимых клиентов Financial Horizon через **настоящие** Telegram, Google, Яндекс ID и VK ID: browser redirect -> cookie -> единый user_id -> logout/revocation -> повторный вход. У VK отдельно проверить `device_id` и реальный callback format; для Яндекс - минимальный scope. Тестовые JWKS и synthetic flows сюда не засчитывать.
8. Проверить привязку к существующему email аккаунту, конфликт одной identity на двух user IDs, отсутствие автоматического объединения по email, реальную PWA на iPhone и desktop, сохранность IndexedDB, гостя и светлой/тёмной темы.
9. Включать production-флаг **по одному провайдеру** только после его browser+security PASS. Не показывать кнопку с неподтверждённым провайдером. Зафиксировать точный deployed SHA, HTTP canary и rollback.

## План безопасного отката

При регрессии сначала **выключить флаги** OAuth и вернуть прежнее маршрутизирование Caddy без изменения/удаления базы. Новая nullable схема email после миграции совместима с работой существующего email-auth кода; её необязательно откатывать для выключения OAuth. Восстанавливать старый файл SQLite только после анализа данных, появившихся после миграции: **слепое восстановление предрелизного backup удалит новые OAuth-аккаунты и сессии**.

Запрещено: печатать секреты, выполнять автоматическую миграцию по флагу, копировать YFC credentials, синхронизировать/переносить финансовую IndexedDB без отдельного протокола #7, считать CI или синтетический IdP полноценной реальной авторизацией.

## Замечания в ходе Security QA

- OAuth-only пользователь с `email=NULL` не имеет пароля для email-change. Прямой запрос `/api/auth/email/change/request` должен возвращать HTTP 403 (не HTTP 500) до расчёта email-квоты. Добавлен отдельный отрицательный интеграционный тест.
- Для API `/api/auth/providers` отсутствие настроенных флагов должно означать пустые разрешённые провайдеры; веб-интерфейс варианта C скрывает все кнопки без подтверждения backend.
- Ни один собственный кодовый/self-review или сканер не считается независимым подписанным AppSec-review.

Связанные задачи: #9, #51, #7. Родственные изменения React, финансовых данных, платежей и миграций других Issue в этом документе не утверждаются.
