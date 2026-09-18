'use client';

import { Tooltip } from '@lobehub/ui';
import { ActionIcon } from '@lobehub/ui/base-ui';
import { BookmarkPlus } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { useEphemeralStatus } from '@/hooks/useEphemeralStatus';
import { documentService } from '@/services/document';
import { fileService } from '@/services/file';

interface SaveToResourceButtonProps {
  id: string;
  /** 同一消息内的全部产物 id，共享一次状态查询 */
  ids?: string[];
  type?: 'file' | 'document';
}

const SaveToResourceButton = memo<SaveToResourceButtonProps>(({ id, ids, type = 'file' }) => {
  const { t } = useTranslation('chat');
  const { markSaved, status } = useEphemeralStatus(ids ?? [id]);

  if (!status[id]) return null;

  return (
    <Tooltip title={t('saveToResource')}>
      <ActionIcon
        icon={BookmarkPlus}
        size={'small'}
        title={t('saveToResource')}
        onClick={async (e) => {
          e.stopPropagation();
          if (type === 'document') {
            await documentService.promoteDocument(id);
          } else {
            await fileService.promoteFile(id);
          }
          await markSaved(id);
        }}
      />
    </Tooltip>
  );
});

export default SaveToResourceButton;
