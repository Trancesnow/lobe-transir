import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import {
  inspectEphemeralResourceCleanup,
  revalidateExpiredEphemeralResource,
  selectExpiredEphemeralResources,
  sweepExpiredEphemeralResources,
} from './ephemeralResourceCleanup';
import { sweepEphemeralStorageDeletions } from './ephemeralStorageCleanup';

const databaseRequire = createRequire(`${process.cwd()}/packages/database/package.json`);
const { PGlite } = databaseRequire('@electric-sql/pglite');
const client = new PGlite();
const database = drizzle(client) as unknown as LobeChatDatabase;
const now = new Date('2026-09-23T00:00:00Z');

beforeAll(async () => {
  await client.exec(`
    CREATE TABLE files (
      id text PRIMARY KEY, user_id text DEFAULT 'owner', workspace_id text,
      created_at timestamptz DEFAULT '2026-09-01', updated_at timestamptz DEFAULT '2026-09-01',
      metadata jsonb DEFAULT '{"ephemeral":true}', parent_id text, file_hash text, url text
    );
    CREATE TABLE documents (
      id text PRIMARY KEY, user_id text DEFAULT 'owner', workspace_id text,
      created_at timestamptz DEFAULT '2026-09-01', updated_at timestamptz DEFAULT '2026-09-01',
      metadata jsonb DEFAULT '{"ephemeral":true}', parent_id text, file_id text,
      knowledge_base_id text, file_type text DEFAULT 'text/plain'
    );
    CREATE TABLE global_files (url text, hash_id text PRIMARY KEY);
    CREATE TABLE file_uploads (id text PRIMARY KEY, pathname text, status text, file_id text REFERENCES files(id) ON DELETE SET NULL);
    CREATE TABLE messages (id text PRIMARY KEY, content text);
    CREATE TABLE messages_files (message_id text REFERENCES messages(id), file_id text REFERENCES files(id) ON DELETE CASCADE)
  `);
  await client.exec(
    readFileSync('packages/database/migrations/0164_ephemeral_storage_deletions.sql', 'utf8'),
  );
});
afterAll(async () => {
  await client.close();
});
beforeEach(async () => {
  await client.exec(
    `TRUNCATE files, documents, global_files, file_uploads, messages, messages_files, ephemeral_storage_deletions`,
  );
});

describe('ephemeral resource retention inspection', () => {
  it('selects only strictly boolean ephemeral rows aged at least seven days across both tables', async () => {
    await client.exec(`
      INSERT INTO files (id, created_at, metadata) VALUES
        ('old-file', '2026-09-01', '{"ephemeral":true}'),
        ('boundary', '2026-09-16', '{"ephemeral":true}'),
        ('recent', '2026-09-16 00:00:00.001+00', '{"ephemeral":true}'),
        ('saved', '2026-09-01', '{"ephemeral":false}'),
        ('string-flag', '2026-09-01', '{"ephemeral":"true"}'),
        ('missing', '2026-09-01', NULL);
      INSERT INTO documents (id) VALUES ('old-document')
    `);
    const result = await selectExpiredEphemeralResources(database, { now });
    expect(result.cutoff).toBe('2026-09-16T00:00:00.000Z');
    expect(result.candidates.map(({ id }) => id)).toEqual(['old-document', 'old-file', 'boundary']);
  });

  it('enforces a combined deterministic bound and rejects unsafe configuration', async () => {
    await client.exec(`
      INSERT INTO files (id) VALUES ('b'), ('a');
      INSERT INTO documents (id) VALUES ('c')
    `);
    const result = await selectExpiredEphemeralResources(database, { batchSize: 2, now });
    expect(result.candidates.map(({ id }) => id)).toEqual(['c', 'a']);
    for (const batchSize of [0, -1, 1.5, 501, Infinity]) {
      await expect(selectExpiredEphemeralResources(database, { batchSize, now })).rejects.toThrow(
        RangeError,
      );
    }
    for (const retentionMilliseconds of [0, -1, NaN, Infinity]) {
      await expect(
        selectExpiredEphemeralResources(database, { now, retentionMilliseconds }),
      ).rejects.toThrow(RangeError);
    }
    await expect(selectExpiredEphemeralResources(database, { now: new Date(NaN) })).rejects.toThrow(
      RangeError,
    );
  });

  it('rechecks promotion, disappearance, owner changes and timestamp changes after selection', async () => {
    await client.exec(
      `INSERT INTO files (id) VALUES ('promoted'), ('gone'), ('changed'), ('owner')`,
    );
    const batch = await selectExpiredEphemeralResources(database, { now });
    await client.exec(`
      UPDATE files SET metadata = '{"ephemeral":false}' WHERE id = 'promoted';
      DELETE FROM files WHERE id = 'gone';
      UPDATE files SET updated_at = '2026-09-22' WHERE id = 'changed';
      UPDATE files SET user_id = 'other' WHERE id = 'owner'
    `);
    const statuses = Object.fromEntries(
      await Promise.all(
        batch.candidates.map(async (candidate) => [
          candidate.id,
          await revalidateExpiredEphemeralResource(database, candidate, batch.cutoff),
        ]),
      ),
    );
    expect(statuses).toEqual({
      changed: 'changed',
      gone: 'no-longer-expired-or-ephemeral',
      owner: 'changed',
      promoted: 'no-longer-expired-or-ephemeral',
    });
  });

  it('marks shared storage and recursive or linked documents as protected without deleting anything', async () => {
    await client.exec(`
      INSERT INTO files (id, url, file_hash) VALUES
        ('shared-a', 'shared', NULL), ('shared-b', 'shared', NULL),
        ('hashed', 'hashed', 'hash'), ('global', 'global', NULL);
      INSERT INTO global_files (url, hash_id) VALUES ('global', 'global-hash');
      INSERT INTO documents (id, file_id, file_type, workspace_id) VALUES
        ('linked', 'shared-a', 'text/plain', NULL),
        ('folder', NULL, 'custom/folder', NULL),
        ('workspace', NULL, 'text/plain', 'workspace')
    `);
    const report = await inspectEphemeralResourceCleanup(database, { now });
    expect(report.mode).toBe('inspection-only');
    expect(report.deleted).toBe(0);
    expect(report.inspections).toHaveLength(7);
    expect(report.inspections.filter(({ status }) => status === 'protected')).toHaveLength(4);
    expect((await selectExpiredEphemeralResources(database, { now })).candidates).toHaveLength(7);
  });

  it('never treats a successful recheck as permission to delete, including late storage sharing', async () => {
    await client.exec(`INSERT INTO files (id, url) VALUES ('candidate', 'object')`);
    const batch = await selectExpiredEphemeralResources(database, { now });
    const candidate = batch.candidates[0]!;
    await expect(
      revalidateExpiredEphemeralResource(database, candidate, batch.cutoff),
    ).resolves.toBe('requires-atomic-cleanup');
    await client.exec(
      `INSERT INTO files (id, url, metadata) VALUES ('saved-copy', 'object', '{"ephemeral":false}')`,
    );
    await expect(
      revalidateExpiredEphemeralResource(database, candidate, batch.cutoff),
    ).resolves.toBe('requires-atomic-cleanup');
    expect((await inspectEphemeralResourceCleanup(database, { now })).deleted).toBe(0);
  });
});

describe('transactional ephemeral document expiry', () => {
  it('continues beyond protected rows using the returned cursor', async () => {
    await client.exec(`INSERT INTO files(id, created_at) VALUES ('protected-first', '2026-08-01');
      INSERT INTO documents(id) VALUES ('later-document')`);
    const first = await sweepExpiredEphemeralResources(database, { batchSize: 1, now });
    expect(first.deleted).toBe(0);
    expect(first.nextCursor?.id).toBe('protected-first');
    const second = await sweepExpiredEphemeralResources(database, {
      after: first.nextCursor,
      batchSize: 1,
      now,
    });
    expect(second.deleted).toBe(1);
    expect(second.results[0]?.id).toBe('later-document');
  });
  it('deletes an expired standalone document but retains a recent or promoted document', async () => {
    await client.exec(`INSERT INTO documents (id, created_at, metadata) VALUES
      ('expired', '2026-09-16', '{"ephemeral":true}'),
      ('recent', '2026-09-16 00:00:00.001+00', '{"ephemeral":true}'),
      ('saved', '2026-09-01', '{"ephemeral":false}')`);
    const report = await sweepExpiredEphemeralResources(database, { now });
    expect(report.deleted).toBe(1);
    expect(report.failed).toBe(0);
    expect((await client.query('SELECT id FROM documents ORDER BY id')).rows).toEqual([
      { id: 'recent' },
      { id: 'saved' },
    ]);
    expect((await sweepExpiredEphemeralResources(database, { now })).deleted).toBe(0);
  });

  it('retains linked, shared and object-backed resources without attempting storage deletion', async () => {
    await client.exec(`INSERT INTO files (id, url) VALUES ('object', 'object-key');
      INSERT INTO documents (id, file_id) VALUES ('linked', 'object');
      INSERT INTO documents (id, parent_id) VALUES ('parent', NULL), ('child', 'parent')`);
    const report = await sweepExpiredEphemeralResources(database, { now });
    expect(report.deleted).toBe(0);
    expect(report.results.every(({ status }) => status === 'protected')).toBe(true);
  });

  it('rolls back a failed delete and retries successfully', async () => {
    await client.exec(`INSERT INTO documents (id) VALUES ('retry');
      CREATE FUNCTION reject_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'temporary failure'; END $$;
      CREATE TRIGGER cleanup_failure BEFORE DELETE ON documents
        FOR EACH ROW EXECUTE FUNCTION reject_cleanup()`);
    try {
      const report = await sweepExpiredEphemeralResources(database, { now });
      expect(report.failed).toBe(1);
      expect(report.deleted).toBe(0);
      expect((await client.query('SELECT id FROM documents')).rows).toEqual([{ id: 'retry' }]);
    } finally {
      await client.exec(
        'DROP TRIGGER cleanup_failure ON documents; DROP FUNCTION reject_cleanup()',
      );
    }
    expect((await sweepExpiredEphemeralResources(database, { now })).deleted).toBe(1);
  });

  it('protects a referenced document using database foreign key discovery', async () => {
    await client.exec(`CREATE TABLE cleanup_reference (document_id text REFERENCES documents(id));
      INSERT INTO documents(id) VALUES ('referenced');
      INSERT INTO cleanup_reference VALUES ('referenced')`);
    try {
      const report = await sweepExpiredEphemeralResources(database, { now });
      expect(report.deleted).toBe(0);
      expect(report.results[0]?.status).toBe('protected-reference');
    } finally {
      await client.exec('DROP TABLE cleanup_reference');
    }
  });
});

describe('expiry race protection', () => {
  it('rechecks promotion after selection before deleting', async () => {
    await client.exec(`INSERT INTO documents(id) VALUES ('late-save')`);
    const interleaved = {
      execute: database.execute.bind(database),
      transaction: (async (callback: Parameters<LobeChatDatabase['transaction']>[0]) => {
        await client.exec(`UPDATE documents SET metadata = '{}' WHERE id = 'late-save'`);
        return database.transaction(callback);
      }) as LobeChatDatabase['transaction'],
    };
    const report = await sweepExpiredEphemeralResources(interleaved, { now });
    expect(report.deleted).toBe(0);
    expect(report.results[0]?.status).toBe('no-longer-expired-or-ephemeral');
  });

  it('atomically removes an unshared file and preserves its storage deletion task', async () => {
    await client.exec(`INSERT INTO files(id, url) VALUES ('object-only', 'unique-key')`);
    const report = await sweepExpiredEphemeralResources(database, { now });
    expect(report.deleted).toBe(1);
    expect(report.results[0]?.status).toBe('deleted');
    expect((await client.query('SELECT id, url FROM files')).rows).toEqual([]);
    expect(
      (await client.query('SELECT object_key, state FROM ephemeral_storage_deletions')).rows,
    ).toEqual([{ object_key: 'unique-key', state: 'pending' }]);
  });
});

describe('durable object deletion', () => {
  const workerTime = new Date('2030-01-01T00:00:00Z');

  it('deletes storage after commit, removes attachments and retains message text', async () => {
    await client.exec(`INSERT INTO files(id, url) VALUES ('expired-file', 'object-key');
      INSERT INTO messages VALUES ('message', 'retained text');
      INSERT INTO messages_files VALUES ('message', 'expired-file')`);
    expect((await sweepExpiredEphemeralResources(database, { now })).deleted).toBe(1);
    const keys: string[] = [];
    const report = await sweepEphemeralStorageDeletions(database, {
      now: workerTime,
      storage: {
        deleteFile: async (key) => {
          expect((await client.query('SELECT * FROM files')).rows).toHaveLength(0);
          keys.push(key);
          return {} as never;
        },
      },
    });
    expect(report).toEqual({ deleted: 1, failed: 0, protected: 0 });
    expect(keys).toEqual(['object-key']);
    expect((await client.query('SELECT * FROM messages_files')).rows).toHaveLength(0);
    expect((await client.query('SELECT content FROM messages')).rows).toEqual([
      { content: 'retained text' },
    ]);
  });

  it('retries failed storage deletion while blocking late references, promotions and reservations', async () => {
    await client.exec(`INSERT INTO global_files VALUES ('object', 'hash');
      INSERT INTO files(id, url, file_hash) VALUES ('expired', 'object', 'hash')`);
    await sweepExpiredEphemeralResources(database, { now });
    const failed = await sweepEphemeralStorageDeletions(database, {
      now: workerTime,
      storage: {
        deleteFile: async () => {
          throw new Error('storage unavailable');
        },
      },
    });
    expect(failed.failed).toBe(1);
    for (const query of [
      `INSERT INTO files(id, url, metadata) VALUES ('saved', 'object', '{}')`,
      `INSERT INTO global_files VALUES ('object', 'hash')`,
      `INSERT INTO file_uploads VALUES ('upload', 'object', 'active', NULL)`,
    ])
      await expect(client.exec(query)).rejects.toThrow('reserved for deletion');
    const retried = await sweepEphemeralStorageDeletions(database, {
      now: new Date(workerTime.getTime() + 300_000),
      storage: { deleteFile: async () => ({}) as never },
    });
    expect(retried.deleted).toBe(1);
    await client.exec(`INSERT INTO files(id, url, file_hash) VALUES ('same-content-new-key', 'other-key', 'hash')`);
    expect(
      (await client.query('SELECT state, attempts FROM ephemeral_storage_deletions')).rows,
    ).toEqual([{ state: 'deleted', attempts: 2 }]);
    await expect(
      client.exec(`INSERT INTO file_uploads VALUES ('late', 'object', 'active', NULL)`),
    ).rejects.toThrow('reserved for deletion');
  });

  it('protects a durable shared copy while expiring only the temporary file', async () => {
    await client.exec(`INSERT INTO global_files VALUES ('shared-key', 'shared-hash');
      INSERT INTO files(id, url, file_hash, metadata) VALUES
        ('temporary', 'shared-key', 'shared-hash', '{"ephemeral":true}'),
        ('saved', 'shared-key', 'shared-hash', '{}')`);
    expect((await sweepExpiredEphemeralResources(database, { now })).deleted).toBe(1);
    const report = await sweepEphemeralStorageDeletions(database, {
      now: workerTime,
      storage: {
        deleteFile: async () => {
          throw new Error('must not delete');
        },
      },
    });
    expect(report).toEqual({ deleted: 0, failed: 0, protected: 1 });
    expect((await client.query('SELECT id FROM files')).rows).toEqual([{ id: 'saved' }]);
    expect((await client.query('SELECT * FROM global_files')).rows).toHaveLength(1);
  });

  it('rechecks references created between enqueue and claim, including active uploads', async () => {
    await client.exec(
      `INSERT INTO files(id, url) VALUES ('first', 'first-key'), ('second', 'second-key')`,
    );
    await sweepExpiredEphemeralResources(database, { now });
    await client.exec(`INSERT INTO files(id, url, metadata) VALUES ('late-save', 'first-key', '{}');
      INSERT INTO file_uploads VALUES ('upload', 'second-key', 'active', NULL)`);
    const report = await sweepEphemeralStorageDeletions(database, {
      now: workerTime,
      storage: {
        deleteFile: async () => {
          throw new Error('must not delete');
        },
      },
    });
    expect(report).toEqual({ deleted: 0, failed: 0, protected: 2 });
  });

  it('blocks a writer inside the storage call after a durable claim', async () => {
    await client.exec(`INSERT INTO files(id, url) VALUES ('expired', 'race-key')`);
    await sweepExpiredEphemeralResources(database, { now });
    const report = await sweepEphemeralStorageDeletions(database, {
      now: workerTime,
      storage: {
        deleteFile: async () => {
          await expect(
            client.exec(
              `INSERT INTO files(id, url, metadata) VALUES ('racing-save', 'race-key', '{}')`,
            ),
          ).rejects.toThrow('reserved for deletion');
          return {} as never;
        },
      },
    });
    expect(report.deleted).toBe(1);
  });

  it('rolls back the queue when database deletion fails', async () => {
    await client.exec(`INSERT INTO files(id, url) VALUES ('rollback', 'rollback-key');
      CREATE FUNCTION reject_file_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'failure'; END $$;
      CREATE TRIGGER file_cleanup_failure BEFORE DELETE ON files FOR EACH ROW EXECUTE FUNCTION reject_file_cleanup()`);
    try {
      expect((await sweepExpiredEphemeralResources(database, { now })).failed).toBe(1);
      expect((await client.query('SELECT * FROM ephemeral_storage_deletions')).rows).toHaveLength(
        0,
      );
      expect((await client.query('SELECT * FROM files')).rows).toHaveLength(1);
    } finally {
      await client.exec(
        'DROP TRIGGER file_cleanup_failure ON files; DROP FUNCTION reject_file_cleanup()',
      );
    }
  });
});

it('finishes hashed object cleanup after an upload reservation becomes terminal', async () => {
  await client.exec(`INSERT INTO global_files VALUES ('reserved-key', 'reserved-hash');
    INSERT INTO files(id, url, file_hash) VALUES ('expired-reserved', 'reserved-key', 'reserved-hash');
    INSERT INTO file_uploads VALUES ('reserved', 'reserved-key', 'active', NULL)`);
  await sweepExpiredEphemeralResources(database, { now });
  const storage = { deleteFile: async () => ({}) as never };
  const workerTime = new Date('2030-01-01T00:00:00Z');
  expect(
    (await sweepEphemeralStorageDeletions(database, { now: workerTime, storage })).protected,
  ).toBe(1);
  await client.exec(`UPDATE file_uploads SET status = 'settled' WHERE id = 'reserved'`);
  expect(
    (
      await sweepEphemeralStorageDeletions(database, {
        now: new Date(workerTime.getTime() + 3600_000),
        storage,
      })
    ).deleted,
  ).toBe(1);
  expect((await client.query('SELECT * FROM global_files')).rows).toHaveLength(0);
});

it('sweeps queued storage even when there are no remaining candidate rows', async () => {
  await client.exec(
    `INSERT INTO ephemeral_storage_deletions(object_key, retry_at) VALUES ('queued', '2020-01-01')`,
  );
  const report = await sweepExpiredEphemeralResources(database, {
    now,
    storage: { deleteFile: async () => ({}) as never },
  });
  expect(report.deleted).toBe(0);
  expect(report.storage?.deleted).toBe(1);
  expect(report.failed).toBe(0);
});
