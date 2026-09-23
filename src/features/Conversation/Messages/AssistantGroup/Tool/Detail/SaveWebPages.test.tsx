import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { documentService } from '@/services/document';

import SaveWebPages, { getWebPages } from './SaveWebPages';

vi.mock('@/services/document', () => ({ documentService: { saveDocumentToResource: vi.fn() } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ loading: _loading, size: _size, ...props }: any) => <button {...props} />,

}));

vi.mock('@lobehub/ui', () => ({ Flexbox: ({ children }: any) => <div>{children}</div> }));

const page = { content: '# Previously read text', title: 'Article', url: 'https://example.com' };

describe('explicit web resource save', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not save when the page is rendered; a save click submits the original content once', async () => {
    vi.mocked(documentService.saveDocumentToResource).mockResolvedValue({ id: 'saved' } as any);
    render(<SaveWebPages state={{ results: [{ data: page }] }} />);
    expect(documentService.saveDocumentToResource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByRole('button')).toBeDisabled());
    expect(documentService.saveDocumentToResource).toHaveBeenCalledWith(expect.objectContaining({
      content: page.content, metadata: { sourceUrl: page.url }, title: page.title,
    }));
    fireEvent.click(screen.getByRole('button'));
    expect(documentService.saveDocumentToResource).toHaveBeenCalledTimes(1);
  });

  it('reports failure and allows a deliberate retry', async () => {
    vi.mocked(documentService.saveDocumentToResource).mockRejectedValue(new Error('denied'));
    render(<SaveWebPages state={{ results: [{ data: page }] }} />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('resourceSave.failed'));
    expect(screen.getByRole('button')).not.toBeDisabled();
  });

  it('does not offer failed, empty or malformed crawler results for saving', () => {
    expect(getWebPages({ results: [null, { data: { ...page, errorMessage: 'failed' } },
      { data: { ...page, content: '' } }, { data: { ...page, url: 'javascript:alert(1)' } }] })).toEqual([]);
    expect(getWebPages(null)).toEqual([]);
  });
});
