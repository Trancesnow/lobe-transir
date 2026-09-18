import { ssrfSafeFetch } from '@lobechat/ssrf-safe-fetch';
import { ChatErrorType } from '@lobechat/types';
import debug from 'debug';
import { NextResponse } from 'next/server';

import { checkAuth } from '@/app/(backend)/middleware/auth';
import { AiProviderModel } from '@/database/models/aiProvider';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import { createErrorResponse } from '@/utils/errorResponse';

const log = debug('lobe-server:models:status');

interface NewApiStatusKeyVaults {
  baseURL?: string;
}

export const GET = checkAuth(async (req, { params, userId, serverDB }) => {
  const provider = (await params).provider;

  if (!provider) {
    return createErrorResponse(ChatErrorType.BadRequest, {
      message: 'Provider is required.',
    });
  }

  try {
    // 1. 从数据库读取该用户的供应商配置
    const aiProviderModel = new AiProviderModel(serverDB, userId);
    const providerConfig = await aiProviderModel.getAiProviderById(
      provider,
      KeyVaultsGateKeeper.getUserKeyVaults,
    );

    if (!providerConfig) {
      return createErrorResponse(ChatErrorType.ContentNotFound, {
        message: 'Provider configuration not found.',
      });
    }

    const keyVaults = (providerConfig.keyVaults || {}) as NewApiStatusKeyVaults;
    const baseURL = keyVaults.baseURL;

    if (!baseURL) {
      return createErrorResponse(ChatErrorType.BadRequest, {
        message: 'Provider baseURL not configured.',
      });
    }

    // new-api 的 /api/status 挂在站点根路径，需剥掉 baseURL 尾部的 /v1、/v1beta 等版本段
    const cleanBaseURL = baseURL.replace(/\/v\d+[a-z]*\/?$/, '');
    const statusUrl = `${cleanBaseURL}/api/status`;

    // 该状态端点公开可访问，无需携带上游凭据
    const res = await ssrfSafeFetch(statusUrl, {
      headers: { Accept: 'application/json; charset=utf-8' },
    });

    if (!res.ok) {
      return createErrorResponse(ChatErrorType.BadGateway, {
        message: `Failed to fetch status from provider: ${res.statusText}`,
      });
    }

    const body = await res.json();
    return NextResponse.json(body);
  } catch (e) {
    log(`Route: [${provider}] status error: %O`, e);
    const error = e instanceof Error ? { message: e.message, name: e.name } : e;
    return createErrorResponse(ChatErrorType.InternalServerError, { error });
  }
});
