import { WebBrowsingManifest } from '@lobechat/builtin-tool-web-browsing';
import { WebBrowsingExecutionRuntime } from '@lobechat/builtin-tool-web-browsing/executionRuntime';

import { SearchService } from '@/server/services/search';

import { type ServerRuntimeRegistration } from './types';

export const webBrowsingRuntime: ServerRuntimeRegistration = {
  factory: () => {
    return new WebBrowsingExecutionRuntime({
      searchService: new SearchService(),
    });
  },
  identifier: WebBrowsingManifest.identifier,
};
