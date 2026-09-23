import { confirmModal } from '@lobehub/ui/base-ui';
import { describe, expect, it, vi } from 'vitest';

import { confirmResourceSave, ResourceSaveCancelledError } from './confirmResourceSave';

vi.mock('@lobehub/ui/base-ui', () => ({ confirmModal: vi.fn() }));
vi.mock('i18next', () => ({ t: (key: string) => key }));

describe('resource save confirmation', () => {
  it('rejects dismissal without save and names the save action explicitly', async () => {
    const confirmation = confirmResourceSave('article');
    const assertion = expect(confirmation).rejects.toBeInstanceOf(ResourceSaveCancelledError);
    const options = vi.mocked(confirmModal).mock.lastCall![0];
    expect(options.okText).toBe('resourceSave.title');
    expect(options.cancelText).toBe('resourceSave.cancel');
    options.onOpenChangeComplete?.(false);
    await assertion;
  });

  it('resolves only the explicit save action, even when the modal subsequently closes', async () => {
    const confirmation = confirmResourceSave('article');
    const options = vi.mocked(confirmModal).mock.lastCall![0];
    await options.onOk?.();
    options.onOpenChangeComplete?.(false);
    await expect(confirmation).resolves.toBeUndefined();
  });
});
