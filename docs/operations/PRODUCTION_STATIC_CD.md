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
6. Локальный HTTPS smoke через Caddy проверяет exact SHA, HTML,
   Service Worker, manifest, активность Caddy и auth-сервиса.
   При ошибке автоматически восстанавливается старый `current`.
   После PASS создаётся root-only квитанция в
   `/var/lib/fh-static-deploy/`. Данные пользователей не затрагиваются.

Автоматический запуск **по умолчанию выключен**. Он разрешён только
если repository variable `FH_STATIC_AUTO_DEPLOY_ENABLED=true` и оба
CI успешны. До этого доступен ручной `workflow_dispatch` с точным SHA.

## Однократная установка на VPS

Нужен один авторизованный root-сеанс, **не обязательно Commander**.
GitHub Actions не может сам создать первоначальный доверенный канал.

До изменения VPS убедиться, что:
- `/srv/www/fin-horizon` и `releases` - настоящие root-owned каталоги
  без прав записи для группы/остальных;
- `current` - symlink на непосредственный каталог `releases/<sha>`,
  файлы `index.html` и `sw.js` существуют;
- `caddy.service` и `fh-email-auth.service` активны, HTTPS через
  `127.0.0.1:443` и SNI `fin-horizon.mikemoore.top` доступен.
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
