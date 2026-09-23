import { beforeEach, describe, expect, it, vi } from 'vitest';

import { documentRouter } from '@/server/routers/lambda/document';
import { fileRouter } from '@/server/routers/lambda/file';

const mocks = vi.hoisted(() => ({
  execute: vi.fn().mockResolvedValue({ rows: [{ token: 'saved' }] }),
  restrictedFile: vi.fn(),
  restrictedDocuments: vi.fn(),
  documentModel: {
    copyToWorkspace: vi.fn(),
    countFileUsageInSubtree: vi.fn(),
    findById: vi.fn(),
    findByIds: vi.fn(),
    update: vi.fn(),
  },
  fileModel: {
    copyToWorkspace: vi.fn(),
    findById: vi.fn(),
    findByIds: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('@/config/db', () => ({
  serverDBEnv: { REMOVE_GLOBAL_FILE: false },
}));

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(function () {
    const database = {
      execute: mocks.execute,
      transaction: async (callback: (transaction: unknown) => unknown): Promise<unknown> => callback(database),
    };
    return database;
  }),
}));

vi.mock('@/business/server/lambda-routers/file', () => ({
  businessFileTransferStorageCheck: vi.fn(),
  businessFileUploadCheck: vi.fn(),
}));

vi.mock('@/business/server/document-mention/notifyActivity', () => ({
  notifyDocumentMention: vi.fn(),
}));

vi.mock('@/database/models/asyncTask', () => ({
  AsyncTaskModel: vi.fn(function () {
    return {};
  }),
}));
vi.mock('@/database/models/chunk', () => ({
  ChunkModel: vi.fn(function () {
    return {};
  }),
}));
vi.mock('@/database/models/knowledgeBase', () => ({
  KnowledgeBaseModel: vi.fn(function () {
    return {};
  }),
}));
vi.mock('@/database/models/message', () => ({
  MessageModel: vi.fn(function () {
    return {};
  }),
}));
vi.mock('@/database/repositories/knowledge', () => ({
  KnowledgeRepo: vi.fn(function () {
    return {};
  }),
}));
vi.mock('@/server/services/document', () => ({
  DocumentService: vi.fn(function () {
    return {};
  }),
}));
vi.mock('@/server/services/file', () => ({
  FileService: vi.fn(function () {
    return {};
  }),
}));
vi.mock('@/server/services/fileUpload', () => ({
  FileUploadService: vi.fn(function () {
    return {};
  }),
}));

vi.mock('@/database/models/file', () => ({
  FileModel: vi.fn(function () {
    return mocks.fileModel;
  }),
}));

vi.mock('@/database/models/document', () => ({
  DOCUMENT_TRANSFER_FOREIGN_ROWS: [],
  DocumentModel: vi.fn(function () {
    return mocks.documentModel;
  }),
}));

vi.mock('@/server/services/knowledgeBaseAccess', () => ({
  assertFileNotInRestrictedKnowledgeBase: mocks.restrictedFile,
  assertContentsNotInRestrictedKnowledgeBase: mocks.restrictedDocuments,
}));

vi.mock('@/server/services/workspacePermission', () => ({
  hasWorkspaceScopedPermission: vi.fn(async () => true),
}));

const saveAuthorization = '00000000-0000-4000-8000-000000000001';
const createCtx = () => ({ resourceSaveSession: true, serverDB: {}, userId: 'user-1', workspaceId: null }) as any;

describe('fileRouter ephemeral procedures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const fileCaller = () => fileRouter.createCaller(createCtx());

  describe('promoteFile', () => {
    it('rejects a missing grant before updating the file', async () => {
      mocks.fileModel.findById.mockResolvedValue({ id: 'file-1', metadata: { ephemeral: true } });
      await expect(fileCaller().promoteFile({ id: 'file-1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.fileModel.update).not.toHaveBeenCalled();
    });

    it('rejects API callers even with a grant', async () => {
      mocks.fileModel.findById.mockResolvedValue({ id: 'file-1', metadata: { ephemeral: true } });
      const caller = fileRouter.createCaller({ ...createCtx(), apiKeyScopes: null });
      await expect(caller.promoteFile({ id: 'file-1', saveAuthorization })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.fileModel.update).not.toHaveBeenCalled();
    });

    it('should remove only the ephemeral key and keep other metadata', async () => {
      mocks.fileModel.findById.mockResolvedValue({
        id: 'file-1',
        metadata: { ephemeral: true, source: 'page-editor' },
      });

      const result = await fileCaller().promoteFile({ saveAuthorization, id: 'file-1' });

      expect(result).toEqual({ success: true });
      expect(mocks.fileModel.update).toHaveBeenCalledWith('file-1', {
        metadata: { source: 'page-editor' },
      });
    });

    it('should be idempotent for non-ephemeral files', async () => {
      mocks.fileModel.findById.mockResolvedValue({
        id: 'file-2',
        metadata: { source: 'page-editor' },
      });

      const result = await fileCaller().promoteFile({ saveAuthorization, id: 'file-2' });

      expect(result).toEqual({ success: true });
      expect(mocks.fileModel.update).not.toHaveBeenCalled();
    });

    it('should throw NOT_FOUND when the file does not exist', async () => {
      mocks.fileModel.findById.mockResolvedValue(undefined);

      await expect(fileCaller().promoteFile({ saveAuthorization, id: 'missing' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('copyEntityToWorkspace', () => {
    it('rejects a copy without a consumed user grant', async () => {
      mocks.fileModel.findById.mockResolvedValue({ id: 'file-1', metadata: {}, size: 1 });
      await expect(
        fileCaller().copyEntityToWorkspace({ entityType: 'file', id: 'file-1', targetWorkspaceId: null }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.fileModel.copyToWorkspace).not.toHaveBeenCalled();
    });

    it('copies an unchanged file after a one-time grant', async () => {
      const file = { id: 'file-1', metadata: {}, size: 1 };
      mocks.fileModel.findById.mockResolvedValue(file);
      const { token } = await fileCaller().requestSaveAuthorization({
        operation: 'copyEntityToWorkspace',
        payload: { entityType: 'file', id: 'file-1', targetWorkspaceId: null },
      });
      await fileCaller().copyEntityToWorkspace({
        entityType: 'file',
        id: 'file-1',
        saveAuthorization: token,
        targetWorkspaceId: null,
      });
      expect(mocks.fileModel.copyToWorkspace).toHaveBeenCalled();
    });

    it('copies a folder after a grant and checks subtree size', async () => {
      const folder = { fileType: 'custom/folder', id: 'doc-1', metadata: {} };
      mocks.documentModel.findById.mockResolvedValue(folder);
      mocks.documentModel.countFileUsageInSubtree.mockResolvedValue(10);
      const { token } = await fileCaller().requestSaveAuthorization({
        operation: 'copyEntityToWorkspace',
        payload: { entityType: 'folder', id: 'doc-1', targetWorkspaceId: null },
      });
      await fileCaller().copyEntityToWorkspace({
        entityType: 'folder',
        id: 'doc-1',
        saveAuthorization: token,
        targetWorkspaceId: null,
      });
      expect(mocks.documentModel.copyToWorkspace).toHaveBeenCalled();
    });
  });

  describe('getEphemeralStatus', () => {
    it('should report ephemeral flags only for files owned by the caller', async () => {
      mocks.fileModel.findByIds.mockResolvedValue([
        { id: 'file-1', metadata: { ephemeral: true } },
        { id: 'file-2', metadata: {} },
      ]);

      const result = await fileCaller().getEphemeralStatus({ ids: ['file-1', 'file-2', 'file-3'] });

      expect(result).toEqual({ 'file-1': true, 'file-2': false });
      // 只应答本人记录：findByIds 已带 ownership 过滤，这里校验入参透传
      expect(mocks.fileModel.findByIds).toHaveBeenCalledWith(['file-1', 'file-2', 'file-3']);
    });
  });
});

describe('documentRouter ephemeral procedures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const documentCaller = () => documentRouter.createCaller(createCtx());

  describe('promoteDocument', () => {
    it('should clear the ephemeral key on the document', async () => {
      mocks.documentModel.findById.mockResolvedValue({
        id: 'doc-1',
        metadata: { ephemeral: true, origin: 'agent' },
      });

      const result = await documentCaller().promoteDocument({ saveAuthorization, id: 'doc-1' });

      expect(result).toEqual({ success: true });
      expect(mocks.documentModel.update).toHaveBeenCalledWith('doc-1', {
        metadata: { origin: 'agent' },
      });
    });

    it('should also promote the linked file when it is still ephemeral', async () => {
      mocks.documentModel.findById.mockResolvedValue({
        fileId: 'file-9',
        id: 'doc-1',
        metadata: { ephemeral: true },
      });
      mocks.fileModel.findById.mockResolvedValue({
        id: 'file-9',
        metadata: { ephemeral: true, other: 1 },
      });

      await documentCaller().promoteDocument({ saveAuthorization, id: 'doc-1' });

      expect(mocks.fileModel.update).toHaveBeenCalledWith('file-9', { metadata: { other: 1 } });
    });

    it('should not touch the linked file when it is not ephemeral', async () => {
      mocks.documentModel.findById.mockResolvedValue({
        fileId: 'file-9',
        id: 'doc-1',
        metadata: { ephemeral: true },
      });
      mocks.fileModel.findById.mockResolvedValue({ id: 'file-9', metadata: {} });

      await documentCaller().promoteDocument({ saveAuthorization, id: 'doc-1' });

      expect(mocks.fileModel.update).not.toHaveBeenCalled();
    });

    it('should throw NOT_FOUND when the document does not exist', async () => {
      mocks.documentModel.findById.mockResolvedValue(undefined);

      await expect(documentCaller().promoteDocument({ saveAuthorization, id: 'missing' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });
});
