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
