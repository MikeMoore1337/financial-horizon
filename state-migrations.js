// Stable import path for existing browser modules and Node.js tests.
// Vite bundles the strictly checked TypeScript implementation.
export { CURRENT_STATE_VERSION, migrateState, downgradeStateForRollback } from './state-migrations.ts';
