import { beforeEach, describe, expect, it, vi } from 'vitest';

import { lambdaClient } from '@/libs/trpc/client';
import { confirmResourceSave, ResourceSaveCancelledError } from '@/services/confirmResourceSave';

import { DocumentService } from './index';

vi.mock('@/libs/trpc/client', () => ({ lambdaClient: { document: {
  createDocument: { mutate: vi.fn() },
  requestSaveAuthorization: { mutate: vi.fn() },
} } }));
vi.mock('@/services/confirmResourceSave', () => ({
  confirmResourceSave: vi.fn(),
  ResourceSaveCancelledError: class extends Error {},
}));

const payload = { content: 'read content', editorData: '{}', title: 'Article' };

describe('document saving intent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(lambdaClient.document.requestSaveAuthorization.mutate).mockResolvedValue({ token: 'grant' } as any);
  });

  it('does not request authorization or create a document when confirmation is declined', async () => {
    vi.mocked(confirmResourceSave).mockRejectedValue(new ResourceSaveCancelledError());
    await expect(new DocumentService().createDocument(payload)).rejects.toBeInstanceOf(ResourceSaveCancelledError);
    expect(lambdaClient.document.requestSaveAuthorization.mutate).not.toHaveBeenCalled();
    expect(lambdaClient.document.createDocument.mutate).not.toHaveBeenCalled();
  });

  it('uses one content-bound authorization after the explicit save button without a second confirmation', async () => {
    await new DocumentService().saveDocumentToResource(payload);
    expect(confirmResourceSave).not.toHaveBeenCalled();
    expect(lambdaClient.document.requestSaveAuthorization.mutate).toHaveBeenCalledWith({ operation: 'createDocument', payload });
    expect(lambdaClient.document.createDocument.mutate).toHaveBeenCalledWith({ ...payload, saveAuthorization: 'grant' });
  });
});
