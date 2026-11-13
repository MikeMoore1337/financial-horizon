# Financial Horizon - действия владельца на production VPS

Личный пет-проект вместо Excel: отдельный LUKS2-том, offsite VPS, WAL/PITR,
фиксированные RPO/RTO и массовая регистрация не требуются. Кодовая часть
задач #33/#66/#67/#69 в main, публичная активация пока выключена.

ВАЖНО: терминал настоящей Hermes VPS, а не изолированный Docker Hermes Agent.
Не присылайте пароли, содержимое backup, SQLite, токены или закрытые ключи.
Не выполняйте docker compose down -v, mkfs, rm -rf, SQL stamp или изменения
auth SQLite. При любом NO_GO остановитесь, не обходите защиту.

## Шаг 1 - только диагностика (без записи)

Откройте ваш обычный SSH доступ к Hermes VPS и выполните:

    sudo -i
    printf 'HOST='; hostname
    printf 'USER='; id -u
    printf 'DOCKER='; docker --version 2>&1 || true
    printf 'COMPOSE='; docker compose version 2>&1 || true
    printf 'GIT='; git --version 2>&1 || true
    printf 'GPG='; gpg --version 2>&1 | head -n 1
    printf 'PYTHON='; python3 --version 2>&1 || true
    printf 'DISK='; df -h / | tail -n 1
    printf 'CADDY='; systemctl is-active caddy.service 2>&1 || true
    printf 'EMAIL_AUTH='; systemctl is-active fh-email-auth.service 2>&1 || true
    printf 'DB_CONTAINER='; docker ps -a --filter 'name=^/fh-finance-postgres$' --format '{{.Names}} {{.Status}}' 2>&1 || true
    printf 'DB_DIR='; test -e /srv/financial-horizon-finance/pgdata && echo exists || echo absent

Если Docker/Compose/GPG/Python отсутствуют - сообщите это, не пытайтесь
установить неизвестный дистрибутив Docker самостоятельно.
Если DB_CONTAINER непустой или DB_DIR=exists - это может быть ранее
инициализированная финансовая БД. Остановитесь, НЕ запускайте bootstrap.

## Шаг 2 - новый отдельный checkout проекта (не менять каталог сайта)

Только при отсутствии существующей finance DB и наличии всех команд:

    sudo -i
    set -Eeuo pipefail
    test ! -e /opt/financial-horizon-ops || {
      echo 'Остановлено: checkout уже существует'; exit 1;
    }
    git -c credential.helper= clone --depth=1 --branch main \
      https://github.com/MikeMoore1337/financial-horizon.git \
      /opt/financial-horizon-ops
    cd /opt/financial-horizon-ops
    git status --porcelain
    git rev-parse HEAD

Это публичный репозиторий, gh auth login и платные API не нужны. Не
клонировать поверх работающего релиза. Если status непустой - остановиться.

## Шаг 3 - автоматическая подготовка и реальное восстановление копии

В том же root-сеансе:

    cd /opt/financial-horizon-ops
    export FH_FINANCE_PERSONAL_MODE=YES
    export FH_FINANCE_DATA_DIR=/srv/financial-horizon-finance/pgdata
    export FH_FINANCE_APPROVED_SHA="$(git rev-parse HEAD)"
    bash deploy/postgres/scripts/personal-prepare.sh
    bash deploy/postgres/scripts/personal-bootstrap.sh

Первый скрипт создает ТОЛЬКО новые каталоги Financial Horizon, закрытые
уникальные случайные пароли, локальный GPG-ключ, backup.env и start.env.
Никаких паролей в stdout, файлов GitHub или чужих сервисов. GPG-ключ на
одном VPS - согласованный компромисс: при удалении VPS серверная копия
вместе с ключом может быть потеряна. Исходную AES-копию бюджета нужно
хранить отдельно на доверенном устройстве.

Второй скрипт проверяет текущий main SHA и 4/4 CI, миграции PostgreSQL,
RLS и отсутствие внешнего порта, делает шифрованный pg_dump и реальный
restore в одноразовый контейнер без сети. Он не включает финансовый API
и не удаляет исходные данные.

Ожидаемые строки: FINANCE_PERSONAL_PREPARE=PASS,
FINANCE_PERSONAL_EXACT_SHA_CI=PASS, RESTORE_DRILL_PASS,
FINANCE_PERSONAL_BOOTSTRAP=PASS, FINANCE_PERSONAL_BACKUP_RESTORE=PASS.


## Если первичная установка остановилась на ONLY_LOOPBACK_DATABASE_PORT_ALLOWED

На Docker Engine 29.6.2 контейнер, подключённый **только** к сети
`internal: true`, может сохранить `HostConfig.PortBindings` с
`127.0.0.1:54329`, но вернуть `NetworkSettings.Ports=null` и не открыть
TCP-порт. Это **не** текстовая ошибка `docker port`. Строгую проверку
фактической публикации ослаблять нельзя: требуется отдельная сеть и
действительное подключение к `127.0.0.1:54329`.

При первом сбое после `Container ... Healthy` и до миграций **не удаляйте**
контейнер или каталог `pgdata`, не запускайте `personal-prepare.sh`
повторно и не выполняйте `docker compose down -v`. Даже пустой кластер уже
создан, поэтому прежний bootstrap закономерно откажет в новой инициализации.

1. Сначала сохраните безопасный вывод:

   ```bash
   docker inspect fh-finance-postgres --format 'PORT_BINDINGS={{json .HostConfig.PortBindings}}'
   docker inspect fh-finance-postgres --format 'CONTAINER_STATUS={{.State.Status}}'
   ```

2. Только если это именно первый прерванный запуск **до миграций**, Docker
   показывает корректную привязку localhost, и исправление слито в `main`
   с обязательным успешным CI - от root выполните в отдельном production SSH:

   ```bash
   set -Eeuo pipefail
   systemctl disable --now fh-finance-personal.service
   systemctl disable --now fh-finance-personal-backup.timer
   cd /opt/financial-horizon-ops
   test -z "$(git status --porcelain)"
   if test "$(git rev-parse --is-shallow-repository)" = true; then
     git -c credential.helper= fetch --unshallow origin main
   else
     git -c credential.helper= fetch origin main
   fi
   git merge --ff-only origin/main

   export FH_FINANCE_PERSONAL_MODE=YES
   export FH_FINANCE_DATA_DIR=/srv/financial-horizon-finance/pgdata
   export FH_FINANCE_APPROVED_SHA="$(git rev-parse HEAD)"
   python3 deploy/postgres/scripts/personal_port_check.py --configured-only

   # Docker Engine 29.x: HostConfig may request localhost while the sole
   # internal network silently suppresses the *effective* publication.
   # First attach a separate dedicated ordinary bridge without recreating DB.
   test "$(docker inspect -f '{{.State.Running}}' fh-finance-postgres)" = true
   export FH_FINANCE_ATTACH_HOST_LOOPBACK=YES
   python3 deploy/postgres/scripts/personal-host-bridge.py --attach
   python3 deploy/postgres/scripts/personal-host-bridge.py --verify

   # Assert no finance migration ran before this original interruption.
   tables="$(docker exec -u postgres fh-finance-postgres \
     psql -X -U postgres -d fh_finance -Atqc \
     "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='finance'")"
   test "$tables" = 0

   # Only this DB is stopped: volume, container and auth service are preserved.
   docker stop --time=30 fh-finance-postgres
   test "$(docker inspect -f '{{.State.Status}}' fh-finance-postgres)" = exited

   export FH_FINANCE_RESUME_PRE_MIGRATION=YES
   bash deploy/postgres/scripts/personal-resume.sh
   ```

   Скрипт проверяет старый SHA из `start.env`, fast-forward на новый
   `main`, обязательные CI именно нового SHA, точные Docker image/network/
   mount/loopback, PG17, отсутствие финансовых таблиц, наличие двух
   специализированных ролей и выключенные systemd-службы. Он запускает
   **только прежний контейнер** через `docker start`, применяет миграции,
   делает шифрованный backup и реальный изолированный restore, затем
   **атомарно** меняет только SHA в `start.env`. При ошибке останавливает
   контейнер, том сохраняет. Это **не** универсальный DB upgrade и не
   разрешение восстанавливать поверх пользовательских данных.

3. Только при `FINANCE_PERSONAL_RESUME=PASS`,
   `FINANCE_PERSONAL_BACKUP_RESTORE=PASS` и
   `FINANCE_PERSONAL_START_ENV_UPDATED=PASS` - выполните **шаг 4** выше,
   затем проверьте `fh-email-auth.service`. Наличие этих PASS не включает
   финансовый API и не подтверждает пользовательскую миграцию.

**Docker 29.x / Compose 5.x:** изолированная сеть `finance_private`
намеренно остаётся `internal: true`, но исключительно internal-only мост
не публикует порт PostgreSQL на хост. Новая `fh-finance_host_loopback`
создаётся отдельно с опциями `host_binding_ipv4=127.0.0.1` и
`enable_icc=false`; на ней допускается только один FH-контейнер.
После `docker network connect` скрипт требует точную реальную привязку
через Docker inspect **и** TCP-соединение с `127.0.0.1:54329`.
При несовпадении ничего не удаляется, миграции не начинаются.
Дополнительная обычная bridge-сеть даёт контейнеру путь для исходящего
трафика: это отличие от полной исходной internal-only изоляции;
входящий финансовый порт по-прежнему доступен только с localhost,
а публичный порт VPS не открывается. Никогда не переключать порт на
`0.0.0.0`, не использовать `network_mode: host` или `docker compose down`.

После успешного восстановления системная служба использует
`docker start` только для **того же самого** контейнера и проверяет
сохранённое членство в обеих сетях. Команда `docker compose up`
не используется для штатного старта/перезапуска: она могла бы
пересоздать контейнер и потерять вторую сетевую привязку.
При наличии уже проведённых финансовых таблиц повторять
`personal-resume.sh` запрещено.

При `UNSAFE_CONFIGURED_PORT`, `UNSAFE_EFFECTIVE_PORT`,
`UNEXPECTED_CONTAINER_IDENTITY`, `EXISTING_SCHEMA_REQUIRES_MANUAL_REVIEW`
или другом `NO_GO` остановитесь. Не редактируйте Docker-команды, переменные,
дампы, роли и `start.env` вручную ради обхода проверки.

## Шаг 4 - только финансовая systemd-служба и таймер копий

После всех PASS:

    cd /opt/financial-horizon-ops
    install -o root -g root -m 0644 deploy/postgres/systemd/fh-finance-personal.service /etc/systemd/system/
    install -o root -g root -m 0644 deploy/postgres/systemd/fh-finance-personal-backup.service /etc/systemd/system/
    install -o root -g root -m 0644 deploy/postgres/systemd/fh-finance-personal-backup.timer /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable --now fh-finance-personal.service
    systemctl enable --now fh-finance-personal-backup.timer
    systemctl start fh-finance-personal-backup.service
    systemctl is-active fh-finance-personal.service
    systemctl is-active fh-finance-personal-backup.timer
    docker port fh-finance-postgres
    find /var/backups/financial-horizon-finance -maxdepth 1 -type f -name 'fh-finance-*.pgdump.gpg' -printf '.' | wc -c

Ожидается active, active, единственный bind 5432/tcp -> 127.0.0.1:54329
и хотя бы одна копия. Пока что существующий fh-email-auth.service не
перезапускать и не менять его переменные.

## Шаг 5 - выдать мне только безсекретные результаты

Отправить вывод шагов 1, 3 и 4 (только PASS/NO_GO, без значений секретов)
и результаты:

    systemctl show fh-email-auth.service \
      -p FragmentPath -p DropInPaths -p User -p WorkingDirectory --no-pager

После этого можно безопасно адаптировать именно текущую систему установки
fh-email-auth.service, а не угадывать ее Python-путь или переменные. Следующая
приемка - подтвержденная FH-сессия, закрытый финансовый профиль, 401/403/412,
записанный exact production SHA и проверенный откат. Только после этого
выкатывается пользовательский UI и запускается ручной импорт AES-копии.

До получения фактических production receipts Issues #33, #66, #69, #70
остаются OPEN. #68 требует отдельной настоящей офлайн-конфликт-резолюции.
