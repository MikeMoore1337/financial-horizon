# Financial Horizon #66 - PostgreSQL: эксплуатационный регламент

Статус: подготовленная инфраструктура, НЕ подтверждение production-развёртывания.
Контракт: docs/architecture/ADR-0065-cloud-finance-sync.md.
Auth SQLite и существующая IndexedDB не изменяются.

## Границы инфраструктуры

- PostgreSQL 17 с закреплённым digest официального образа; отдельный кластер,
  отдельный Docker volume fh_finance_pgdata, приватная internal-сеть, без ports.
- Отсутствуют финансовый API, регистрация и публичная синхронизация.
- Роли fh_finance_migrator (DDL) и fh_finance_runtime (DML); runtime без
  SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB, DELETE, TRUNCATE и CREATE.
- Все 15 финансовых таблиц имеют ENABLE/FORCE RLS.
- Контекст principal через SET LOCAL после реальной проверки сессии в #67;
  RLS не заменяет API authorisation. Сырые SQL-запросы от клиента запрещены.
- Миграция Alembic и проверенные схемные SQL-файлы - единственный способ
  изменения структуры. Никакого SQLAlchemy create_all().
- Исходные auth SQLite, фронтенд и PWA остаются без изменений.

## Production preflight и запуск (только после gate)

1. Зафиксировать точный SHA, независимое ревью, PASS всех обязательных CI,
   RLS-интеграционные тесты, внешний backup и проверенный rollback.
2. Сверить CPU/RAM/диск и проверить отсутствие пересечений с другими Docker
   контейнерами, томами и сетями. Текущая VPS: Ubuntu 24.04.4 LTS,
   ориентировочно 4 GiB RAM и 13 GiB свободного места при первой проверке.
3. Создать /etc/financial-horizon/finance/secrets с правами 0700.
   Три разных файла admin_password, migrator_password, runtime_password
   с уникальными значениями не короче 32 символов, права 0600.
   Файлы и значения никогда не передавать в git/issue/CI.
4. Проверить compose-файл командой:
   docker compose -f deploy/postgres/compose.yml config --quiet
5. Для пустой новой базы применить:
   docker compose -f deploy/postgres/compose.yml up -d db
   docker compose -f deploy/postgres/compose.yml --profile ops run --build --rm migrator
6. Сверить finance.alembic_version = 0001_initial, pg_class с
   relrowsecurity=true/relforcerowsecurity=true для каждой финансовой
   таблицы, runtime-роли и GRANT, отсутствие published ports.
7. Проверить, что auth SQLite, страницы и текущие auth endpoints неизменны.

Запрещено: docker compose down -v, alembic stamp вместо upgrade,
применение reference SQL напрямую, изменение БД других сервисов.

## Защита, резервирование и восстановление

Публичный GPG-ключ получателя заранее импортируется на VPS в отдельный
закрытый keyring; приватный ключ хранится вне VPS на доверенном узле
восстановления. Файл backup.env задаёт FH_FINANCE_GPG_RECIPIENT и
FH_FINANCE_GPG_HOME; его права 0600. Backup dir
/var/backups/financial-horizon-finance имеет права 0700.

scripts/backup.sh потоково шифрует pg_dump -Fc открытым ключом без записи
открытого дампа на диск. Ошибки прекращают выполнение; файлы .partial
удаляются, завершённые копии хранятся 30 дней. Таймер systemd запускает
backup каждые шесть часов, но включать его можно только после ручного
успешного полного цикла backup/restore и настройки оповещений об ошибках.

scripts/restore-drill.sh принимает зашифрованный архив и восстанавливает его
в новый одноразовый PostgreSQL без сети/портов, затем проверяет количество
таблиц и pg_amcheck. Рекомендовано запускать его на независимом доверенном
узле, на котором хранится приватный GPG-ключ; не копировать этот ключ на
VPS ради удобства.

**RPO/RTO пока не доказаны.** Цели ADR: RPO 15 минут и RTO 4 часа.
Без защищённого непрерывного WAL/PITR заявлять RPO 15 минут нельзя:
при расписании pg_dump каждые 6 часов RPO в лучшем случае до шести часов
плюс задержки/сбои. PITR и encrypted WAL здесь не настроены. Offsite-копии,
шифрование самого тома/диска и внешний мониторинг не подтверждены.
Локальный Docker volume с правами доступа не доказывает encryption-at-rest
и не защищает от потери VPS. RTO следует измерить отдельным restore drill.

## Rollback и безопасность обновлений

Проверить backup и restore ДО любых будущих структурных изменений.
Ревизия 0001_initial намеренно не позволяет разрушительный downgrade.
При ошибке до появления финансовых данных отключить/остановить только
новый финансовый сервис, сохранив том. После приёма пользовательских
записей только проверенный roll-forward или восстановление в новый
кластер с контролируемым переключением. Никогда не стирать аудит,
idempotency receipts и не выполнять DROP SCHEMA на production.

Не включать cloud до завершения #67-#70 и security #51.
CI backup/restore с синтетическими данными не заменяет фактический
production backup/restore. Без подтверждённого независимого review,
backup, инвентаризации шифрования и restore Issue #66 не закрывать.
