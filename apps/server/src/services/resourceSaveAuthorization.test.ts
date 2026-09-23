import { describe, expect, it, vi } from 'vitest';

import {
  assertResourceSaveSession,
  consumeResourceSaveAuthorization,
  issueResourceSaveAuthorization,
  resourceSaveDigest,
} from './resourceSaveAuthorization';

const context = (rows: unknown[] = [{ token: 'once' }]) => ({
  resourceSaveSession: true,
  serverDB: { execute: vi.fn().mockResolvedValue({ rows }) } as any,
  userId: 'owner',
});

describe('resource save authorization', () => {
  it('rejects tool, API key and absent browser authentication before database access', async () => {
    for (const identity of [
      { resourceSaveSession: false },
      { actingAgentId: 'agent' },
      { apiKeyScopes: null },
    ]) {
      const caller = { ...context(), ...identity };
      expect(() => assertResourceSaveSession(caller)).toThrow();
      await expect(issueResourceSaveAuthorization(caller, 'createFile', {})).rejects.toThrow();
      expect(caller.serverDB.execute).not.toHaveBeenCalled();
    }
  });
  it('rejects missing authorization', async () => {
    const caller = context();
    await expect(consumeResourceSaveAuthorization(caller, 'createDocument', {})).rejects.toThrow();
    expect(caller.serverDB.execute).not.toHaveBeenCalled();
  });
  it('rejects expired, mismatched and consumed grants when conditional deletion finds no row', async () => {
    await expect(
      consumeResourceSaveAuthorization(context([]), 'createDocument', {}, 'token'),
    ).rejects.toThrow();
  });
  it('accepts exactly one atomically consumed grant', async () => {
    const caller = context();
    await consumeResourceSaveAuthorization(caller, 'createDocument', { title: 'saved' }, 'token');
    expect(caller.serverDB.execute).toHaveBeenCalledTimes(2);
  });
  it('binds dates rather than collapsing them to empty objects', () => {
    expect(resourceSaveDigest(new Date('2026-01-01'))).not.toBe(
      resourceSaveDigest(new Date('2026-01-02')),
    );
  });
  it('binds content, destination, and batch ordering while normalizing object order', () => {
    expect(resourceSaveDigest({ title: 'one', content: 'two' })).toBe(
      resourceSaveDigest({ content: 'two', title: 'one' }),
    );
    expect(resourceSaveDigest({ content: 'one' })).not.toBe(resourceSaveDigest({ content: 'two' }));
    expect(resourceSaveDigest({ parentId: 'one' })).not.toBe(
      resourceSaveDigest({ parentId: 'two' }),
    );
    expect(resourceSaveDigest(['one', 'two'])).not.toBe(resourceSaveDigest(['two', 'one']));
  });
});
