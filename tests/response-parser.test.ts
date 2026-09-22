import { describe, expect, it } from 'vitest';
import {
  extractFirstJsonObject,
  parseResponseBody,
} from '../chrome-plugin/src/service/common';

const completion = (text: string) => JSON.stringify({
  id: 'chatcmpl-abc',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
});

describe('parseResponseBody', () => {
  it('标准整段 JSON 直接解析', () => {
    const body = completion('你好');
    const parsed = parseResponseBody(body);
    expect(parsed.mode).toBe('json');
    expect(parsed.payload).toMatchObject({ object: 'chat.completion' });
  });

  it('SSE 帧（data: 前缀）解析并合并增量', () => {
    const body = 'data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]';
    const parsed = parseResponseBody(body);
    expect(parsed.mode).toBe('sse');
    expect(parsed.payload).toEqual({ content: '你好' });
  });

  it('CR 行尾（\\r 分隔）的帧同样解析', () => {
    const body = 'data: {"choices":[{"delta":{"content":"a"}}]}\rdata: {"choices":[{"delta":{"content":"b"}}]}';
    const parsed = parseResponseBody(body);
    expect(parsed.mode).toBe('sse');
    expect(parsed.payload).toEqual({ content: 'ab' });
  });

  it('整段 JSON 后跟尾随垃圾时仍能提取译文', () => {
    const body = `${completion('有效译文')}  \ngarbage tail line`;
    const parsed = parseResponseBody(body);
    // 按行扫描会把 JSON 行识别为帧（sse 模式）；无论哪种模式，payload 必须完整可用
    expect(['json', 'sse']).toContain(parsed.mode);
    expect(parsed.payload).toMatchObject({ object: 'chat.completion' });
  });

  it('多个 JSON 对象无换行拼接时取第一个', () => {
    const body = `${completion('第一段')}${completion('第二段')}`;
    const parsed = parseResponseBody(body);
    expect(parsed.mode).toBe('json');
    const content = (parsed.payload as { choices: { message: { content: string } }[] }).choices[0].message.content;
    expect(content).toBe('第一段');
  });

  it('BOM 前缀不阻碍解析', () => {
    const body = `\uFEFF${completion('带 BOM')}`;
    const parsed = parseResponseBody(body);
    expect(parsed.mode).toBe('json');
  });

  it('正文被截断但首个对象完整时仍可解析', () => {
    const body = `${completion('完整前半')} {"id":"chatcmpl-`; // 第二对象被截断
    const parsed = parseResponseBody(body);
    expect(parsed.mode).toBe('json');
  });

  it('纯垃圾返回 none', () => {
    expect(parseResponseBody('not json at all').mode).toBe('none');
    expect(parseResponseBody('').mode).toBe('none');
  });
});

describe('extractFirstJsonObject', () => {
  it('跳过前导噪声定位首个对象', () => {
    expect(extractFirstJsonObject(`prefix ${completion('x')}`)).toBe(completion('x'));
  });

  it('字符串内的大括号与转义引号不干扰括号配平', () => {
    const obj = '{"a":"{not brace}","b":"\\"escaped\\""}';
    expect(extractFirstJsonObject(obj)).toBe(obj);
  });

  it('括号未闭合（截断）返回 null', () => {
    expect(extractFirstJsonObject('{"a":1')).toBeNull();
    expect(extractFirstJsonObject('no brace')).toBeNull();
  });
});
