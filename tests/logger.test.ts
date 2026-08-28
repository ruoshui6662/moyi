import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../chrome-plugin/src/utils/logger';

describe('diagnostic logger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('redacts secrets and omits translation content', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    logger.info('test.event', {
      apiKey: 'secret-key',
      text: 'private source text',
      inputCharacters: 10,
    });

    const output = JSON.stringify(info.mock.calls[0]);
    expect(output).toContain('[REDACTED]');
    expect(output).toContain('[OMITTED]');
    expect(output).not.toContain('secret-key');
    expect(output).not.toContain('private source text');
    expect(output).toContain('inputCharacters');
  });

  it('strips query strings and userinfo from logged URLs', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    logger.info('test.event', {
      url: 'https://user:pass@example.com/api/v1?key=sk-secret#frag',
      endpoint: 'https://api.deepseek.com',
    });

    const output = JSON.stringify(info.mock.calls[0]);
    expect(output).not.toContain('sk-secret');
    expect(output).not.toContain('user:pass');
    expect(output).not.toContain('#frag');
    expect(output).toContain('https://example.com/api/v1');
  });
});
