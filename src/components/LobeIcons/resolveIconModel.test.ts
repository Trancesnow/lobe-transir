import { describe, expect, it } from 'vitest';

import { resolveIconModel } from './resolveIconModel';

describe('resolveIconModel', () => {
  it('should alias Kimi Code k3 model ids to the kimi keyword', () => {
    expect(resolveIconModel('k3')).toBe('kimi');
    expect(resolveIconModel('k3-256k')).toBe('kimi');
  });

  it('should match case-insensitively', () => {
    expect(resolveIconModel('K3')).toBe('kimi');
    expect(resolveIconModel('K3-256K')).toBe('kimi');
  });

  it('should keep already-matchable kimi ids unchanged', () => {
    expect(resolveIconModel('kimi-for-coding')).toBe('kimi-for-coding');
    expect(resolveIconModel('kimi-for-coding-highspeed')).toBe('kimi-for-coding-highspeed');
  });

  it('should not alias ids that merely contain k3', () => {
    expect(resolveIconModel('qwen3-k3')).toBe('qwen3-k3');
    expect(resolveIconModel('k30')).toBe('k30');
  });

  it('should pass through empty input', () => {
    expect(resolveIconModel(undefined)).toBeUndefined();
    expect(resolveIconModel('')).toBe('');
  });
});
