import { type Pricing } from 'model-bank';

import {
  getCachedTextInputUnitRate,
  getTextInputUnitRate,
  getTextOutputUnitRate,
  getWriteCacheInputUnitRate,
} from '@/utils/index';

/**
 * Unit rates in the pricing's native currency (per 1M tokens), without any
 * USD normalization — CNY sites yield CNY rates matching the new-api panel.
 */
export const getPrice = (pricing: Pricing) => {
  return {
    cachedInput: getCachedTextInputUnitRate(pricing) ?? 0,
    input: getTextInputUnitRate(pricing) ?? 0,
    output: getTextOutputUnitRate(pricing) ?? 0,
    writeCacheInput: getWriteCacheInputUnitRate(pricing) ?? 0,
  };
};
