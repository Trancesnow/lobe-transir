import { Flexbox } from '@lobehub/ui';
import { memo } from 'react';

import { type ChatFileItem } from '@/types/index';

import FileItem from './Item';

interface FileListViewerProps {
  items: ChatFileItem[];
}

const FileListViewer = memo<FileListViewerProps>(({ items }) => {
  const ids = items.map((item) => item.id).filter(Boolean);

  return (
    <Flexbox gap={8}>
      {items.map((item) => (
        <FileItem ids={ids} key={item.id} {...item} />
      ))}
    </Flexbox>
  );
});
export default FileListViewer;
