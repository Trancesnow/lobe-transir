import { confirmModal } from '@lobehub/ui/base-ui';
import { t } from 'i18next';

export class ResourceSaveCancelledError extends Error {
  constructor() {
    super('Resource save cancelled');
    this.name = 'ResourceSaveCancelledError';
  }
}

export const confirmResourceSave = (description: string): Promise<void> =>
  new Promise((resolve, reject) => {
    let confirmed = false;
    confirmModal({
      title: t('resourceSave.title', { ns: 'file' }),
      content: t('resourceSave.description', { description, ns: 'file' }),
      okText: t('resourceSave.title', { ns: 'file' }),
      cancelText: t('resourceSave.cancel', { ns: 'file' }),
      onOk: () => {
        confirmed = true;
        resolve();
      },
      onOpenChangeComplete: (open) => {
        if (!open && !confirmed) reject(new ResourceSaveCancelledError());
      },
    });
  });
