import { sql } from 'drizzle-orm';

import type { LobeChatDatabase } from '@/database/type';
import type { FileS3 } from '@/server/modules/S3';

type CleanupDatabase = Pick<LobeChatDatabase, 'execute' | 'transaction'>;

export const lockStorageReferences = async (database: Pick<LobeChatDatabase, 'execute'>) => {
  await database.execute(sql`SET LOCAL lock_timeout = '2s'`);
  // Acquire table locks before the advisory lock to match normal INSERT lock order.
  await database.execute(
    sql`LOCK TABLE files, documents, global_files, file_uploads IN SHARE ROW EXCLUSIVE MODE`,
  );
  await database.execute(sql`SELECT pg_advisory_xact_lock(164, 1)`);
};

export const sweepEphemeralStorageDeletions = async (
  database: CleanupDatabase,
  options: { batchSize?: number; now?: Date; storage?: Pick<FileS3, 'deleteFile'> } = {},
) => {
  const batchSize = options.batchSize ?? 100;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new RangeError('Storage cleanup batch size must be between 1 and 500');
  }
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new RangeError('Invalid cleanup time');
  const selected = await database.execute(sql`
    SELECT object_key FROM ephemeral_storage_deletions
    WHERE state <> 'deleted' AND retry_at <= ${now.toISOString()}::timestamptz
    ORDER BY retry_at, object_key LIMIT ${batchSize}
  `);
  const report = { deleted: 0, failed: 0, protected: 0 };
  let storage = options.storage;
  for (const row of selected.rows as Array<{ object_key: string }>) {
    try {
      const claimed = await database.transaction(async (transaction) => {
        await lockStorageReferences(transaction);
        const current = await transaction.execute(sql`
          SELECT * FROM ephemeral_storage_deletions WHERE object_key = ${row.object_key}
            AND state <> 'deleted' AND retry_at <= ${now.toISOString()}::timestamptz FOR UPDATE
        `);
        const task = current.rows[0] as { file_hash: string | null; state: string } | undefined;
        if (!task) return false;
        // A previous live upload can have delayed deduplication-row removal.
        // Foreign keys from non-file consumers fail closed and roll this back.
        if (task.state === 'pending') {
          await transaction.execute(sql`DELETE FROM global_files global_file
            WHERE global_file.url = ${row.object_key}
              AND NOT EXISTS (SELECT 1 FROM files reference
                WHERE reference.url = global_file.url OR reference.file_hash = global_file.hash_id)
              AND NOT EXISTS (SELECT 1 FROM file_uploads upload
                WHERE upload.pathname = global_file.url AND upload.status IN ('active', 'cleaning'))`);
        }
        const references = await transaction.execute(sql`
          SELECT 1 FROM files WHERE url = ${row.object_key}
            OR (${task.file_hash}::text IS NOT NULL AND file_hash = ${task.file_hash})
          UNION ALL SELECT 1 FROM global_files WHERE url = ${row.object_key}
            OR (${task.file_hash}::text IS NOT NULL AND hash_id = ${task.file_hash})
          UNION ALL SELECT 1 FROM file_uploads WHERE pathname = ${row.object_key}
            AND status IN ('active', 'cleaning') LIMIT 1
        `);
        if (references.rows.length) {
          // Pending work stays retryable when a shared temporary copy or upload
          // still exists; a durable copy continues to protect the object.
          await transaction.execute(sql`UPDATE ephemeral_storage_deletions
            SET retry_at = ${now.toISOString()}::timestamptz + interval '1 hour', updated_at = now()
            WHERE object_key = ${row.object_key}`);
          report.protected += 1;
          return false;
        }
        await transaction.execute(sql`UPDATE ephemeral_storage_deletions
          SET state = 'claimed', attempts = attempts + 1,
            retry_at = ${now.toISOString()}::timestamptz + interval '5 minutes', updated_at = now()
          WHERE object_key = ${row.object_key}`);
        return true;
      });
      if (!claimed) continue;
      if (!storage) {
        const { FileS3 } = await import('@/server/modules/S3');
        storage = new FileS3();
      }
      await storage.deleteFile(row.object_key);
      await database.execute(sql`UPDATE ephemeral_storage_deletions
        SET state = 'deleted', updated_at = now() WHERE object_key = ${row.object_key}`);
      report.deleted += 1;
    } catch {
      // Claims never expire for writers. Only workers retry, so an ambiguous S3
      // outcome cannot delete a newly uploaded replacement of the same key.
      report.failed += 1;
    }
  }
  return report;
};
