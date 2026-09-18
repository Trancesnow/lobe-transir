import { type LobeChatDatabase } from '@lobechat/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DocumentModel } from '@/database/models/document';
import { FileModel } from '@/database/models/file';
import { MessageModel } from '@/database/models/message';
import { DocumentService } from '@/server/services/document';
import { FileService } from '@/server/services/file';

import { MessageService } from '../index';

vi.mock('@/config/db', () => ({
  serverDBEnv: { REMOVE_GLOBAL_FILE: false },
}));

vi.mock('@/database/models/message');
vi.mock('@/database/models/file');
vi.mock('@/database/models/document');
vi.mock('@/server/services/file');
vi.mock('@/server/services/document');

describe('MessageService', () => {
  let messageService: MessageService;
  let mockDB: LobeChatDatabase;
  let mockMessageModel: MessageModel;
  let mockFileService: FileService;
  let mockFileModel: FileModel;
  let mockDocumentModel: DocumentModel;
  let mockDocumentService: DocumentService;
  const userId = 'test-user-id';

  beforeEach(() => {
    mockDB = {} as LobeChatDatabase;
    mockMessageModel = {
      create: vi.fn(),
      deleteMessage: vi.fn(),
      deleteMessages: vi.fn(),
      findById: vi.fn().mockResolvedValue(undefined),
      findDocumentIdsReferencedOutsideMessages: vi.fn().mockResolvedValue([]),
      findFileIdsByMessageIds: vi.fn().mockResolvedValue([]),
      findFileIdsReferencedOutsideMessages: vi.fn().mockResolvedValue([]),
      findPluginStatesByToolCallIds: vi.fn().mockResolvedValue([]),
      query: vi.fn(),
      update: vi.fn(),
      updateMessagePlugin: vi.fn(),
      updateMessageRAG: vi.fn(),
      updateMetadata: vi.fn(),
      updatePluginState: vi.fn(),
      updateToolMessage: vi.fn(),
    } as any;

    mockFileService = {
      getFullFileUrl: vi.fn().mockImplementation(function (path) {
        return Promise.resolve(`/files${path}`);
      }),
      deleteFiles: vi.fn().mockResolvedValue(undefined),
    } as any;

    mockFileModel = {
      deleteMany: vi.fn().mockResolvedValue([]),
      findByIds: vi.fn().mockResolvedValue([]),
    } as any;

    mockDocumentModel = {
      findByIds: vi.fn().mockResolvedValue([]),
    } as any;

    mockDocumentService = {
      deleteDocument: vi.fn().mockResolvedValue(undefined),
    } as any;

    // Mock constructors
    vi.mocked(MessageModel).mockImplementation(function () {
      return mockMessageModel;
    });
    vi.mocked(FileService).mockImplementation(function () {
      return mockFileService;
    });
    vi.mocked(FileModel).mockImplementation(function () {
      return mockFileModel;
    });
    vi.mocked(DocumentModel).mockImplementation(function () {
      return mockDocumentModel;
    });
    vi.mocked(DocumentService).mockImplementation(function () {
      return mockDocumentService;
    });

    messageService = new MessageService(mockDB, userId);
  });

  describe('removeMessage', () => {
    it('should delete message and return { success: true } when no sessionId/topicId provided', async () => {
      const messageId = 'msg-1';

      const result = await messageService.removeMessage(messageId);

      expect(mockMessageModel.deleteMessage).toHaveBeenCalledWith(messageId);
      expect(result).toEqual({ success: true });
      expect(mockMessageModel.query).not.toHaveBeenCalled();
    });

    it('should delete message and return message list when sessionId provided', async () => {
      const messageId = 'msg-1';
      const mockMessages = [{ id: 'msg-2', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.removeMessage(messageId, { sessionId: 'session-1' });

      expect(mockMessageModel.deleteMessage).toHaveBeenCalledWith(messageId);
      expect(mockMessageModel.query).toHaveBeenCalledWith(
        { groupId: undefined, sessionId: 'session-1', topicId: undefined },
        expect.objectContaining({
          groupAssistantMessages: false,
        }),
      );
      expect(result).toEqual({ messages: mockMessages, success: true });
    });

    it('should delete message and return message list when topicId provided', async () => {
      const messageId = 'msg-1';
      const mockMessages = [{ id: 'msg-2', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.removeMessage(messageId, { topicId: 'topic-1' });

      expect(mockMessageModel.deleteMessage).toHaveBeenCalledWith(messageId);
      expect(mockMessageModel.query).toHaveBeenCalledWith(
        { groupId: undefined, sessionId: undefined, topicId: 'topic-1' },
        expect.objectContaining({
          groupAssistantMessages: false,
        }),
      );
      expect(result).toEqual({ messages: mockMessages, success: true });
    });
  });

  describe('removeMessage ephemeral cleanup', () => {
    it('should delete ephemeral files referenced only by the deleted message', async () => {
      vi.mocked(mockMessageModel.findById).mockResolvedValue({ id: 'msg-1', tools: [] } as any);
      vi.mocked(mockMessageModel.findFileIdsByMessageIds).mockResolvedValue(['file-1']);
      vi.mocked(mockFileModel.findByIds).mockResolvedValue([
        { id: 'file-1', metadata: { ephemeral: true }, url: 's3://file-1' },
      ] as any);
      vi.mocked(mockFileModel.deleteMany).mockResolvedValue([{ url: 's3://file-1' }] as any);

      await messageService.removeMessage('msg-1');

      expect(mockFileModel.deleteMany).toHaveBeenCalledWith(['file-1'], false);
      expect(mockFileService.deleteFiles).toHaveBeenCalledWith(['s3://file-1']);
      expect(mockMessageModel.deleteMessage).toHaveBeenCalledWith('msg-1');
    });

    it('should keep ephemeral files still referenced by other messages', async () => {
      vi.mocked(mockMessageModel.findById).mockResolvedValue({ id: 'msg-1', tools: [] } as any);
      vi.mocked(mockMessageModel.findFileIdsByMessageIds).mockResolvedValue(['file-1']);
      vi.mocked(mockMessageModel.findFileIdsReferencedOutsideMessages).mockResolvedValue([
        'file-1',
      ]);
      vi.mocked(mockFileModel.findByIds).mockResolvedValue([
        { id: 'file-1', metadata: { ephemeral: true }, url: 's3://file-1' },
      ] as any);

      await messageService.removeMessage('msg-1');

      expect(mockFileModel.deleteMany).not.toHaveBeenCalled();
      expect(mockFileService.deleteFiles).not.toHaveBeenCalled();
      expect(mockMessageModel.deleteMessage).toHaveBeenCalledWith('msg-1');
    });

    it('should not touch non-ephemeral files', async () => {
      vi.mocked(mockMessageModel.findById).mockResolvedValue({ id: 'msg-1', tools: [] } as any);
      vi.mocked(mockMessageModel.findFileIdsByMessageIds).mockResolvedValue(['file-1']);
      vi.mocked(mockFileModel.findByIds).mockResolvedValue([
        { id: 'file-1', metadata: {}, url: 's3://file-1' },
      ] as any);

      await messageService.removeMessage('msg-1');

      expect(mockFileModel.deleteMany).not.toHaveBeenCalled();
      expect(mockMessageModel.deleteMessage).toHaveBeenCalledWith('msg-1');
    });

    it('should delete ephemeral documents from tool cards with no remaining references', async () => {
      vi.mocked(mockMessageModel.findById).mockResolvedValue({
        id: 'msg-1',
        tools: [{ id: 'tool-call-1' }],
      } as any);
      vi.mocked(mockMessageModel.findPluginStatesByToolCallIds).mockResolvedValue([
        { id: 'tool-msg-1', state: { documentId: 'doc-1' } },
      ] as any);
      vi.mocked(mockDocumentModel.findByIds).mockResolvedValue([
        { id: 'doc-1', metadata: { ephemeral: true } },
      ] as any);

      await messageService.removeMessage('msg-1');

      expect(mockDocumentService.deleteDocument).toHaveBeenCalledWith('doc-1');
      expect(mockMessageModel.deleteMessage).toHaveBeenCalledWith('msg-1');
    });

    it('should keep ephemeral documents still referenced by other messages', async () => {
      vi.mocked(mockMessageModel.findById).mockResolvedValue({
        id: 'msg-1',
        tools: [{ id: 'tool-call-1' }],
      } as any);
      vi.mocked(mockMessageModel.findPluginStatesByToolCallIds).mockResolvedValue([
        { id: 'tool-msg-1', state: { documentId: 'doc-1' } },
      ] as any);
      vi.mocked(mockMessageModel.findDocumentIdsReferencedOutsideMessages).mockResolvedValue([
        'doc-1',
      ]);
      vi.mocked(mockDocumentModel.findByIds).mockResolvedValue([]);

      await messageService.removeMessage('msg-1');

      expect(mockDocumentService.deleteDocument).not.toHaveBeenCalled();
      expect(mockMessageModel.deleteMessage).toHaveBeenCalledWith('msg-1');
    });

    it('should skip cleanup entirely when the message does not exist', async () => {
      vi.mocked(mockMessageModel.findById).mockResolvedValue(undefined);

      await messageService.removeMessage('missing');

      expect(mockMessageModel.findFileIdsByMessageIds).not.toHaveBeenCalled();
      expect(mockMessageModel.deleteMessage).toHaveBeenCalledWith('missing');
    });
  });

  describe('removeMessages', () => {
    it('should delete messages and return { success: true } when no sessionId/topicId provided', async () => {
      const messageIds = ['msg-1', 'msg-2'];

      const result = await messageService.removeMessages(messageIds);

      expect(mockMessageModel.deleteMessages).toHaveBeenCalledWith(messageIds);
      expect(result).toEqual({ success: true });
      expect(mockMessageModel.query).not.toHaveBeenCalled();
    });

    it('should delete messages and return message list when sessionId provided', async () => {
      const messageIds = ['msg-1', 'msg-2'];
      const mockMessages = [{ id: 'msg-3', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.removeMessages(messageIds, { sessionId: 'session-1' });

      expect(mockMessageModel.deleteMessages).toHaveBeenCalledWith(messageIds);
      expect(mockMessageModel.query).toHaveBeenCalled();
      expect(result).toEqual({ messages: mockMessages, success: true });
    });
  });

  describe('updateMessageRAG', () => {
    it('should update RAG and return { success: true } when no sessionId/topicId provided', async () => {
      const messageId = 'msg-1';
      const ragValue = { fileChunks: [{ id: 'chunk-1', similarity: 0.95 }] };

      const result = await messageService.updateMessageRAG(messageId, ragValue);

      expect(mockMessageModel.updateMessageRAG).toHaveBeenCalledWith(messageId, ragValue);
      expect(result).toEqual({ success: true });
      expect(mockMessageModel.query).not.toHaveBeenCalled();
    });

    it('should update RAG and return message list when sessionId provided', async () => {
      const messageId = 'msg-1';
      const ragValue = { fileChunks: [{ id: 'chunk-1', similarity: 0.95 }] };
      const mockMessages = [{ id: 'msg-1', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.updateMessageRAG(messageId, ragValue, {
        sessionId: 'session-1',
      });

      expect(mockMessageModel.updateMessageRAG).toHaveBeenCalledWith(messageId, ragValue);
      expect(mockMessageModel.query).toHaveBeenCalled();
      expect(result).toEqual({ messages: mockMessages, success: true });
    });
  });

  describe('updatePluginError', () => {
    it('should update plugin error and return { success: true } when no sessionId/topicId provided', async () => {
      const messageId = 'msg-1';
      const error = { type: 'TestError', message: 'Test error message' };

      const result = await messageService.updatePluginError(messageId, error);

      expect(mockMessageModel.updateMessagePlugin).toHaveBeenCalledWith(messageId, { error });
      expect(result).toEqual({ success: true });
      expect(mockMessageModel.query).not.toHaveBeenCalled();
    });

    it('should update plugin error and return message list when sessionId provided', async () => {
      const messageId = 'msg-1';
      const error = { type: 'TestError', message: 'Test error message' };
      const mockMessages = [{ id: 'msg-1', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.updatePluginError(messageId, error, {
        sessionId: 'session-1',
      });

      expect(mockMessageModel.updateMessagePlugin).toHaveBeenCalledWith(messageId, { error });
      expect(mockMessageModel.query).toHaveBeenCalled();
      expect(result).toEqual({ messages: mockMessages, success: true });
    });
  });

  describe('updatePluginState', () => {
    it('should update plugin state and return { success: true } when no sessionId/topicId provided', async () => {
      const messageId = 'msg-1';
      const state = { key: 'value' };

      const result = await messageService.updatePluginState(messageId, state, {});

      expect(mockMessageModel.updatePluginState).toHaveBeenCalledWith(messageId, state);
      expect(result).toEqual({ success: true });
      expect(mockMessageModel.query).not.toHaveBeenCalled();
    });

    it('should update plugin state and return message list when sessionId provided', async () => {
      const messageId = 'msg-1';
      const state = { key: 'value' };
      const mockMessages = [{ id: 'msg-1', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.updatePluginState(messageId, state, {
        sessionId: 'session-1',
      });

      expect(mockMessageModel.updatePluginState).toHaveBeenCalledWith(messageId, state);
      expect(mockMessageModel.query).toHaveBeenCalled();
      expect(result).toEqual({ messages: mockMessages, success: true });
    });
  });

  describe('updateMessage', () => {
    it('should update message and return { success: true } when no sessionId/topicId provided', async () => {
      const messageId = 'msg-1';
      const value = { content: 'updated content' };

      const result = await messageService.updateMessage(messageId, value as any, {});

      expect(mockMessageModel.update).toHaveBeenCalledWith(messageId, value);
      expect(result).toEqual({ success: true });
      expect(mockMessageModel.query).not.toHaveBeenCalled();
    });

    it('should update message and return message list when sessionId provided', async () => {
      const messageId = 'msg-1';
      const value = { content: 'updated content' };
      const mockMessages = [{ id: 'msg-1', content: 'updated content' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.updateMessage(messageId, value as any, {
        sessionId: 'session-1',
      });

      expect(mockMessageModel.update).toHaveBeenCalledWith(messageId, value);
      expect(mockMessageModel.query).toHaveBeenCalled();
      expect(result).toEqual({ messages: mockMessages, success: true });
    });
  });

  describe('batchMutate', () => {
    it('quietly applies create/update/tool updates without querying messages', async () => {
      vi.mocked(mockMessageModel.create).mockResolvedValue({ id: 'msg-created' } as any);
      vi.mocked(mockMessageModel.update).mockResolvedValue({ success: true } as any);
      vi.mocked(mockMessageModel.updateToolMessage).mockResolvedValue({ success: true } as any);

      const result = await messageService.batchMutate([
        {
          message: { content: '', id: 'msg-created', role: 'assistant', topicId: 'topic-1' } as any,
          type: 'createMessage',
        },
        {
          id: 'msg-created',
          type: 'updateMessage',
          value: { content: 'hello' } as any,
        },
        {
          id: 'tool-1',
          type: 'updateToolMessage',
          value: { content: 'tool result' },
        },
      ]);

      expect(mockMessageModel.create).toHaveBeenCalledWith(
        { content: '', id: 'msg-created', role: 'assistant', topicId: 'topic-1' },
        'msg-created',
      );
      expect(mockMessageModel.update).toHaveBeenCalledWith('msg-created', { content: 'hello' });
      expect(mockMessageModel.updateToolMessage).toHaveBeenCalledWith('tool-1', {
        content: 'tool result',
      });
      expect(mockMessageModel.query).not.toHaveBeenCalled();
      expect(result).toEqual({
        results: [
          { id: 'msg-created', index: 0, success: true, type: 'createMessage' },
          { id: 'msg-created', index: 1, success: true, type: 'updateMessage' },
          { id: 'tool-1', index: 2, success: true, type: 'updateToolMessage' },
        ],
        success: true,
      });
    });

    it('returns per-operation failures without throwing away later operations', async () => {
      vi.mocked(mockMessageModel.create).mockRejectedValueOnce(new Error('create failed'));
      vi.mocked(mockMessageModel.update).mockResolvedValue({ success: true } as any);

      const result = await messageService.batchMutate([
        {
          message: { content: '', id: 'missing-assistant', role: 'assistant' } as any,
          type: 'createMessage',
        },
        {
          id: 'still-runs',
          type: 'updateMessage',
          value: { content: 'still runs' } as any,
        },
      ]);

      expect(mockMessageModel.update).toHaveBeenCalledWith('still-runs', {
        content: 'still runs',
      });
      expect(result).toEqual({
        results: [
          {
            error: 'create failed',
            id: 'missing-assistant',
            index: 0,
            success: false,
            type: 'createMessage',
          },
          { id: 'still-runs', index: 1, success: true, type: 'updateMessage' },
        ],
        success: false,
      });
    });

    it('surfaces the driver cause of a failed write, not the drizzle query wrapper', async () => {
      // Drizzle wraps the driver error: its own message is the whole failed
      // statement + params, while the actionable part (violated constraint,
      // SQLSTATE) only lives on `cause`. A subagent row written ahead of its
      // parent lands here, and the caller needs to see *why* to act on it.
      const driverError = Object.assign(
        new Error('insert or update on table "messages" violates foreign key constraint'),
        { code: '23503', constraint: 'messages_parent_id_messages_id_fk' },
      );
      const drizzleError = Object.assign(new Error('Failed query: insert into "messages" ...'), {
        cause: driverError,
      });
      vi.mocked(mockMessageModel.create).mockRejectedValueOnce(drizzleError);

      const result = await messageService.batchMutate([
        {
          message: { content: '', id: 'orphan', parentId: 'not-yet-written', role: 'user' } as any,
          type: 'createMessage',
        },
      ]);

      expect(result.success).toBe(false);
      expect(result.results[0].error).toBe(
        'messages_parent_id_messages_id_fk | 23503 | insert or update on table "messages" violates foreign key constraint',
      );
    });
  });

  describe('updateMetadata', () => {
    it('should update metadata and return { success: true } when no sessionId/topicId provided', async () => {
      const messageId = 'msg-1';
      const metadata = { someKey: 'someValue', count: 42 };

      const result = await messageService.updateMetadata(messageId, metadata);

      expect(mockMessageModel.updateMetadata).toHaveBeenCalledWith(messageId, metadata);
      expect(result).toEqual({ success: true });
      expect(mockMessageModel.query).not.toHaveBeenCalled();
    });

    it('should update metadata and return message list when sessionId provided', async () => {
      const messageId = 'msg-1';
      const metadata = { someKey: 'someValue', count: 42 };
      const mockMessages = [{ id: 'msg-1', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.updateMetadata(messageId, metadata, {
        sessionId: 'session-1',
      });

      expect(mockMessageModel.updateMetadata).toHaveBeenCalledWith(messageId, metadata);
      expect(mockMessageModel.query).toHaveBeenCalled();
      expect(result).toEqual({ messages: mockMessages, success: true });
    });

    it('should update metadata and return message list when topicId provided', async () => {
      const messageId = 'msg-1';
      const metadata = { key: 'value' };
      const mockMessages = [{ id: 'msg-1', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.updateMetadata(messageId, metadata, {
        topicId: 'topic-1',
      });

      expect(mockMessageModel.updateMetadata).toHaveBeenCalledWith(messageId, metadata);
      expect(mockMessageModel.query).toHaveBeenCalledWith(
        { groupId: undefined, sessionId: undefined, topicId: 'topic-1' },
        expect.objectContaining({
          groupAssistantMessages: false,
        }),
      );
      expect(result).toEqual({ messages: mockMessages, success: true });
    });
  });

  describe('createMessage', () => {
    it('should create message and return message list', async () => {
      const params = {
        agentId: 'agent-1',
        content: 'Hello',
        role: 'user' as const,
      };
      const createdMessage = { id: 'msg-1', ...params };
      const mockMessages = [createdMessage, { id: 'msg-2', content: 'Hi' }];

      vi.mocked(mockMessageModel.create).mockResolvedValue(createdMessage as any);
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.createMessage(params as any);

      expect(mockMessageModel.create).toHaveBeenCalledWith(params, undefined);
      expect(mockMessageModel.query).toHaveBeenCalledWith(
        {
          agentId: 'agent-1',
          current: 0,
          groupId: undefined,
          pageSize: 9999,
          threadId: undefined,
          topicId: undefined,
        },
        expect.objectContaining({
          postProcessUrl: expect.any(Function),
        }),
      );
      expect(result).toEqual({
        id: 'msg-1',
        messages: mockMessages,
      });
    });

    it('should create message with topicId and groupId', async () => {
      const params = {
        agentId: 'agent-1',
        content: 'Hello',
        groupId: 'group-1',
        role: 'user' as const,
        topicId: 'topic-1',
      };
      const createdMessage = { id: 'msg-1', ...params };
      const mockMessages = [createdMessage];

      vi.mocked(mockMessageModel.create).mockResolvedValue(createdMessage as any);
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.createMessage(params as any);

      expect(mockMessageModel.query).toHaveBeenCalledWith(
        {
          agentId: 'agent-1',
          current: 0,
          groupId: 'group-1',
          pageSize: 9999,
          threadId: undefined,
          topicId: 'topic-1',
        },
        expect.objectContaining({
          postProcessUrl: expect.any(Function),
        }),
      );
      expect(result.id).toBe('msg-1');
      expect(result.messages).toEqual(mockMessages);
    });

    it('should create message with threadId and query thread messages', async () => {
      const params = {
        agentId: 'agent-1',
        content: 'Hello in thread',
        groupId: 'group-1',
        role: 'user' as const,
        threadId: 'thread-1',
        topicId: 'topic-1',
      };
      const createdMessage = { id: 'msg-1', ...params };
      const mockMessages = [createdMessage];

      vi.mocked(mockMessageModel.create).mockResolvedValue(createdMessage as any);
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.createMessage(params as any);

      expect(mockMessageModel.create).toHaveBeenCalledWith(params, undefined);
      expect(mockMessageModel.query).toHaveBeenCalledWith(
        {
          agentId: 'agent-1',
          current: 0,
          groupId: 'group-1',
          pageSize: 9999,
          threadId: 'thread-1',
          topicId: 'topic-1',
        },
        expect.objectContaining({
          postProcessUrl: expect.any(Function),
        }),
      );
      expect(result.id).toBe('msg-1');
      expect(result.messages).toEqual(mockMessages);
    });
  });

  describe('groupId context support', () => {
    const groupId = 'group-123';
    const topicId = 'topic-456';

    it('removeMessage should query with groupId when provided', async () => {
      const messageId = 'msg-1';
      const mockMessages = [{ id: 'msg-2', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.removeMessage(messageId, { groupId, topicId });

      expect(mockMessageModel.deleteMessage).toHaveBeenCalledWith(messageId);
      expect(mockMessageModel.query).toHaveBeenCalledWith(
        { groupId, sessionId: undefined, topicId },
        expect.objectContaining({
          groupAssistantMessages: false,
        }),
      );
      expect(result).toEqual({ messages: mockMessages, success: true });
    });

    it('removeMessages should query with groupId when provided', async () => {
      const messageIds = ['msg-1', 'msg-2'];
      const mockMessages = [{ id: 'msg-3', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.removeMessages(messageIds, { groupId, topicId });

      expect(mockMessageModel.deleteMessages).toHaveBeenCalledWith(messageIds);
      expect(mockMessageModel.query).toHaveBeenCalledWith(
        { groupId, sessionId: undefined, topicId },
        expect.objectContaining({
          groupAssistantMessages: false,
        }),
      );
      expect(result).toEqual({ messages: mockMessages, success: true });
    });

    it('updateMessage should query with groupId when provided', async () => {
      const messageId = 'msg-1';
      const value = { content: 'updated content' };
      const mockMessages = [{ id: 'msg-1', content: 'updated content' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.updateMessage(messageId, value as any, {
        groupId,
        topicId,
      });

      expect(mockMessageModel.update).toHaveBeenCalledWith(messageId, value);
      expect(mockMessageModel.query).toHaveBeenCalledWith(
        { groupId, sessionId: undefined, topicId },
        expect.objectContaining({
          groupAssistantMessages: false,
        }),
      );
      expect(result).toEqual({ messages: mockMessages, success: true });
    });

    it('updateMetadata should query with groupId when provided', async () => {
      const messageId = 'msg-1';
      const metadata = { key: 'value' };
      const mockMessages = [{ id: 'msg-1', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.updateMetadata(messageId, metadata, {
        groupId,
        topicId,
      });

      expect(mockMessageModel.updateMetadata).toHaveBeenCalledWith(messageId, metadata);
      expect(mockMessageModel.query).toHaveBeenCalledWith(
        { groupId, sessionId: undefined, topicId },
        expect.objectContaining({
          groupAssistantMessages: false,
        }),
      );
      expect(result).toEqual({ messages: mockMessages, success: true });
    });

    it('updatePluginState should query with groupId when provided', async () => {
      const messageId = 'msg-1';
      const state = { key: 'value' };
      const mockMessages = [{ id: 'msg-1', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.updatePluginState(messageId, state, {
        groupId,
        topicId,
      });

      expect(mockMessageModel.updatePluginState).toHaveBeenCalledWith(messageId, state);
      expect(mockMessageModel.query).toHaveBeenCalledWith(
        { groupId, sessionId: undefined, topicId },
        expect.objectContaining({
          groupAssistantMessages: false,
        }),
      );
      expect(result).toEqual({ messages: mockMessages, success: true });
    });

    it('updatePluginError should query with groupId when provided', async () => {
      const messageId = 'msg-1';
      const error = { type: 'TestError', message: 'Test error message' };
      const mockMessages = [{ id: 'msg-1', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.updatePluginError(messageId, error, {
        groupId,
        topicId,
      });

      expect(mockMessageModel.updateMessagePlugin).toHaveBeenCalledWith(messageId, { error });
      expect(mockMessageModel.query).toHaveBeenCalledWith(
        { groupId, sessionId: undefined, topicId },
        expect.objectContaining({
          groupAssistantMessages: false,
        }),
      );
      expect(result).toEqual({ messages: mockMessages, success: true });
    });

    it('updateMessageRAG should query with groupId when provided', async () => {
      const messageId = 'msg-1';
      const ragValue = { fileChunks: [{ id: 'chunk-1', similarity: 0.95 }] };
      const mockMessages = [{ id: 'msg-1', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.updateMessageRAG(messageId, ragValue, {
        groupId,
        topicId,
      });

      expect(mockMessageModel.updateMessageRAG).toHaveBeenCalledWith(messageId, ragValue);
      expect(mockMessageModel.query).toHaveBeenCalledWith(
        { groupId, sessionId: undefined, topicId },
        expect.objectContaining({
          groupAssistantMessages: false,
        }),
      );
      expect(result).toEqual({ messages: mockMessages, success: true });
    });
  });
});
