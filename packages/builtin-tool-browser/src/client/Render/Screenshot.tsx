import type { BuiltinRenderProps } from '@lobechat/types';
import { Block, Flexbox, Image } from '@lobehub/ui';
import { memo } from 'react';

import SaveToResourceButton from '@/components/SaveToResourceButton';

import type { BrowserScreenshotState } from '../../types';
import { resolveScreenshotSrc } from './screenshotSrc';

/** Screenshot: render the capture inline for the user. */
const Screenshot = memo<BuiltinRenderProps<unknown, BrowserScreenshotState, string>>(
  ({ pluginState }) => {
    const src = resolveScreenshotSrc(pluginState);
    if (!src) return null;

    const fileId = pluginState?.images?.[0]?.fileId;

    return (
      <Block style={{ overflow: 'hidden', padding: 4 }} variant={'outlined'}>
        <Image alt={'Browser screenshot'} src={src} style={{ borderRadius: 4, width: '100%' }} />
        {fileId && (
          <Flexbox horizontal justify={'flex-end'} padding={4}>
            <SaveToResourceButton id={fileId} />
          </Flexbox>
        )}
      </Block>
    );
  },
);

Screenshot.displayName = 'BrowserScreenshot';

export default Screenshot;
