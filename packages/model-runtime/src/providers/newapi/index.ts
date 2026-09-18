import type { ModelPriceCurrency, Pricing, PricingUnitName } from 'model-bank';
import { LOBE_DEFAULT_MODEL_LIST, ModelProvider } from 'model-bank';
import urlJoin from 'url-join';

import { createRouterRuntime } from '../../core/RouterRuntime';
import type { CreateRouterRuntimeOptions } from '../../core/RouterRuntime/createRuntime';
import { detectModelProvider, processMultiProviderModelList } from '../../utils/modelParse';
import { responsesAPIModels } from '../openai/modelId';
import { resolveProviderRouteModels } from '../utils/resolveProviderRouteModels';

export interface NewAPIModelCard {
  created: number;
  id: string;
  object: string;
  owned_by: string;
  supported_endpoint_types?: string[];
}

export interface NewAPIPricing {
  billing_expr?: string;
  billing_mode?: string;
  completion_ratio?: number;
  description?: string;
  enable_groups: string[];
  model_name: string;
  model_price?: number;
  model_ratio?: number;
  /** 0: Pay-per-token, 1: Pay-per-call */
  quota_type: number;
  supported_endpoint_types?: string[];
}

const isBrowser = () => typeof window !== 'undefined' && typeof document !== 'undefined';

const fetchPricing = async (
  pricingUrl: string,
  apiKey: string,
  providerId = ModelProvider.NewAPI,
): Promise<NewAPIPricing[] | null> => {
  try {
    let res: Response;
    if (isBrowser()) {
      res = await fetch(`/webapi/models/${encodeURIComponent(providerId)}/pricing`);
    } else {
      const fetchWithAuth = async (useAuth: boolean) => {
        const headers: Record<string, string> = {
          Accept: 'application/json; charset=utf-8',
        };
        if (useAuth && apiKey) {
          headers.Authorization = `Bearer ${apiKey}`;
        }
        return fetch(pricingUrl, { headers });
      };

      let usedAuth = true;
      try {
        res = await fetchWithAuth(true);
      } catch {
        usedAuth = false;
        res = await fetchWithAuth(false);
      }

      if (!res.ok && usedAuth) {
        res = await fetchWithAuth(false);
      }
    }

    if (!res.ok) return null;

    const body = await res.json();
    return body?.success && body?.data ? (body.data as NewAPIPricing[]) : null;
  } catch {
    return null;
  }
};

export interface NewAPISiteStatus {
  custom_currency_exchange_rate?: number;
  custom_currency_symbol?: string;
  /** 站点额度展示币种：'USD' | 'CNY' | 'CUSTOM' | 'TOKENS' */
  quota_display_type?: string;
  usd_exchange_rate?: number;
}

const fetchSiteStatus = async (
  baseURL: string,
  providerId = ModelProvider.NewAPI,
): Promise<NewAPISiteStatus | null> => {
  try {
    const res = isBrowser()
      ? await fetch(`/webapi/models/${encodeURIComponent(providerId)}/status`)
      : await fetch(`${baseURL}/api/status`, {
          headers: { Accept: 'application/json; charset=utf-8' },
        });

    if (!res.ok) return null;

    const body = await res.json();
    return body?.success && body?.data ? (body.data as NewAPISiteStatus) : null;
  } catch {
    return null;
  }
};

/**
 * new-api 内部以美元计价额度存储价格；站点币种为 CNY 时，
 * new-api 面板按 usd_exchange_rate 折算展示。此处施加同样折算，
 * 使 LobeChat 显示的定价与 new-api 面板完全一致。
 */
const resolveCurrency = (
  status: NewAPISiteStatus | null,
): { currency?: ModelPriceCurrency; rateMultiplier: number } => {
  if (
    status?.quota_display_type === 'CNY' &&
    typeof status.usd_exchange_rate === 'number' &&
    status.usd_exchange_rate > 0
  ) {
    return { currency: 'CNY', rateMultiplier: status.usd_exchange_rate };
  }

  return { rateMultiplier: 1 };
};

/**
 * 将 new-api 的分段计费表达式解析为 LobeChat 的分层定价单位。
 *
 * 表达式形态（2~3 段，cr/cc 项可选）：
 * `len <= 32000 ? tier("short", p * 0.027 + c * 0.11 + cr * 0.003) : ... : tier("long", ...)`
 * - p  -> textInput, c -> textOutput, cr -> textInput_cacheRead, cc -> textInput_cacheWrite
 * - 系数与 model_ratio 同单位（$0.002/1K tokens），故 rate = 系数 * 2，换算为 $/1M tokens
 * - rateMultiplier 施加站点币种折算（如站点用 CNY 时的 usd_exchange_rate）
 *
 * 表达式不匹配预期形态时返回 undefined，调用方回退到比率计价。
 */
export const parseBillingExpr = (
  expr: string,
  rateMultiplier = 1,
  currency: ModelPriceCurrency = 'USD',
): Pricing | undefined => {
  const thresholds = [...expr.matchAll(/len\s*<=\s*(\d+)/g)].map((m) => Number(m[1]));
  const tierBodies = [...expr.matchAll(/tier\(\s*"[^"]*"\s*,([^)]*)\)/g)].map((m) => m[1]);

  if (tierBodies.length < 2 || tierBodies.length !== thresholds.length + 1) return undefined;

  const variableToUnit: Record<string, PricingUnitName> = {
    c: 'textOutput',
    cc: 'textInput_cacheWrite',
    cr: 'textInput_cacheRead',
    p: 'textInput',
  };

  const tiersByUnit = new Map<PricingUnitName, { rate: number; upTo: number | 'infinity' }[]>();

  tierBodies.forEach((body, index) => {
    const upTo: number | 'infinity' = index < thresholds.length ? thresholds[index] : 'infinity';

    for (const match of body.matchAll(/([a-z]+)\s*\*\s*([\d.eE+-]+)/g)) {
      const unitName = variableToUnit[match[1]];
      if (!unitName) continue;

      const tiers = tiersByUnit.get(unitName) ?? [];
      tiers.push({ rate: Number(match[2]) * 2 * rateMultiplier, upTo });
      tiersByUnit.set(unitName, tiers);
    }
  });

  if (!tiersByUnit.has('textInput') && !tiersByUnit.has('textOutput')) return undefined;

  return {
    currency,
    units: [...tiersByUnit.entries()].map(([name, tiers]) => ({
      name,
      strategy: 'tiered' as const,
      tiers,
      unit: 'millionTokens' as const,
    })),
  };
};

export const params = {
  debug: {
    chatCompletion: () => process.env.DEBUG_NEWAPI_CHAT_COMPLETION === '1',
  },
  defaultHeaders: {
    'X-Client': 'LobeHub',
  },
  id: ModelProvider.NewAPI,
  models: async ({ client: openAIClient, options }) => {
    const providerId =
      typeof options?.providerId === 'string' ? options.providerId : ModelProvider.NewAPI;

    // Get base URL (remove trailing API version paths like /v1, /v1beta, etc.)
    const baseURL = openAIClient.baseURL.replace(/\/v\d+[a-z]*\/?$/, '');

    const modelsPage = (await openAIClient.models.list()) as any;
    const modelList: NewAPIModelCard[] = modelsPage.data || [];

    // Create a set of existing model IDs for quick lookup
    const existingModelIds = new Set(modelList.map((m) => m.id));

    // Try to get pricing information to enrich model details
    const pricingMap: Map<string, NewAPIPricing> = new Map();

    // 并行拉取定价与站点状态（币种设置）
    const [pricingList, siteStatus] = await Promise.all([
      fetchPricing(`${baseURL}/api/pricing`, openAIClient.apiKey || '', providerId),
      fetchSiteStatus(baseURL, providerId),
    ]);
    const { currency, rateMultiplier } = resolveCurrency(siteStatus);

    if (Array.isArray(pricingList)) {
      pricingList.forEach((pricing) => {
        pricingMap.set(pricing.model_name, pricing);
      });
    }

    const calculatePricing = (pricing: NewAPIPricing) => {
      // 分段表达式计费（billing_mode = "tiered_expr"）优先；
      // 此时随附的 model_ratio 只是兜底值，并非真实价格。
      if (pricing.billing_mode === 'tiered_expr' && pricing.billing_expr) {
        const tiered = parseBillingExpr(pricing.billing_expr, rateMultiplier, currency ?? 'USD');
        if (tiered) return tiered;
      }

      let inputPrice: number | undefined;
      let outputPrice: number | undefined;

      if (pricing.quota_type === 0) {
        // Pay-per-token
        if (pricing.model_price && pricing.model_price > 0) {
          // model_price is a direct price value; need to confirm its unit.
          // Assumption: model_price is the price per 1,000 tokens (i.e., $/1K tokens).
          // To convert to price per 1,000,000 tokens ($/1M tokens), multiply by 1,000,000 / 1,000 = 1,000.
          // Since the base price is $0.002/1K tokens, multiplying by 2 gives $2/1M tokens.
          // Therefore, inputPrice = model_price * 2 converts the price to $/1M tokens for LobeChat.
          inputPrice = pricing.model_price * 2;
        } else if (pricing.model_ratio) {
          // model_ratio × $0.002/1K = model_ratio × $2/1M
          inputPrice = pricing.model_ratio * 2; // Convert to $/1M tokens
        }

        if (inputPrice !== undefined) {
          // Calculate output price
          outputPrice = inputPrice * (pricing.completion_ratio || 1);

          return {
            ...(currency && { currency }),
            units: [
              {
                name: 'textInput',
                rate: inputPrice * rateMultiplier,
                strategy: 'fixed',
                unit: 'millionTokens',
              },
              {
                name: 'textOutput',
                rate: outputPrice * rateMultiplier,
                strategy: 'fixed',
                unit: 'millionTokens',
              },
            ],
          };
        }
      }
      // quota_type === 1 pay-per-call is not currently supported
      return undefined;
    };

    // Process the model list: determine the provider for each model based on priority rules
    const enrichedModelList = modelList.map((model) => {
      const enhancedModel: any = { ...model };

      // add pricing info
      const pricing = pricingMap.get(model.id);
      if (pricing) {
        // NewAPI pricing calculation logic:
        // - quota_type: 0 means pay-per-token, 1 means pay-per-call
        // - model_ratio: multiplier relative to base price (base price = $0.002/1K tokens)
        // - model_price: directly specified price (takes priority)
        // - completion_ratio: output price multiplier relative to input price
        //
        // 费率按站点币种折算为每百万 tokens 单价
        //（默认 USD；站点用 CNY 时经 usd_exchange_rate 折算）

        const pricingData = calculatePricing(pricing);
        if (pricingData) {
          enhancedModel.pricing = pricingData;
        }
      }

      return enhancedModel;
    });

    // Add models from pricing list that are not in the models list
    const additionalModels: any[] = [];
    pricingMap.forEach((pricing, modelName) => {
      if (!existingModelIds.has(modelName)) {
        const pricingData = calculatePricing(pricing);
        additionalModels.push({
          ...(pricing.description && { description: pricing.description }),
          id: modelName,
          ...(pricingData && { pricing: pricingData }),
        });
      }
    });

    return processMultiProviderModelList([...enrichedModelList, ...additionalModels], 'newapi');
  },
  routers: (options, runtimeContext?: { model?: string }) => {
    const userBaseURL = options.baseURL?.replace(/\/v\d+[a-z]*\/?$/, '') || '';

    return [
      {
        apiType: 'anthropic',
        models: LOBE_DEFAULT_MODEL_LIST.map((m) => m.id).filter(
          (id) => detectModelProvider(id) === 'anthropic',
        ),
        options: {
          ...options,
          baseURL: userBaseURL,
        },
      },
      {
        apiType: 'google',
        models: LOBE_DEFAULT_MODEL_LIST.map((m) => m.id).filter(
          (id) => detectModelProvider(id) === 'google',
        ),
        options: {
          ...options,
          baseURL: userBaseURL,
        },
      },
      {
        apiType: 'xai',
        models: LOBE_DEFAULT_MODEL_LIST.map((m) => m.id).filter(
          (id) => detectModelProvider(id) === 'xai',
        ),
        options: {
          ...options,
          baseURL: urlJoin(userBaseURL, '/v1'),
        },
      },
      {
        apiType: 'deepseek',
        models: resolveProviderRouteModels(
          'deepseek',
          LOBE_DEFAULT_MODEL_LIST,
          runtimeContext?.model,
        ),
        options: {
          ...options,
          baseURL: urlJoin(userBaseURL, '/v1'),
          sdkType: 'openai',
        },
      },
      {
        apiType: 'openai',
        options: {
          ...options,
          baseURL: urlJoin(userBaseURL, '/v1'),
          chatCompletion: {
            useResponseModels: [...Array.from(responsesAPIModels), /gpt-\d(?!\d)/, /^o\d/],
          },
        },
      },
    ];
  },
} satisfies CreateRouterRuntimeOptions;

export const LobeNewAPIAI = createRouterRuntime(params);
