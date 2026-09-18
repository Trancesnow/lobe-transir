import { type ChatImageItem } from '@lobechat/types';
import { PreviewGroup } from '@lobehub/ui';
import { memo } from 'react';

import GalleyGrid from '@/components/GalleyGrid';
import ImageItem from '@/components/ImageItem';
import SaveToResourceButton from '@/components/SaveToResourceButton';

import { downloadPreviewImage } from './downloadPreviewImage';

interface FileListProps {
  items: ChatImageItem[];
}

const ImageFileListViewer = memo<FileListProps>(({ items }) => {
  const ids = items.map((item) => item.id).filter(Boolean);

  return (
    <PreviewGroup preview={{ onDownload: downloadPreviewImage }}>
      <GalleyGrid
        items={items}
        renderItem={(props: ChatImageItem) => (
          <ImageItem {...props} extraActions={<SaveToResourceButton id={props.id} ids={ids} />} />
        )}
      />
    </PreviewGroup>
  );
});

export default ImageFileListViewer;
