# REVIEW-0065 - Контрольный технический разбор облачной архитектуры

- База: main b301b9f749fb688174fc2d0986403b6d4315634e
- Область: ADR, reference SQL, OpenAPI, синтетические тесты, исходный storage/auth/backup/Service Worker.
- Метод: отдельный критический проход по решениям и негативным сценариям. **Это саморевью ассистента, не подпись внешнего независимого AppSec-специалиста, не проверка production.**
- Вывод: спецификация пригодна для реализации в #66-#70, однако это не разрешение на публичный cloud release.

## Контрольная матрица

| Область | Проверено | Результат |
|---|---|---|
| Совместимость | Отдельная cloud IndexedDB рядом с текущей v1, старый state v1/v2 и encrypted backup v1 остаются на месте | DESIGN_PASS |
| Источник истины | Для авторизованных финансов только PostgreSQL, snapshot read-only, mutations через commands+revisions | DESIGN_PASS |
| SQL isolation | Finance profiles и все дочерние таблицы FORCE RLS, составные FK и проверка own session scope | DESIGN_PASS, runtime test обязателен |
| Повтор перевода | Unique(profile_id,mutation_id), fingerprint, atomic receipt + postings + revision | DESIGN_PASS, race tests #67 |
| HTTP | Сильный If-Match и 412, semantic 409, отсутствующий precondition 428, expired auth 401 | DESIGN_PASS |
| Офлайн | Queue per verified user scope, rebase только явно и новым ID, отсутствует silent last-write-wins | DESIGN_PASS |
| Импорт | Backup+verify, local preview, явное consent, staged chunks, status/resume, запрет overwrite | DESIGN_PASS |
| Криптография | Server-side model не объявлена E2EE, plaintext IndexedDB отмечена как риск #34 | DESIGN_PASS |
| Зависимости | #9/#43/#51/#71/#72 не включены и не изменены | DESIGN_PASS |
| Эксплуатация | PITR, backups, RPO/RTO как целевые критерии, не выполненные тесты | DESIGN_PASS |

## Найденные и устранённые дефекты проекта документации

1. **RLS только finance_profiles недостаточна:** в reference SQL добавлена policy FORCE на каждую дочернюю таблицу. Реальная проверка RLS под ограниченной ролью остаётся #66.
2. **Action нельзя сочетать с произвольным payload:** OpenAPI связывает каждый action со своей схемой через условные JSON Schema, серверу остаётся бизнес-валидация и FK.
3. **Неверное смешение кодов:** If-Match mismatch = 412 согласно RFC 9110; 409 только semantic_conflict/idempotency_key_reuse. Клиент обрабатывает оба без потери outbox.
4. **Восстановление прерванного импорта:** включены GET batch status и идемпотентные staging chunks; без них запрещено считать импорт надёжным.
5. **Жёсткая региональная timezone:** исправлено на UTC по умолчанию, календарные периоды используют валидируемую IANA timezone.

## Остаточные риски - условия для реализации

- **CRITICAL:** настоящий PostgreSQL, Alembic, grant/RLS, DB triggers balanced postings, runtime idempotency и серверный authZ не реализованы. В #66/#67 нужны SQL integration tests под НЕ суперпользователем, включая пустой и чужой context, foreign-key и UPDATE/INSERT RETURNING.
- **CRITICAL:** реальные encrypted volume/backup/WAL и recovery keys не проверены. Текущая IndexedDB plaintext. #34 должен спроектировать ключи и выполнить браузерные negative/restore tests, прежде чем объявлять защиту локальных данных.
- **HIGH:** auth SQLite и finance PostgreSQL не имеют общей транзакции. Нужна повторная проверка сессии и тест race logout/commit для строгой revocation semantics.
- **HIGH:** PostgreSQL SET LOCAL context - лишь дополнительная защита при полном запрете SQL injection и предварительной owner проверке в API. Runtime роль без SUPERUSER/BYPASSRLS/DDL.
- **HIGH:** кредитные APR basis points и расчёт графиков в #67 сверяются с текущим finance.js на граничных ставках; нельзя менять суммы импортированных кредитов молча.
- **HIGH:** данные из snapshot/change_log должны иметь консистентную revision без разрывов; clients должны атомарно фиксировать cursor и локальный outbox. Нужны реальные интеграционные тесты #67/#68.
- **HIGH:** при fuzzy duplicate или существующем облачном бюджете импорт останавливается для ручного решения. В v1 допустим лишь skip_exact/cancel после явного consent.
- **MEDIUM:** global profile revision может давать лишние 412 независимым устройствам, но обеспечивает простой последовательный порядок. Ускорение только по измерениям, не через CRDT/LWW для денег.
- **MEDIUM:** idempotency receipts без TTL разрастаются; квоты и уплотнение ответа допустимы, удаление ключей до удаления профиля - нет.
- **MEDIUM:** RPO 15 минут / RTO 4 часа - предложенные цели, ещё не измерены. Отдельная проверка PITR/restore необходима #45/#66.
- **MEDIUM:** reference schema и OpenAPI не являются исполняемыми миграциями или реализованным API. Их статический анализ не доказывает реальный PostgreSQL/FastAPI/браузерный workflow.

## Проверочные ворота #65

- Node контрактные проверки + существующий npm test: на актуальном head SHA.
- GitHub required CI: app-tests, email-auth-tests, e2e-real-browser; дополнительные security checks проверять при наличии.
- Этот PR содержит только документы и синтетические контрактные тесты; публичного deployment не требуется.
- Физическая iOS Safari, работающее облако, серверные транзакции, E2EE, реальный restore и достигнутые RPO/RTO - **NOT_RUN**; это обязанности #66-#70, а не PASS в #65.

**Вердикт:** проект достаточен как реализационный контракт при явном сохранении указанных ограничений. Внешнее человеческое AppSec review для #51/#70 этим документом не заменено.
