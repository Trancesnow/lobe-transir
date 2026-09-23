import { sql } from 'drizzle-orm';

import type { LobeChatDatabase } from '@/database/type';
import type { FileS3 } from '@/server/modules/S3';

import { lockStorageReferences, sweepEphemeralStorageDeletions } from './ephemeralStorageCleanup';

export const EPHEMERAL_RESOURCE_RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
export const EPHEMERAL_RESOURCE_CLEANUP_BATCH_SIZE = 100;
export const EPHEMERAL_RESOURCE_CLEANUP_MAX_BATCH_SIZE = 500;

type CleanupDatabase = Pick<LobeChatDatabase, 'execute'>;
type ResourceKind = 'document' | 'file';

export interface EphemeralResourceCandidate {
  createdAt: string;
  id: string;
  kind: ResourceKind;
  updatedAt: string;
  userId: string;
  workspaceId: string | null;
}

interface ResourceInspection extends EphemeralResourceCandidate {
  protected: boolean;
}

export interface EphemeralResourceCleanupOptions {
  after?: { createdAt: string; id: string; kind: ResourceKind };
  batchSize?: number;
  now?: Date;
  retentionMilliseconds?: number;
  storage?: Pick<FileS3, 'deleteFile'>;
}

export interface EphemeralResourceCleanupBatch {
  candidates: EphemeralResourceCandidate[];
  cutoff: string;
  nextCursor?: { createdAt: string; id: string; kind: ResourceKind };
}

const resolveOptions = (options: EphemeralResourceCleanupOptions) => {
  const batchSize = options.batchSize ?? EPHEMERAL_RESOURCE_CLEANUP_BATCH_SIZE;
  const retention = options.retentionMilliseconds ?? EPHEMERAL_RESOURCE_RETENTION_MILLISECONDS;
  const now = options.now?.getTime() ?? Date.now();
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > EPHEMERAL_RESOURCE_CLEANUP_MAX_BATCH_SIZE
  ) {
    throw new RangeError('Cleanup batch size must be an integer between 1 and 500');
  }
  if (!Number.isSafeInteger(retention) || retention <= 0 || !Number.isFinite(now)) {
    throw new RangeError('Cleanup requires a valid time and positive retention');
  }
  const cutoff = new Date(now - retention);
  if (!Number.isFinite(cutoff.getTime())) throw new RangeError('Cleanup cutoff is invalid');
  return { batchSize, cutoff: cutoff.toISOString() };
};

// These are conservative guards, not an exhaustive reference graph. In particular,
// tool-card JSON references do not take row locks; no inspection authorizes deletion.
const expiredResources = (cutoff: string) => sql`
  SELECT 'file' AS kind, f.id, f.user_id AS "userId", f.workspace_id AS "workspaceId",
    f.created_at::text AS "createdAt", f.updated_at::text AS "updatedAt",
    (f.workspace_id IS NOT NULL OR f.parent_id IS NOT NULL 
      OR EXISTS (SELECT 1 FROM documents d WHERE d.file_id = f.id)) AS protected
  FROM files f
  WHERE f.metadata->'ephemeral' = 'true'::jsonb AND f.created_at <= ${cutoff}::timestamptz
  UNION ALL
  SELECT 'document' AS kind, d.id, d.user_id AS "userId", d.workspace_id AS "workspaceId",
    d.created_at::text AS "createdAt", d.updated_at::text AS "updatedAt",
    (d.workspace_id IS NOT NULL OR d.parent_id IS NOT NULL OR d.file_id IS NOT NULL
      OR d.knowledge_base_id IS NOT NULL OR d.file_type = 'custom/folder'
      OR EXISTS (SELECT 1 FROM documents child WHERE child.parent_id = d.id)
      OR EXISTS (SELECT 1 FROM files child WHERE child.parent_id = d.id)) AS protected
  FROM documents d
  WHERE d.metadata->'ephemeral' = 'true'::jsonb AND d.created_at <= ${cutoff}::timestamptz
`;

export const selectExpiredEphemeralResources = async (
  database: CleanupDatabase,
  options: EphemeralResourceCleanupOptions = {},
): Promise<EphemeralResourceCleanupBatch> => {
  const { batchSize, cutoff } = resolveOptions(options);
  const cursor = options.after;
  if (
    cursor &&
    (!Number.isFinite(Date.parse(cursor.createdAt)) ||
      !['document', 'file'].includes(cursor.kind) ||
      !cursor.id)
  ) {
    throw new RangeError('Cleanup cursor is invalid');
  }
  const continuation = cursor
    ? sql`WHERE ("createdAt"::timestamptz, kind, id) > (${cursor.createdAt}::timestamptz, ${cursor.kind}, ${cursor.id})`
    : sql``;
  const result = await database.execute(sql`
    SELECT kind, id, "userId", "workspaceId", "createdAt", "updatedAt"
    FROM (${expiredResources(cutoff)}) expired
    ${continuation}
    ORDER BY "createdAt"::timestamptz, kind, id LIMIT ${batchSize}
  `);
  const candidates = result.rows as unknown as EphemeralResourceCandidate[];
  const last = candidates.at(-1);
  return {
    candidates,
    cutoff,
    nextCursor:
      candidates.length === batchSize && last
        ? { createdAt: last.createdAt, id: last.id, kind: last.kind }
        : undefined,
  };
};

export type EphemeralResourceRevalidation =
  'no-longer-expired-or-ephemeral' | 'changed' | 'protected' | 'requires-atomic-cleanup';

export const revalidateExpiredEphemeralResource = async (
  database: CleanupDatabase,
  candidate: EphemeralResourceCandidate,
  cutoff: string,
): Promise<EphemeralResourceRevalidation> => {
  if (!Number.isFinite(Date.parse(cutoff))) throw new RangeError('Cleanup cutoff is invalid');
  const result = await database.execute(sql`
    SELECT * FROM (${expiredResources(cutoff)}) expired
    WHERE kind = ${candidate.kind} AND id = ${candidate.id} LIMIT 1
  `);
  const current = result.rows[0] as unknown as ResourceInspection | undefined;
  if (!current) return 'no-longer-expired-or-ephemeral';
  if (
    current.userId !== candidate.userId ||
    current.workspaceId !== candidate.workspaceId ||
    current.createdAt !== candidate.createdAt ||
    current.updatedAt !== candidate.updatedAt
  )
    return 'changed';
  if (current.protected) return 'protected';
  return 'requires-atomic-cleanup';
};

// Inspection never claims storage or changes database references.
export const inspectEphemeralResourceCleanup = async (
  database: CleanupDatabase,
  options: EphemeralResourceCleanupOptions = {},
) => {
  const batch = await selectExpiredEphemeralResources(database, options);
  const inspections: Array<EphemeralResourceCandidate & { status: EphemeralResourceRevalidation }> =
    [];
  for (const candidate of batch.candidates) {
    const status = await revalidateExpiredEphemeralResource(database, candidate, batch.cutoff);
    inspections.push({ ...candidate, status });
  }
  return {
    cutoff: batch.cutoff,
    deleted: 0 as const,
    inspections,
    mode: 'inspection-only' as const,
    nextCursor: batch.nextCursor,
  };
};

export interface EphemeralResourceSweepResult {
  cutoff: string;
  deleted: number;
  failed: number;
  nextCursor?: { createdAt: string; id: string; kind: ResourceKind };
  results: Array<{ id: string; kind: ResourceKind; status: string }>;
  storage?: { deleted: number; failed: number; protected: number };
}

/** Atomically expire database references and enqueue storage deletion. */
export const sweepExpiredEphemeralResources = async (
  database: Pick<LobeChatDatabase, 'execute' | 'transaction'>,
  options: EphemeralResourceCleanupOptions = {},
): Promise<EphemeralResourceSweepResult> => {
  const batch = await selectExpiredEphemeralResources(database, options);
  const report: EphemeralResourceSweepResult = {
    cutoff: batch.cutoff,
    nextCursor: batch.nextCursor,
    deleted: 0,
    failed: 0,
    results: [],
  };
  for (const candidate of batch.candidates) {
    try {
      const status = await database.transaction(async (transaction) => {
        // Bounded lock acquisition fails closed; this also serializes new child
        // rows with the reference inspection rather than recursively deleting.
        await lockStorageReferences(transaction);
        const validation = await revalidateExpiredEphemeralResource(
          transaction,
          candidate,
          batch.cutoff,
        );
        if (validation !== 'requires-atomic-cleanup') return validation;
        if (candidate.kind === 'file') {
          const selected = await transaction.execute(
            sql`SELECT url, file_hash FROM files WHERE id = ${candidate.id}`,
          );
          const file = selected.rows[0] as { url: string; file_hash: string | null };
          if (!file.url || /^(?:[a-z]+:|\/)/i.test(file.url)) return 'unsupported-storage-key';
          const mismatchedKeys = await transaction.execute(sql`SELECT 1 FROM global_files
            WHERE hash_id = ${file.file_hash} AND url <> ${file.url} LIMIT 1`);
          if (mismatchedKeys.rows.length) return 'unsupported-storage-alias';
          const dependencies = await transaction.execute(sql`
            SELECT ns.nspname AS schema, relation.relname AS table, attribute.attname AS column
            FROM pg_constraint constraint_row
            JOIN pg_class relation ON relation.oid = constraint_row.conrelid
            JOIN pg_namespace ns ON ns.oid = relation.relnamespace
            JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
              AND attribute.attnum = ANY(constraint_row.conkey)
            WHERE constraint_row.contype = 'f' AND constraint_row.confrelid = 'files'::regclass
          `);
          for (const dependency of dependencies.rows as Array<{
            schema: string;
            table: string;
            column: string;
          }>) {
            if (['messages_files', 'file_uploads'].includes(dependency.table)) continue;
            const relation = sql`${sql.identifier(dependency.schema)}.${sql.identifier(dependency.table)}`;
            await transaction.execute(sql`LOCK TABLE ${relation} IN SHARE ROW EXCLUSIVE MODE`);
            const references = await transaction.execute(sql`SELECT 1 FROM ${relation}
              WHERE ${sql.identifier(dependency.column)}::text = ${candidate.id} LIMIT 1`);
            if (references.rows.length) return 'protected-reference';
          }
          for (const table of [
            'works',
            'resource_permissions',
            'resource_transfer_requests',
            'trash_items',
          ]) {
            const existence = await transaction.execute(
              sql`SELECT to_regclass(${table}) AS relation`,
            );
            if (!existence.rows[0]?.relation) continue;
            await transaction.execute(
              sql`LOCK TABLE ${sql.identifier(table)} IN SHARE ROW EXCLUSIVE MODE`,
            );
            const references = await transaction.execute(sql`SELECT 1 FROM ${sql.identifier(table)}
              WHERE resource_id = ${candidate.id} LIMIT 1`);
            if (references.rows.length) return 'protected-reference';
          }
          await transaction.execute(sql`INSERT INTO ephemeral_storage_deletions (object_key, file_hash)
            VALUES (${file.url}, ${file.file_hash}) ON CONFLICT (object_key) DO NOTHING`);
          await transaction.execute(sql`DELETE FROM files WHERE id = ${candidate.id}`);
          // global_files is a deduplication record, not an independent durable
          // copy. Remove it only after the last file reference has disappeared.
          await transaction.execute(sql`DELETE FROM global_files global_file
            WHERE (global_file.url = ${file.url} OR global_file.hash_id = ${file.file_hash})
              AND NOT EXISTS (SELECT 1 FROM files reference WHERE reference.url = global_file.url
                OR reference.file_hash = global_file.hash_id)
              AND NOT EXISTS (SELECT 1 FROM file_uploads upload WHERE upload.pathname = global_file.url
                AND upload.status IN ('active', 'cleaning'))`);
          return 'deleted';
        }

        const dependencies = await transaction.execute(sql`
          SELECT ns.nspname AS schema, relation.relname AS table, attribute.attname AS column
          FROM pg_constraint constraint_row
          JOIN pg_class relation ON relation.oid = constraint_row.conrelid
          JOIN pg_namespace ns ON ns.oid = relation.relnamespace
          JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
            AND attribute.attnum = ANY(constraint_row.conkey)
          WHERE constraint_row.contype = 'f'
            AND constraint_row.confrelid = 'documents'::regclass
        `);
        for (const dependency of dependencies.rows as Array<{
          column: string;
          schema: string;
          table: string;
        }>) {
          // History belongs solely to the deleted document. All other references
          // conservatively protect it, including shares, tasks and chunks.
          if (dependency.table === 'document_histories') continue;
          const relation = sql`${sql.identifier(dependency.schema)}.${sql.identifier(dependency.table)}`;
          await transaction.execute(sql`LOCK TABLE ${relation} IN SHARE ROW EXCLUSIVE MODE`);
          const references = await transaction.execute(sql`
            SELECT 1 FROM ${relation}
            WHERE ${sql.identifier(dependency.column)}::text = ${candidate.id} LIMIT 1
          `);
          if (references.rows.length) return 'protected-reference';
        }
        // These application references have no foreign key to documents.
        for (const table of [
          'works',
          'resource_permissions',
          'resource_transfer_requests',
          'trash_items',
        ]) {
          const existence = await transaction.execute(
            sql`SELECT to_regclass(${table}) AS relation`,
          );
          if (!existence.rows[0]?.relation) continue;
          await transaction.execute(
            sql`LOCK TABLE ${sql.identifier(table)} IN SHARE ROW EXCLUSIVE MODE`,
          );
          const references = await transaction.execute(sql`
            SELECT 1 FROM ${sql.identifier(table)} WHERE resource_id = ${candidate.id} LIMIT 1
          `);
          if (references.rows.length) return 'protected-reference';
        }
        const removed = await transaction.execute(sql`
          DELETE FROM documents WHERE id = ${candidate.id}
            AND metadata->'ephemeral' = 'true'::jsonb
            AND created_at <= ${batch.cutoff}::timestamptz RETURNING id
        `);
        return removed.rows.length === 1 ? 'deleted' : 'no-longer-expired-or-ephemeral';
      });
      if (status === 'deleted') report.deleted += 1;
      report.results.push({ id: candidate.id, kind: candidate.kind, status });
    } catch {
      // The transaction rolls back; keeping the original row makes retry safe.
      report.failed += 1;
      report.results.push({ id: candidate.id, kind: candidate.kind, status: 'retryable-failure' });
    }
  }
  report.storage = await sweepEphemeralStorageDeletions(database, {
    batchSize: options.batchSize,
    now: options.now,
    storage: options.storage,
  });
  report.failed += report.storage.failed;
  return report;
};
