import useSWR from 'swr';

import { fileService } from '@/services/file';

export const getEphemeralStatusKey = (ids: string[]) =>
  ids.length > 0 ? `ephemeral-status:${ids.join(',')}` : null;

/**
 * 批量查询 files.id 的临时（ephemeral）状态；同一组 id 在列表内共享一次请求。
 */
export const useEphemeralStatus = (ids: string[]) => {
  const uniqueIds = [...new Set(ids)].sort();

  const { data, mutate } = useSWR<Record<string, boolean>>(getEphemeralStatusKey(uniqueIds), () =>
    fileService.getEphemeralStatus(uniqueIds),
  );

  const markSaved = async (id: string) => {
    await mutate((prev) => ({ ...prev, [id]: false }), { revalidate: false });
  };

  return { markSaved, status: data ?? {} };
};
