import { CUSTOM_DOCUMENT_FILE_TYPE } from '@lobechat/const';
import { Flexbox } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { documentService } from '@/services/document';

interface WebPage {
  content: string;
  title: string;
  url: string;
}

export const getWebPages = (state: unknown): WebPage[] => {
  if (!state || typeof state !== 'object' || !('results' in state)) return [];
  if (!Array.isArray(state.results)) return [];
  return state.results.flatMap((result: unknown) => {
    if (!result || typeof result !== 'object' || !('data' in result)) return [];
    const page = result.data;
    if (!page || typeof page !== 'object' || 'errorMessage' in page) return [];
    if (!('content' in page) || typeof page.content !== 'string' || !page.content.trim()) return [];
    if (!('url' in page) || typeof page.url !== 'string') return [];
    if (!/^https?:\/\//i.test(page.url)) return [];
    return [{
      content: page.content,
      title: 'title' in page && typeof page.title === 'string' && page.title ? page.title : page.url,
      url: page.url,
    }];
  });
};

const SaveWebPage = ({ page }: { page: WebPage }) => {
  const { t } = useTranslation('file');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <Flexbox gap={4}>
      <Button
        disabled={saved || saving}
        loading={saving}
        size="small"
        onClick={async (event) => {
          event.stopPropagation();
          if (saving || saved) return;
          setSaving(true);
          setFailed(false);
          try {
            await documentService.saveDocumentToResource({
              content: page.content,
              fileType: CUSTOM_DOCUMENT_FILE_TYPE,
              metadata: { sourceUrl: page.url },
              title: page.title,
            });
            setSaved(true);
          } catch {
            setFailed(true);
          } finally {
            setSaving(false);
          }
        }}
      >
        {t(saved ? 'resourceSave.saved' : 'resourceSave.title')} · {page.title}
      </Button>
      {failed && <span role="alert">{t('resourceSave.failed')}</span>}
    </Flexbox>
  );
};

export default function SaveWebPages({ state }: { state: unknown }) {
  return (
    <Flexbox gap={8}>
      {getWebPages(state).map((page, index) => (
        <SaveWebPage key={`${page.url}:${index}`} page={page} />
      ))}
    </Flexbox>
  );
}
