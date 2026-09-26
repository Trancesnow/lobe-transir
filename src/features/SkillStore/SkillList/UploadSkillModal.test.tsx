/**
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { openUploadSkillModal } from './UploadSkillModal';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  createFile: vi.fn(),
  importAgentSkillFromZip: vi.fn(),
  releaseUpload: vi.fn(),
  toastSuccess: vi.fn(),
  uploadFileToS3: vi.fn(),
}));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Icon: () => null,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Alert: ({ title }: { title: string }) => <div role="alert">{title}</div>,
  createModal: ({ content }: { content: React.ReactNode }) => {
    render(content);
    return { close: vi.fn() };
  },
  toast: { success: mocks.toastSuccess },
  useModalContext: () => ({ close: mocks.close, setCanDismissByClickOutside: vi.fn() }),
}));

vi.mock('antd', () => ({
  Spin: () => null,
  Typography: {
    Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
    Title: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  },
  Upload: {
    Dragger: ({
      beforeUpload,
      children,
    }: {
      beforeUpload: (file: File) => void;
      children: React.ReactNode;
    }) => (
      <div>
        <input
          aria-label="skill package"
          onChange={(event) => {
            if (event.target.files?.[0]) beforeUpload(event.target.files[0]);
          }}
          type="file"
        />
        {children}
      </div>
    ),
  },
}));

vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ allowed: true }) }));
vi.mock('@/libs/trpc/client/lambda', () => ({
  lambdaClient: { file: { createFile: { mutate: mocks.createFile } } },
}));
vi.mock('@/services/upload', () => ({
  uploadService: { releaseUpload: mocks.releaseUpload, uploadFileToS3: mocks.uploadFileToS3 },
}));
vi.mock('@/store/tool', () => ({
  useToolStore: (
    selector: (state: { importAgentSkillFromZip: typeof mocks.importAgentSkillFromZip }) => unknown,
  ) => selector({ importAgentSkillFromZip: mocks.importAgentSkillFromZip }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { error?: string }) =>
      options?.error ? `${key}: ${options.error}` : key,
  }),
}));

const selectPackage = () => {
  openUploadSkillModal();
  fireEvent.change(screen.getByLabelText('skill package'), {
    target: { files: [new File(['skill contents'], 'sample.skill', { type: 'application/zip' })] },
  });
};

describe('UploadSkillModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.uploadFileToS3.mockResolvedValue({ data: { path: 'skills/upload.skill' } });
    mocks.createFile.mockResolvedValue({ id: 'temporary-package' });
    mocks.importAgentSkillFromZip.mockResolvedValue(undefined);
    mocks.releaseUpload.mockResolvedValue(undefined);
  });

  it('registers the upload as temporary, then imports by its file id', async () => {
    selectPackage();

    await waitFor(() =>
      expect(mocks.importAgentSkillFromZip).toHaveBeenCalledWith({
        zipFileId: 'temporary-package',
      }),
    );
    expect(mocks.createFile).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        metadata: {},
        name: 'sample.skill',
        url: 'skills/upload.skill',
      }),
    );
    expect(mocks.createFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.importAgentSkillFromZip.mock.invocationCallOrder[0],
    );
    expect(mocks.toastSuccess).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('releases the uploaded object if temporary file registration fails', async () => {
    mocks.createFile.mockRejectedValue(new Error('registration failed'));
    selectPackage();

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('registration failed'));
    expect(mocks.releaseUpload).toHaveBeenCalledWith('skills/upload.skill');
    expect(mocks.importAgentSkillFromZip).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it('reports an import error without claiming that the skill was installed', async () => {
    mocks.importAgentSkillFromZip.mockRejectedValue(new Error('invalid skill'));
    selectPackage();

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('invalid skill'));
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });
});
