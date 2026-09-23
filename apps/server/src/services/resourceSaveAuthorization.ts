import { createHash, randomUUID } from 'node:crypto';

import { TRPCError } from '@trpc/server';
import { sql } from 'drizzle-orm';

import type { LobeChatDatabase } from '@/database/type';

export interface ResourceSaveContext {
  actingAgentId?: string | null;
  apiKeyScopes?: string[] | null;
  resourceSaveSession?: boolean;
  serverDB: LobeChatDatabase;
  userId: string;
  workspaceId?: string | null;
}

export const assertResourceSaveSession = (context: ResourceSaveContext) => {
  if (!context.resourceSaveSession || context.actingAgentId || context.apiKeyScopes !== undefined) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Explicit save requires a user browser session',
    });
  }
};

const canonicalize = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
};

export const resourceSaveDigest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');

export const issueResourceSaveAuthorization = async (
  context: ResourceSaveContext,
  operation: string,
  payload: unknown,
) => {
  assertResourceSaveSession(context);
  const token = randomUUID();
  const digest = resourceSaveDigest(payload);
  await context.serverDB.execute(sql`INSERT INTO resource_save_authorizations
    (token, user_id, workspace_id, operation, content_digest, expires_at)
    VALUES (${token}, ${context.userId}, ${context.workspaceId ?? ''}, ${operation}, ${digest}, now() + interval '5 minutes')`);
  return { token };
};

export const consumeResourceSaveAuthorization = async (
  context: ResourceSaveContext,
  operation: string,
  payload: unknown,
  token?: string,
) => {
  assertResourceSaveSession(context);
  if (!token)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Save to resources must be confirmed' });
  const digest = resourceSaveDigest(payload);
  const result = await context.serverDB.execute(sql`DELETE FROM resource_save_authorizations
    WHERE token = ${token} AND user_id = ${context.userId}
    AND workspace_id = ${context.workspaceId ?? ''} AND operation = ${operation}
    AND content_digest = ${digest} AND expires_at > now() RETURNING token`);
  if (result.rows.length !== 1) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Save authorization expired, changed or already used',
    });
  }
  await enableAuthorizedResourceSave(context);
};

/** The database trigger trusts this transaction-local marker, never request metadata. */
const enableAuthorizedResourceSave = async (context: ResourceSaveContext) => {
  assertResourceSaveSession(context);
  await context.serverDB.execute(
    sql`SELECT set_config('lobehub.resource_save_user', ${context.userId}, true),
      set_config('lobehub.resource_save_workspace', ${context.workspaceId ?? ''}, true)`, 
  );
};

/**
 * After a grant is consumed, a copy may persist rows in a workspace other than
 * the caller's current one. Point the trigger marker at the actual target;
 * never widen the user marker.
 */
export const markAuthorizedResourceSaveWorkspace = async (
  context: ResourceSaveContext,
  targetWorkspaceId?: string | null,
) => {
  assertResourceSaveSession(context);
  await context.serverDB.execute(
    sql`SELECT set_config('lobehub.resource_save_workspace', ${targetWorkspaceId ?? ''}, true)`,
  );
};
