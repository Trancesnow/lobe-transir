import { beforeEach, describe, expect, it, vi } from 'vitest';

import { documentRouter } from '@/server/routers/lambda/document';
import { fileRouter } from '@/server/routers/lambda/file';

const mocks = vi.hoisted(() => ({
  documentModel: {
    findById: vi.fn(),
    findByIds: vi.fn(),
    update: vi.fn(),
  },
  fileModel: {
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
    return {};
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

const createCtx = () => ({ serverDB: {}, userId: 'user-1', workspaceId: null }) as any;

describe('fileRouter ephemeral procedures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const fileCaller = () => fileRouter.createCaller(createCtx());

  describe('promoteFile', () => {
    it('should remove only the ephemeral key and keep other metadata', async () => {
      mocks.fileModel.findById.mockResolvedValue({
        id: 'file-1',
        metadata: { ephemeral: true, source: 'page-editor' },
      });

      const result = await fileCaller().promoteFile({ id: 'file-1' });

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

      const result = await fileCaller().promoteFile({ id: 'file-2' });

      expect(result).toEqual({ success: true });
      expect(mocks.fileModel.update).not.toHaveBeenCalled();
    });

    it('should throw NOT_FOUND when the file does not exist', async () => {
      mocks.fileModel.findById.mockResolvedValue(undefined);

      await expect(fileCaller().promoteFile({ id: 'missing' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
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

      const result = await documentCaller().promoteDocument({ id: 'doc-1' });

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

      await documentCaller().promoteDocument({ id: 'doc-1' });

      expect(mocks.fileModel.update).toHaveBeenCalledWith('file-9', { metadata: { other: 1 } });
    });

    it('should not touch the linked file when it is not ephemeral', async () => {
      mocks.documentModel.findById.mockResolvedValue({
        fileId: 'file-9',
        id: 'doc-1',
        metadata: { ephemeral: true },
      });
      mocks.fileModel.findById.mockResolvedValue({ id: 'file-9', metadata: {} });

      await documentCaller().promoteDocument({ id: 'doc-1' });

      expect(mocks.fileModel.update).not.toHaveBeenCalled();
    });

    it('should throw NOT_FOUND when the document does not exist', async () => {
      mocks.documentModel.findById.mockResolvedValue(undefined);

      await expect(documentCaller().promoteDocument({ id: 'missing' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });
});
