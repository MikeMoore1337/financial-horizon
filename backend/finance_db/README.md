# Financial PostgreSQL internals

SQLAlchemy 2 mappings cover all 15 tables. Alembic reviewable DDL is the
authoritative source of physical constraints, RLS and grants. Autogenerate
and Base.metadata.create_all are not a replacement for this migration.

The one-shot migration image reads FH_FINANCE_PASSWORD_FILE from a private
Docker secret, opens a psycopg connection with the password held in memory,
then passes that connection to Alembic. No .pgpass, environment variable or
URL with credentials is persisted. CI-only direct Alembic invocation may
use synthetic CI credentials. Use FH_FINANCE_DATABASE_URL with the
unprivileged runtime role for transactional access.

finance_transaction(engine, verified_user_id, profile_id) binds transaction
scope with SET LOCAL. The finance API in #67 must first validate the real
auth SQLite session and authorized profile. RLS does not secure arbitrary
untrusted SQL able to set session GUCs. There are no HTTP endpoints here.


### Неизменяемость начального остатка

`accounts.opening_minor` указывается явно только при создании счёта и не
может обновляться runtime-ролью. Исправление баланса после создания
записывается отдельной `adjustment`-проводкой, которая сохраняется в
неизменяемом финансовом журнале. Тип счёта `kind` допускает изменение
в пределах доменного CHECK, а tenant/profile ID - никогда.


### Направления денежных потоков по обязательствам

Привязанный `settlement` с `obligations.direction='income'` должен
создавать **положительную** проводку `ledger_transactions.kind='payment'`,
а с `direction='expense'` - **отрицательную**. Кредитный платёж всегда
отрицательный. Проверка знака/суммы выполняется в отложенном DB-триггере
после добавления ссылки и проводки в одной транзакции. После первой отметки
settlement нельзя изменить направление обязательства, иначе исторические
проводки потеряли бы экономический смысл.
