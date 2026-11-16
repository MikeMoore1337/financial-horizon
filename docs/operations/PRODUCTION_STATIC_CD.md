# Financial Horizon - production static CD

Статус: **не активировано на VPS** до первичной операторской установки.
Механизм публикует только собранный каталог `dist/`, не меняет Caddy,
SQLite, PostgreSQL, OAuth, FastAPI, секреты и финансовые миграции.

## Путь выпуска

1. Push в `main` запускает `tests.yml` и `security-vault.yml`.
   Оба должны быть SUCCESS для **одного exact SHA**. При событии `push` используется `github.sha` после проверки
   актуального `main`; при ручном запуске SHA обязан совпасть с выбранным
   коммитом `main`.
2. `production-deploy.yml` сверяет текущий main, оба CI, собирает Vite
   из точного SHA в отдельном GitHub-hosted runner **без production secrets**.
   Артефакт - только `dist` с `__release.json` и SHA-256.
3. Другое задание с environment `production-static` получает только
   архив из **того же workflow run**, проверяет digest и отправляет
   по SSH. Оно не запускает код из checkout или npm с секретами.
4. На VPS предварительно установленный root-owned обработчик
   `/usr/local/sbin/fh-main-deploy` принимает только команду
   `deploy <40hex-sha> <64hex-sha256>`. SSH forced-command и sudoers
   ограничивают права; произвольный shell запрещён.
5. Архив валидируется (только обычные файлы и каталоги под `dist/`,
   запрет symlink/path traversal, ограничение размеров, проверка
   manifest и SHA), распаковывается в `releases/<sha>`, затем
   атомарно переключается `current`.
6. Локальный HTTPS smoke через Caddy на порту `8444` с доверенным
   Cloudflare Origin CA (не через Xray на `:443`) проверяет exact SHA, HTML,
   Service Worker, manifest, активность Caddy и auth-сервиса.
   При ошибке автоматически восстанавливается старый `current`.
   После PASS создаётся root-only квитанция в
   `/var/lib/fh-static-deploy/`. Данные пользователей не затрагиваются.

Автоматический запуск **по умолчанию выключен**. Он разрешён только
если repository variable `FH_STATIC_AUTO_DEPLOY_ENABLED=true` и оба
CI успешны. До этого доступен ручной `workflow_dispatch` с точным SHA.

## Реальная origin TLS-топология (проверена владельцем 09.11.2026)

- Публичный `https://fin-horizon.mikemoore.top/` через Cloudflare: HTTP 200.
- `127.0.0.1:443` принадлежит **Xray**, возвращает HTTP 403.
  Его нельзя использовать для проверки приложения, менять Xray не нужно.
- Caddy слушает `:8444` (HTTPS), `:80` (редирект HTTP 308)
  и локальный `:2019` (административный интерфейс).
- `curl --resolve fin-horizon.mikemoore.top:8444:127.0.0.1` без
  `--cacert` завершается `EXIT=60 TLS=20`, поскольку Caddy выдаёт
  **Cloudflare Origin CA**, не входящий в обычные доверенные CA клиента.
  Диагностический `--insecure` подтвердил HTTP 200, но **запрещён**
  в рабочем release smoke.

Исправленный обработчик подключается только к локальному Caddy `:8444`,
проверяет TLS **с SAN имени хоста и сроком действия** через `--cacert`
и отдельный root-owned Cloudflare Origin RSA trust anchor. Публичный
сертификат взят из официального репозитория
[Cloudflare Docs](https://github.com/cloudflare/cloudflare-docs/blob/production/public/ssl/static/origin_ca_rsa_root.pem)
и сохранён в `deploy/certs/cloudflare-origin-rsa-root.pem`.
SHA-256 файла:

```text
91a8a5567efa6bf941162aa806b3ba476aaddf7867640e53053b35fb225a5dae
```

Установщик проверяет digest до изменения сервера, проверяет origin
HTTPS настоящим `curl --cacert` и копирует только этот публичный
сертификат в `/usr/local/lib/financial-horizon/certs/cloudflare-origin-rsa-root.pem`.
Системное хранилище CA не меняется. Обработчик до релиза проверяет права
root, запрет symlink и SHA-256. Ошибки сертификата блокируют релиз и откат
не отключает проверки TLS.

**Проверка без установки** из checkout актуального одобренного commit:

```bash
curl --noproxy '*' --silent --show-error --fail \
  --cacert deploy/certs/cloudflare-origin-rsa-root.pem \
  --resolve fin-horizon.mikemoore.top:8444:127.0.0.1 \
  --output /dev/null --write-out 'HTTPS_ORIGIN=%{http_code} TLS=%{ssl_verify_result}\n' \
  https://fin-horizon.mikemoore.top:8444/index.html
```

Ожидается `HTTPS_ORIGIN=200 TLS=0`. Ни пароль, ни сертификат с приватным
ключом для проверки не нужны.

Публичный Cloudflare Origin RSA root имеет срок действия до **15.08.2029**,
хотя текущий leaf сертификат выдан до 2041 года. Заблаговременно
заменить trust root / origin certificate по отдельной процедуре ротации,
иначе после истечения CA проверка перестанет проходить.

## Однократная установка на VPS

Нужен один авторизованный root-сеанс, **не обязательно Commander**.
GitHub Actions не может сам создать первоначальный доверенный канал.

До изменения VPS убедиться, что:
- `/srv/www/fin-horizon` и `releases` - настоящие root-owned каталоги
  без прав записи для группы/остальных;
- `current` - symlink на непосредственный каталог `releases/<sha>`,
  файлы `index.html` и `sw.js` существуют;
- `caddy.service` и `fh-email-auth.service` активны, HTTPS Caddy через
  `127.0.0.1:8444` с SNI `fin-horizon.mikemoore.top` и pinned
  Cloudflare Origin CA даёт 200 без `--insecure`.
  Если layout отличается, **остановиться**, не менять права вслепую.

Сгенерировать **отдельный FH ED25519 ключ** и независимо сверить SHA-256
двух файлов из проверенного checkout точного commit. Установщик сам
проверяет оба digest до каких-либо изменений:

```bash
sudo bash deploy/provision-fh-static-deploy.sh \
  --initial-setup "REVIEWED_HANDLER_SHA256" \
  "REVIEWED_INSTALLER_SHA256" < /root/fh-deploy-key.pub
```

Должно быть: `FH_PROVISION_STATUS=PASS` и `LIVE_DATA_UNCHANGED=YES`.
Проверить root ownership обработчика и отказ от чужой SSH-команды.
При частичной ошибке нельзя запускать установку повторно вслепую:
сначала проверить пользователя `fh-deploy`, каталоги
`/var/lib/fh-deploy-ssh`, `/var/lib/fh-static-deploy`, обработчик
`/usr/local/sbin/fh-main-deploy` и sudoers.

## Предварительная проверка SSH из GitHub Actions (без деплоя)

После создания GitHub Environment `production-static` и четырёх
Environment Secrets выполните **сначала** отдельный
[Financial Horizon restricted SSH preflight](https://github.com/MikeMoore1337/financial-horizon/actions/workflows/fh-static-ssh-preflight.yml):
`Run workflow` в ветке `main`. Workflow ничего не загружает, не выполняет
`git checkout` и не переключает `current`; он выполняет только
намеренно запрещённую команду `whoami` через restricted SSH.
Точный ED25519 host fingerprint и `known_hosts` проверяются до подключения.
Только ответ `FH_DEPLOY_FAILED=COMMAND_REJECTED` с SSH exit 1 считается PASS.

Ожидаются: `SSH_HOST_IDENTITY=PASS`, `SSH_AUTHENTICATION=PASS`,
`SSH_FORCED_COMMAND_DENIAL=PASS`, `SSH_PREFLIGHT=PASS`,
`PRODUCTION_DEPLOY_PERFORMED=NO`.
Если результат иной, **не** запускайте production-deploy workflow:
проверяйте SSH connectivity, ключи и firewall, не ослабляя защиту.

**Перед первым настоящим релизом** сравните текущую установленную на
VPS версию с `main`. На 09.11.2026 последний operator-preflight указывал
`1e536fff97cfde9698924d01cf3bd6a666afeb7a`, а GitHub `main` =
`a9fa2e85aeda92b26da4d88cdc4f429fda914dd5`, то есть разница
**220 коммитов**. Первый ручной деплой является **кумулятивным релизом**,
а не проверкой одной строки. Требуется независимая приёмка именно
этого набора изменений, возможность восстановления предыдущей PWA/IndexedDB
и управляемое окно выпуска. Нельзя использовать первый real deploy
вместо безвредного SSH-пробника.

## Environment и Secrets

Создать в GitHub `Settings → Environments → production-static`,
разрешить доставки **только из main**, без pull request refs и тегов.
Добавить **environment secrets**:

| Secret | Содержание |
| --- | --- |
| `FH_DEPLOY_KEY` | приватный ключ только для FH |
| `FH_DEPLOY_TARGET` | `fh-deploy@VPS_HOST` |
| `FH_DEPLOY_PORT` | SSH порт |
| `FH_DEPLOY_KNOWN_HOSTS` | независимо проверенный pinned host key |

Не копировать ключи Hermes/YFC, не публиковать секреты в GitHub или чате.
Не доверять серверному ключу только по слепому `ssh-keyscan`.

Первый релиз: `Actions → Financial Horizon production static deploy →
Run workflow`, выбрать `main` и передать точный `release_sha`.
Проверить `PRODUCTION_DEPLOYED=<sha>` или `ALREADY_DEPLOYED=<sha>`,
внешний HTTPS, `__release.json`, PWA, IndexedDB, логин, обе темы,
Service Worker и возможность восстановить предыдущую версию.

**Только после полноценной приёмки** включить repository variable
`FH_STATIC_AUTO_DEPLOY_ENABLED=true` в Settings → Secrets and variables
→ Actions → Variables.

## Пределы

При неудачном локальном smoke сервер автоматически возвращает старый
symlink. При сетевом обрыве после успеха нужно вручную сверить
root-only receipt; внешний пользовательский smoke не заменён
локальным HTTPS-запросом. Старые релизы не удаляются автоматически.
Есть небольшое окно гонки между финальной GitHub-проверкой main и SSH;
критические выпуски нужно проводить с замороженным merge.

**Не использовать статическую доставку** для FastAPI, PostgreSQL,
OAuth, шифрования старых IndexedDB и операций с реальными финансами.
Для них нужны отдельные разрешения, backup/restore, миграционные
ворота, независимая безопасность и проверка rollback.

Локальные тесты:

```bash
python3 -m unittest discover -s tests/deploy -p 'test_*.py' -v
bash -n deploy/provision-fh-static-deploy.sh
python3 -m py_compile deploy/fh_static_deploy.py
```
