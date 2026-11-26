import { createManagedPgExecutor } from '@/server/db/postgres';
import { runPostgresMigrations } from '@/server/db/migrations';
import { redactSensitiveText } from '@/server/marketData/adapter';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.log(
      JSON.stringify({
        event: 'db_migrate_skipped',
        reason: 'DATABASE_URL_NOT_SET',
        historyPersistence: 'NOT_PERSISTENT',
      })
    );
    process.exit(0);
  }

  const executor = createManagedPgExecutor(databaseUrl);
  try {
    const reachable = await executor.ping();
    if (!reachable) {
      throw new Error('PostgreSQL database is unreachable');
    }

    const result = await runPostgresMigrations(executor);
    console.log(
      JSON.stringify({
        event: 'db_migrate_complete',
        appliedVersions: result.appliedVersions,
        skippedVersions: result.skippedVersions,
      })
    );
  } catch (err) {
    const msg = redactSensitiveText(
      err instanceof Error ? err.message : 'Migration failed',
      [databaseUrl]
    );
    console.error(JSON.stringify({ event: 'db_migrate_failed', error: msg }));
    process.exitCode = 1;
  } finally {
    await executor.close();
  }
}

void main();
