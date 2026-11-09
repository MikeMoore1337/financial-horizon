# Financial Horizon #9 - production readiness and independent acceptance

## Recovery from post-migration AUTH_READY_TIMEOUT - 2026-11-09

Operator's second release attempt on VPS returned:
`ISOLATED_PYTHON_DEPS=PASS`, `RELEASE_STAGED=PASS`,
`PROTECTED_CONFIG_BACKUPS=CREATED`, `ROLLBACK=PASS`,
`LIVE_DB_SCHEMA_MAY_BE_NULLABLE=YES`, `AUTH_READY_TIMEOUT`.
Therefore the *service/Caddy/static* rollback is confirmed by the operator
receipt, but the independent auth SQLite migration could have persisted.

**Never rerun old release scripts**. Never overwrite the active SQLite with
the previous snapshot: later sessions/accounts may be lost. Before the next
release, require read-only schema, FK and integrity checks. The new guarded
release script accepts the exact expected seven-column `users` schema with
`email NOT NULL` or `email NULLABLE`; when already nullable it outputs
`DB_SCHEMA_MIGRATION=ALREADY_READY` and never repeats the offline migration.
The backend source root is prepended to PYTHONPATH so uvicorn resolves
the new source packages rather than inheriting an older auth package.

Readiness checks still require exact Google/Yandex/VK provider JSON,
Telegram start HTTP 404 and anonymous `/api/auth/email/me`.
On a timeout the operator receives *only fixed categories*:
`AUTH_READY_LAST_REASON`, `AUTH_SERVICE_STILL_ACTIVE`,
`AUTH_RECENT_LOG_CATEGORY`, followed by rollback. This does not reveal
OAuth codes/state, cookies, user IDs, environment secrets or unfiltered logs.

Status: code and operator plan only. No successful production OAuth receipt;
issue #9 OPEN. Public email registration #51 and financial IndexedDB remain
unaffected. The independent security review and real production logout still
need to be verified before closing.

## Live SQLite and staged OAuth environment alignment - 2026-11-08

Operator read-only evidence confirms:
- Live email-auth MainPID has its own FH_AUTH_DATABASE_PATH, matching
  /etc/financial-horizon/email-auth.env; the DB exists and is not the canary.
- File and parent permissions are private, SQLite full integrity and FK checks
  pass, and the users table has the expected seven-column pre-OAuth schema.
- users.email is still NOT NULL; oauth_identities is not created.
- The root-only staged /etc/financial-horizon/oauth.env has **zero**
  FH_AUTH_DATABASE_PATH entries. All four provider flags and global OAuth
  feature flag remain false; Google, Yandex and VK credentials are present.
- Never substitute the template's default SQLite path or the canary SQLite.

**One-blocker repair - bind only the staged env, NOT the live database:**

The operator helper scripts/fh_oauth_bind_live_db.py reads the exact database
path from the active fh-email-auth.service process environment. It verifies
the known SQLite schema/integrity, root-only env permissions, credential presence,
Telegram and every production OAuth flag OFF, and protected backup directory.
On --apply, it writes a unique private 0600 backup of oauth.env and
atomically appends **only** FH_AUTH_DATABASE_PATH using the observed live path.
If the entry differs, flags are enabled, the DB is unexpectedly structured,
or config is ambiguous, it rejects the change. No service restart, schema
change, Caddy reload, or OAuth activation is performed.

Pinned immutable script commit: 0f6a4978df466f3c4d6e2c725ca9ad3599d69479
SHA-256: a3efc4ea3518f223aa13b9fd13abe791ef9c044a52173ad1b3f785d060dc9b93

Operator-only commands on the actual VPS (not an unmapped sandbox):

```bash
sudo curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/MikeMoore1337/financial-horizon/0f6a4978df466f3c4d6e2c725ca9ad3599d69479/scripts/fh_oauth_bind_live_db.py \
  -o /root/fh_oauth_bind_live_db.py
echo 'a3efc4ea3518f223aa13b9fd13abe791ef9c044a52173ad1b3f785d060dc9b93  /root/fh_oauth_bind_live_db.py' | sudo sha256sum --check
sudo chmod 600 /root/fh_oauth_bind_live_db.py
sudo python3 /root/fh_oauth_bind_live_db.py --preflight
# Only after BIND_STATUS=READY_FOR_APPLY:
sudo python3 /root/fh_oauth_bind_live_db.py --apply
```

Expected successful receipt: BIND_STATUS=PASS, OAUTH_DB_KEY_COUNT=1,
OAUTH_DB_MATCH=YES, OAUTH_FLAGS_REMAIN_OFF=YES, TELEGRAM_DISABLED=YES,
ROOT_ONLY_ENV_BACKUP=CREATED, SERVICES_RESTARTED=NO, DATABASE_MIGRATED=NO,
CADDY_CHANGED=NO, SECRETS_PRINTED=NO.

**STOP after binding** until fresh backup/restore, new-schema verification
on a protected copy, offline migration in a release window, exact-HEAD
security review, secure routing, and post-release testing are complete.
No public OAuth buttons have been activated by this staging-only operation.

## Fresh production SQLite snapshot and restore rehearsal - 2026-11-08

Owner confirmed the staged OAuth config binding on live host vps1777112993:
`LIVE_DATABASE_PREFLIGHT=PASS`, `OAUTH_DB_MATCH=YES`, `BIND_STATUS=PASS`,
`ROOT_ONLY_ENV_BACKUP=CREATED`, `OAUTH_FLAGS_REMAIN_OFF=YES`,
`TELEGRAM_DISABLED=YES`, `SERVICES_RESTARTED=NO`, `DATABASE_MIGRATED=NO`,
`CADDY_CHANGED=NO`. This is env-only staging, NOT the live schema migration.

Next approved **non-disruptive** operation: fresh consistent backup +
restore test of existing production auth SQLite. It uses only the database
path discovered from the active `fh-email-auth.service` MainPID, validates
email/OAuth environment agreement, privacy and all OAuth flags OFF, checks
the seven-column pre-OAuth users schema, FK and integrity, and takes an online
SQLite backup into a unique root-only 0600 file in
`/var/backups/financial-horizon/`. A temporary private clone is restored
from that snapshot and validated (full integrity, FK, schema, table counts
and checksum). The clone is removed; the verified backup is retained.
Financial IndexedDB is never accessed and the live SQLite is never written.

Pinned source commit: `01f4a4ea1c24219a3c1bb2ecf3eccea60666c8dc`

SHA-256 script: `081d30981b0e35d309515d28904e049d91a25e95176f0cedfb3c6721a75d5679`

```bash
sudo curl -fsSL \
  https://raw.githubusercontent.com/MikeMoore1337/financial-horizon/01f4a4ea1c24219a3c1bb2ecf3eccea60666c8dc/scripts/fh_oauth_backup_drill.py \
  -o /root/fh_oauth_backup_drill.py
echo '081d30981b0e35d309515d28904e049d91a25e95176f0cedfb3c6721a75d5679  /root/fh_oauth_backup_drill.py' | sudo sha256sum --check
sudo chmod 600 /root/fh_oauth_backup_drill.py
sudo python3 /root/fh_oauth_backup_drill.py --preflight
# Only after BACKUP_STATUS=READY:
sudo python3 /root/fh_oauth_backup_drill.py --backup-drill
```

Expected: `CONSISTENT_BACKUP=CREATED`, `RESTORE_DRILL=PASS`,
`SCHEMA_AND_FK=PASS`, `BACKUP_STATUS=PASS`,
`LIVE_DATABASE_MODIFIED=NO`, `SERVICES_RESTARTED=NO`, `CADDY_CHANGED=NO`.

**Limits**: this proves local snapshot consistency and a read-only restore
but does NOT rehearse the migration script, verify remote/off-host recovery,
test provider logout, enable public OAuth, or approve production rollout.
Still require an off-host protected snapshot, offline migration rehearsal
on a disposable restored copy with exact migration HEAD, and an explicit
operator release gate before changing live SQLite or Caddy.

Дата read-only инфраструктурного осмотра: 2026-11-07. **NO_GO для активации OAuth.** Это документ технической готовности, не квитанция деплоя или реального входа. Секреты не сохранялись в GitHub.

## Подтверждено на живом VPS (без изменения активного сервиса)

- Сервис `fh-email-auth.service` active, запускается отдельным пользователем `fh-email-auth`.
- Используется существующая **отдельная от YFC** email-auth SQLite в приватном каталоге mode 0700, без символьных ссылок; файл mode 0600.
- Проверка текущей таблицы `users`: ожидаемые 7 колонок, `email NOT NULL`, нет пользовательских индексов/триггеров для `users`, `PRAGMA foreign_key_check` без ошибок, журнал SQLite WAL.
- Защищённый staging-файл `/etc/financial-horizon/oauth.env` принадлежит root:root, mode 0600. Поля client ID/secret для Telegram, Google, Яндекс ID и VK ID (у VK ID только client ID) присутствуют; **не проверялись реальные OAuth credentials в провайдере**.
- Для этого приложения сформирован отдельный случайный `FH_SESSION_SECRET` (не от YFC); значение никогда не выводилось.
- `FH_ENABLE_CLOUD_AUTH=false` и четыре `FH_<PROVIDER>_OAUTH_ENABLED=false`. Этот staging env **не подключён** к работающему systemd service. `/api/auth/providers` и `/api/auth/oauth/*` **не добавлены** в Caddy.
- Uvicorn выполняется с `--no-access-log`, поэтому OAuth `code`/ `state` не должны попадать в access log Uvicorn. Для будущего публичного callback дополнительно проверить все уровни reverse proxy и ошибок.

## Проверенный production backup и репетиция миграции - 2026-11-07

**PASS - только резервное копирование и тест на отдельной копии, не production-миграция.**

- На FH VPS создан согласованный с WAL **online SQLite backup** действующей auth-базы с помощью `sqlite3.backup`. Снимок хранится только локально в `/var/backups/financial-horizon/auth-before-issue9-20261107.sqlite3` (каталог `root:root 0700`, файл `root:root 0600`). Его контрольная сумма и техническая квитанция находятся в соседнем приватном `auth-before-issue9-20261107.receipt.json`. Данные и контрольные суммы в GitHub не выгружались.
- До и после копирования проверены `PRAGMA integrity_check`, `PRAGMA foreign_key_check` и совпадение количества записей в значимых таблицах. Исходная auth-база и активный сервис не останавливали и не изменяли.
- Создана изолированная приватная **восстановленная копия реального снимка**, в которой исполнен точный скрипт `backend/fh_auth/migrate.py` из HEAD `79edd84dfd7e22639ea9aa23255218eaf570d458`. Проверены переход `email` в `NULLABLE`, неизменность записей `users`, `sessions`, `actions`, `email_changes`, целостность FK и отдельная резервная копия от оператора миграции.
- На восстановленном экземпляре проверена вставка OAuth-only пользователя с `email=NULL` с последующим `ROLLBACK`; исходные данные снимка сохранены.
- Временные копии базы после PASS удалены. Сохранилась только защищённая исходная резервная копия и техническая квитанция `issue9-recovery-drill-20261107.receipt.json` внутри того же root-only каталога.

**Ограничения:** настоящая production-миграция `users.email` НЕ выполнялась. Для будущего контролируемого релиза нужен **свежий** backup прямо перед остановкой сервиса, поскольку после снимка могут появиться новые аккаунты/сессии. Перед восстановлением старой БД требуется анализ новых данных: слепой откат сотрёт более поздние OAuth-аккаунты. Отдельное независимое AppSec-review и реальные browser-login ещё не выполнены.

### Почему сейчас нельзя просто включить флаги

Production `users.email` по-прежнему `NOT NULL`; OAuth-only создание пользователя невозможно до явной проверенной offline-миграции. Caddy разрешает сейчас только email-auth каналы, отдельного OAuth маршрута нет. Настоящий вход четырёх провайдеров, независимый неавторский AppSec-review и физическая приёмка мобильного PWA не проводились. Подстановка credentials из YFC запрещена.

## Фактические ворота перед публичным включением

1. Точный HEAD PR #11 без конфликтов с актуальным main; все обязательные checks зелёные, включая PWA/IndexedDB, frontend, backend и CodeQL.
2. Независимый AppSec-review **другим проверяющим**, не разработчиком PR. Проверить auth state + marker, nonce/PKCE, JWKS/iss/aud/azp/exp, rate limiting, cookie CSRF, account linking и расхождения email/OAuth, reverse proxy, запросы с поддельными заголовками, сохранность секретов.
3. Отдельный приватный SQLite backup с проверенным read-only integrity и полноценным восстановлением на **изолированной копии**. Подтвердить операторский откат без потери финансовых записей.
4. В согласованном окне остановить email-auth сервис и выполнить явную миграцию `python -m fh_auth.migrate DB_PATH NEW_BACKUP_PATH` с новым защищённым резервным файлом. Миграция никогда не должна исполняться при старте сервиса. Проверить реальные email-вход, сессии и SQLite foreign keys после миграции.
5. Сервисный user + systemd: подключить staging OAuth env отдельным `EnvironmentFile`, **не** выводя ключи в консоль/журналы. Проверить точный `FH_PUBLIC_URL`, единый путь базы, собственный HMAC-ключ, приватные права доступа и отсутствие ссылок на YFC.
6. Caddy: добавить минимальный публичный allowlist: `GET /api/auth/providers`, разрешённые `/api/auth/oauth/*` (start, callback, link/start по защищённому POST), **`GET /api/auth/email/me`, `POST /api/auth/email/logout` и `POST /api/auth/email/logout-others`**. Это необходимые общие маршруты сессий для OAuth-only пользователей и сценария повторного входа после выхода. Существующие `/api/auth/email/config`, `register`, `verify`, `login`, `reset/*`, `change/*` могут оставаться под canary Issue #51; не открывать регистрацию в обход security gate. Выделить exact-path matcher для общих маршрутов **перед** fallback-обработчиком `/api/auth/email/*`. Проверить Host, HTTPS redirect, Origin на изменяющих POST, rate limit и отсутствие access logs с `code/state` на callback. До `reload` сохранить Caddy backup и выполнить `caddy validate`.
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
