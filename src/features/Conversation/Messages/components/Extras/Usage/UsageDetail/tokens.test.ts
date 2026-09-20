import { type ModelUsage } from '@lobechat/types';
import { type LobeDefaultAiModelListItem } from 'model-bank';
import { describe, expect, it } from 'vitest';

import { getPrice } from './pricing';
import { getDetailsToken } from './tokens';

const cnyModelCard = {
  pricing: {
    currency: 'CNY',
    units: [
      { name: 'textInput', rate: 0.68, strategy: 'fixed', unit: 'millionTokens' },
      { name: 'textOutput', rate: 3.38, strategy: 'fixed', unit: 'millionTokens' },
    ],
  },
} as unknown as LobeDefaultAiModelListItem;

const usage = {
  inputTextTokens: 2400,
  outputReasoningTokens: 457,
  outputTextTokens: 282,
  totalInputTokens: 2400,
  totalOutputTokens: 739,
  totalTokens: 3139,
} as ModelUsage;

describe('getPrice', () => {
  it('returns unit rates in the pricing native currency without USD normalization', () => {
    const price = getPrice(cnyModelCard.pricing!);

    // CNY rates must stay as-is (not divided by USD_TO_CNY)
    expect(price.input).toBe(0.68);
    expect(price.output).toBe(3.38);
    expect(price.cachedInput).toBe(0);
    expect(price.writeCacheInput).toBe(0);
  });
});

describe('getDetailsToken', () => {
  it('calculates cost as tokens / 1M * rate without truncation', () => {
    const details = getDetailsToken(usage, cnyModelCard);

    expect(details.inputCacheMiss?.cost).toBeCloseTo((2400 / 1_000_000) * 0.68, 10);
    expect(details.outputReasoning?.cost).toBeCloseTo((457 / 1_000_000) * 3.38, 10);
    expect(details.outputText?.cost).toBeCloseTo((282 / 1_000_000) * 3.38, 10);

    // regression: small amounts must survive (parseInt would truncate them to 0)
    expect(details.inputCacheMiss?.cost).not.toBe(0);
    expect(details.totalTokens?.cost).toBeCloseTo(
      (2400 / 1_000_000) * 0.68 + (739 / 1_000_000) * 3.38,
      10,
    );
  });

  it('keeps token counts untouched', () => {
    const details = getDetailsToken(usage, cnyModelCard);

    expect(details.inputCacheMiss?.token).toBe(2400);
    expect(details.outputReasoning?.token).toBe(457);
    expect(details.totalTokens?.token).toBe(3139);
  });

  it("returns '-' for cost when the unit rate is missing", () => {
    const noOutputRate = {
      pricing: {
        currency: 'CNY',
        units: [{ name: 'textInput', rate: 0.68, strategy: 'fixed', unit: 'millionTokens' }],
      },
    } as unknown as LobeDefaultAiModelListItem;

    const details = getDetailsToken(usage, noOutputRate);

    expect(details.totalOutput?.cost).toBe('-');
    expect(details.inputCacheMiss?.cost).toBeCloseTo((2400 / 1_000_000) * 0.68, 10);

    // regression: totalCost must stay a pure number — adding the '-' sentinel into
    // the sum produced "0.0016-" style strings that crashed formatPrice on render
    expect(typeof details.totalTokens?.cost).toBe('number');
    expect(details.totalTokens?.cost).toBeCloseTo((2400 / 1_000_000) * 0.68, 10);
  });
});
