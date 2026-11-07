# Облачное хранение Financial Horizon - проект контрактов #65

**Статус:** принято для реализации, **НЕ развёрнуто**. Никакой PostgreSQL finance API, фоновой синхронизации, E2EE или импорта в production эта папка не включает.

| Файл | Назначение |
|---|---|
| [ADR-0065-cloud-finance-sync.md](ADR-0065-cloud-finance-sync.md) | Выбранная архитектура, границы FastAPI/PostgreSQL/SQLite/IndexedDB, операции, ревизии, диаграммы Mermaid |
| [cloud-finance-schema.sql](cloud-finance-schema.sql) | **Справочная** PostgreSQL DDL, составные FK, ключи, индексы, FORCE RLS; не применять как миграцию |
| [finance-sync-v1.openapi.json](finance-sync-v1.openapi.json) | Версионированный OpenAPI 3.1 контракт snapshot/delta/commands/import |
| [finance-sync-contract-fixtures.json](finance-sync-contract-fixtures.json) | Исключительно синтетические данные, 2 пользователя × 2 устройства, повтор/idempotency/конфликты |
| [cloud-migration-threats.md](cloud-migration-threats.md) | Threat model, криптография, backup+consent, отказоустойчивость и E2E матрица |
| [REVIEW-0065.md](REVIEW-0065.md) | Критическое ревью решений и незакрытые release gates |

Автоматическая статическая проверка: npm test (включает tests/cloud-contracts.test.mjs). Она проверяет только контрактные инварианты синтетической reference модели, **не** работающий FastAPI, PostgreSQL, real IndexedDB, систему шифрования или production.

### Реализация по независимым задачам

#66 - PostgreSQL/Alembic и DB эксплуатация; #67 - транзакционный FastAPI API с настоящим auth/IDOR; #68 - офлайн cache/outbox и multi-device client; #69 - безопасный явный импорт; #70 - реальный E2E/независимая безопасность/production gate. #34 - шифрование IndexedDB; #45 - мониторинг/backup; #51 - public auth gate; #71/#72 - отдельная фронтенд-модернизация. Epic #7 закрывается только после настоящего cloud rollout.

Отдельной dev-среды нет. Исполняемые изменения последующих задач проходят изолированные проверки и обязательный CI, затем контролируемый production deploy с точным SHA и готовым откатом. Для текущего PR, содержащего документацию и contract tests, отдельный деплой не требуется.
