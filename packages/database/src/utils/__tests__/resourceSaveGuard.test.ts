// @vitest-environment node
import { readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let database: PGlite;
const authorize = `SELECT set_config('lobehub.resource_save_user','owner',true), set_config('lobehub.resource_save_workspace','',true)`;

describe('resource save database guard', () => {
  beforeEach(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE TABLE users(id text primary key);
      INSERT INTO users VALUES ('owner');
      CREATE TABLE documents(id text primary key,user_id text,metadata jsonb,source_type text,workspace_id text,knowledge_base_id text);
      CREATE TABLE files(id text primary key,user_id text,metadata jsonb,source text,workspace_id text);
      CREATE TABLE works(id text primary key,user_id text,workspace_id text,title text);
    `);
    await database.exec(readFileSync(new URL('../../../migrations/0163_resource_save_authorizations.sql', import.meta.url), 'utf8'));
  }, 30_000);
  afterEach(async () => database.close());

  it('rejects direct document, file and work writers without authorization', async () => {
    for (const statement of [
      `INSERT INTO documents(id,user_id,source_type) VALUES ('d','owner','web')`,
      `INSERT INTO files(id,user_id) VALUES ('f','owner')`,
      `INSERT INTO works(id,user_id) VALUES ('w','owner')`,
    ]) await expect(database.exec(statement)).rejects.toThrow(/authorization required/);
  });

  it('allows temporary records and internal configuration but guards library attachment and promotion', async () => {
    await database.exec(`
      INSERT INTO documents(id,user_id,source_type) VALUES ('internal','owner','agent');
      INSERT INTO files(id,user_id,metadata) VALUES ('temporary','owner','{"ephemeral":true}');
    `);
    for (const statement of [
      `UPDATE files SET metadata='{}' WHERE id='temporary'`,
      `UPDATE documents SET source_type='api' WHERE id='internal'`,
      `UPDATE documents SET knowledge_base_id='library' WHERE id='internal'`,
      `INSERT INTO documents(id,user_id,source_type,knowledge_base_id) VALUES ('library-agent','owner','agent-signal','library')`,
    ]) await expect(database.exec(statement)).rejects.toThrow(/authorization required/);
  });

  it('preserves hidden acceptance evidence while guarding conversion into library files', async () => {
    await database.exec(`INSERT INTO files(id,user_id,source) VALUES ('evidence','owner','acceptance')`);
    await database.exec(`UPDATE files SET metadata='{"edited":true}' WHERE id='evidence'`);
    await expect(database.exec(`UPDATE files SET source=NULL WHERE id='evidence'`)).rejects.toThrow(/authorization required/);
  });

  it('preserves existing updates and work conflict updates without granting new inserts', async () => {
    await database.exec(`BEGIN; ${authorize}; INSERT INTO documents(id,user_id,source_type) VALUES ('approved','owner','api'); INSERT INTO works(id,user_id,title) VALUES ('existing','owner','old'); COMMIT;`);
    await database.exec(`UPDATE documents SET metadata='{"edited":true}' WHERE id='approved'`);
    await database.exec(`INSERT INTO works(id,user_id,title) VALUES ('existing','owner','new') ON CONFLICT(id) DO UPDATE SET title=excluded.title`);
    await database.exec(`INSERT INTO works(id,user_id) VALUES ('existing','owner') ON CONFLICT DO NOTHING`);
    expect((await database.query<{ title: string }>(`SELECT title FROM works WHERE id='existing'`)).rows[0].title).toBe('new');
    await expect(database.exec(`INSERT INTO works(id,user_id) VALUES ('new','owner')`)).rejects.toThrow(/authorization required/);
  });

  it('binds the transaction marker to the workspace and allows authorized shared-owner promotion', async () => {
    await database.exec(`INSERT INTO files(id,user_id,metadata,workspace_id) VALUES ('shared','colleague','{"ephemeral":true}','workspace')`);
    await database.exec(`BEGIN; ${authorize};`);
    await expect(database.exec(`UPDATE files SET metadata='{}' WHERE id='shared'`)).rejects.toThrow(/authorization required/);
    await database.exec('ROLLBACK');
    await database.exec(`BEGIN; SELECT set_config('lobehub.resource_save_user','owner',true), set_config('lobehub.resource_save_workspace','workspace',true); UPDATE files SET metadata='{}' WHERE id='shared'; COMMIT;`);
    await expect(database.exec(`INSERT INTO files(id,user_id,workspace_id) VALUES ('leak','owner','workspace')`)).rejects.toThrow(/authorization required/);
  });

  it('rolls back both consumed grants and inserted resources after a failed save', async () => {
    await database.exec(`INSERT INTO resource_save_authorizations VALUES ('00000000-0000-4000-8000-000000000001','owner','','createDocument','digest',now()+interval '5 minutes')`);
    await database.exec(`BEGIN; DELETE FROM resource_save_authorizations; ${authorize}; INSERT INTO files(id,user_id) VALUES ('rollback','owner'); ROLLBACK;`);
    expect((await database.query<{ count: number }>(`SELECT count(*)::int AS count FROM resource_save_authorizations`)).rows[0].count).toBe(1);
    expect((await database.query<{ count: number }>(`SELECT count(*)::int AS count FROM files`)).rows[0].count).toBe(0);
  });
});
