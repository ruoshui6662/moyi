import { describe, expect, it } from 'vitest';
import {
  PROMPT_STYLES,
  buildStyleGuidance,
  sanitizePromptStyle,
} from '../chrome-plugin/src/utils/prompts';
import { SYSTEM_PROMPT, buildBatchMessages, buildBatchSystemPrompt, buildMessages } from '../chrome-plugin/src/service/templates';

describe('prompt styles registry', () => {
  it('exposes the three built-in styles', () => {
    expect(PROMPT_STYLES.map((style) => style.id)).toEqual(['general', 'academic', 'liberal']);
    expect(PROMPT_STYLES.map((style) => style.label)).toEqual(['通用', '学术', '意译']);
  });

  it('sanitizes unknown values back to general', () => {
    expect(sanitizePromptStyle('academic')).toBe('academic');
    expect(sanitizePromptStyle('liberal')).toBe('liberal');
    expect(sanitizePromptStyle('unknown')).toBe('general');
    expect(sanitizePromptStyle(undefined)).toBe('general');
    expect(sanitizePromptStyle(42)).toBe('general');
  });
});

describe('buildStyleGuidance', () => {
  it('returns distinct guidance per preset', () => {
    const guidance = PROMPT_STYLES.map((style) => buildStyleGuidance(style.id, false, undefined));
    expect(new Set(guidance).size).toBe(3);
    expect(guidance[0]).toContain('natural, fluent');
    expect(guidance[1]).toContain('precise terminology');
    expect(guidance[2]).toContain('word-for-word fidelity');
  });

  it('custom prompt overrides preset only when enabled and non-empty', () => {
    const custom = '保持口语感';
    expect(buildStyleGuidance('general', true, `  ${custom}  `)).toContain(custom);
    expect(buildStyleGuidance('general', true, custom)).not.toContain('natural, fluent');
    // 开启但内容为空 → 回落预设
    expect(buildStyleGuidance('general', true, '   ')).toContain('natural, fluent');
    // 未开启但有内容 → 使用预设
    expect(buildStyleGuidance('academic', false, custom)).toContain('precise terminology');
  });
});

describe('template integration keeps format contract immutable', () => {
  it('batch system prompt without options stays free of style guidance', () => {
    const prompt = buildBatchSystemPrompt('简体中文');
    expect(prompt).toContain('<paragraph_1>');
    expect(prompt).toContain('Output format:');
    expect(prompt).not.toContain('Aim for natural');
  });

  it('batch system prompt appends guidance before the output contract', () => {
    const prompt = buildBatchSystemPrompt('简体中文', { promptStyle: 'academic' });
    const guidanceIndex = prompt.indexOf('precise terminology');
    const contractIndex = prompt.indexOf('In the output, wrap each translated paragraph');
    expect(guidanceIndex).toBeGreaterThan(-1);
    expect(contractIndex).toBeGreaterThan(guidanceIndex);
  });

  it('custom user prompt is embedded verbatim while tags rule survives', () => {
    const prompt = buildBatchSystemPrompt('English', {
      useCustomPrompt: true,
      customPrompt: 'Keep names in English; short sentences.',
    });
    expect(prompt).toContain('Keep names in English; short sentences.');
    expect(prompt).toContain('Output only the translations with their tags');
  });

  it('batch messages carry guidance without touching the user block shape', () => {
    const messages = buildBatchMessages(['a', 'b'], '简体中文', '', { promptStyle: 'liberal' });
    expect(messages[0].role).toBe('system');
    expect(String(messages[1].content)).toContain('<paragraph_1>a</paragraph_1>');
    expect(String(messages[1].content)).toContain('<paragraph_2>b</paragraph_2>');
  });

  it('single-text messages append guidance to the base system prompt', () => {
    const plain = buildMessages('hi', '简体中文');
    expect(plain[0].content).toBe(SYSTEM_PROMPT);
    const styled = buildMessages('hi', '简体中文', { promptStyle: 'general' });
    expect(styled[0].content).toContain(SYSTEM_PROMPT);
    expect(styled[0].content).toContain('natural, fluent');
  });
});
