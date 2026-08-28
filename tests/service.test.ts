import { describe, expect, it, vi } from 'vitest';
import { TranslationServiceError, normalizeBaseUrl, streamTranslateBatch, testOpenAICompatibleConnection, translateBatchWithOpenAICompatible, translateWithOpenAICompatible } from '../chrome-plugin/src/service/common';

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com/')).toBe('https://api.deepseek.com');
    expect(normalizeBaseUrl('https://api.deepseek.com///')).toBe('https://api.deepseek.com');
  });

  it('strips a mistyped /chat/completions suffix so /models derivation stays consistent', () => {
    expect(normalizeBaseUrl('https://api.x.com/v1/chat/completions')).toBe('https://api.x.com/v1');
    expect(normalizeBaseUrl('https://api.x.com/v1/chat/completions/')).toBe('https://api.x.com/v1');
  });

  it('leaves a healthy base untouched', () => {
    expect(normalizeBaseUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1');
  });
});

describe('endpoint security validation', () => {
  it.each([
    '',                                     // 空
    'api.openai.com/v1',                    // 缺协议
    'http://api.example.com/v1',            // 公网域名：Key 会明文外传
    'http://8.8.8.8/v1',                    // 公网 IP
    'http://169.254.169.254/latest',        // 云元数据/链路本地保留地址
    'http://100.64.0.1/v1',                 // CGNAT 共享地址段（跨运营商网络）
    'ftp://api.example.com/v1',             // 非 http(s) 协议
    'javascript:alert(1)',                  // 危险伪协议
    'https://user:pass@api.example.com/v1', // URL 内嵌 userinfo 凭证
  ])('rejects unsafe endpoint %s', (endpoint) => {
    expect(() => normalizeBaseUrl(endpoint)).toThrow(TranslationServiceError);
  });

  it('allows https endpoints', () => {
    expect(normalizeBaseUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1');
    expect(normalizeBaseUrl('https://api.deepseek.com///')).toBe('https://api.deepseek.com');
  });

  it('allows http for loopback and private LAN endpoints', () => {
    expect(normalizeBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    expect(normalizeBaseUrl('http://127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234/v1');
    expect(normalizeBaseUrl('http://192.168.1.10:8080/v1')).toBe('http://192.168.1.10:8080/v1');
    expect(normalizeBaseUrl('http://10.0.0.5/v1')).toBe('http://10.0.0.5/v1');
    expect(normalizeBaseUrl('http://172.20.1.1/v1')).toBe('http://172.20.1.1/v1');
    // IPv4-mapped IPv6 环回
    expect(normalizeBaseUrl('http://[::ffff:127.0.0.1]:8080/v1')).toBe('http://[::ffff:127.0.0.1]:8080/v1');
    // mDNS 链路本地名称（NAS 常见 <name>.local），原样保留大小写
    expect(normalizeBaseUrl('http://nas.local:8080/v1')).toBe('http://nas.local:8080/v1');
    expect(normalizeBaseUrl('http://MY-NAS.local/v1')).toBe('http://MY-NAS.local/v1');
  });

  it('still strips a mistyped /chat/completions suffix from a valid base', () => {
    expect(normalizeBaseUrl('https://api.x.com/v1/chat/completions')).toBe('https://api.x.com/v1');
  });

  it('blocks translation requests to non-https public endpoints', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(translateWithOpenAICompatible({
      endpoint: 'http://api.example.com/v1',
      apiKey: 'test-key',
      model: 'test-model',
      targetLanguage: '简体中文',
      text: 'Hello',
    })).rejects.toMatchObject({ name: 'TranslationServiceError' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('allows translation requests to private LAN endpoints', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: '你好' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(translateWithOpenAICompatible({
      endpoint: 'http://192.168.1.10:8080/v1',
      apiKey: 'test-key',
      model: 'test-model',
      targetLanguage: '简体中文',
      text: 'Hello',
    })).resolves.toBe('你好');
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('http://192.168.1.10:8080/v1/chat/completions', expect.any(Object));
    vi.unstubAllGlobals();
  });
});

describe('OpenAI-compatible provider', () => {
  it('parses a successful chat completion', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: '你好' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(translateWithOpenAICompatible({
      endpoint: 'https://example.com/v1',
      apiKey: 'test-key',
      model: 'test-model',
      targetLanguage: '简体中文',
      text: 'Hello',
    })).resolves.toBe('你好');
  });

  it.each([
    { name: 'responses output_text', payload: { output_text: '你好' } },
    { name: 'choice text', payload: { choices: [{ text: '你好' }] } },
    { name: 'array content', payload: { choices: [{ message: { content: [{ type: 'text', text: '你好' }] } }] } },
  ])('parses $name', async ({ payload }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify(payload),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(translateWithOpenAICompatible({
      endpoint: 'https://example.com/v1',
      apiKey: 'test-key',
      model: 'test-model',
      targetLanguage: '简体中文',
      text: 'Hello',
    })).resolves.toBe('你好');
  });

  it('parses a refusal message from choices[0].message.refusal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: null, refusal: 'I cannot help with that' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(translateWithOpenAICompatible({
      endpoint: 'https://example.com/v1',
      apiKey: 'test-key',
      model: 'test-model',
      targetLanguage: '简体中文',
      text: 'Hello',
    })).resolves.toBe('I cannot help with that');
  });

  it('parses reasoning output when content is null (reasoning model)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: null, reasoning: '这是一篇文章' }, 'finish_reason': 'stop' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(translateWithOpenAICompatible({
      endpoint: 'https://example.com/v1',
      apiKey: 'test-key',
      model: 'sensenova-6.8-flash-lite',
      targetLanguage: '简体中文',
      text: 'This is an article.',
    })).resolves.toBe('这是一篇文章');
  });

  it('reports choices detail when no text can be extracted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: null }, 'finish_reason': 'stop' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(translateWithOpenAICompatible({
      endpoint: 'https://example.com/v1',
      apiKey: 'test-key',
      model: 'test-model',
      targetLanguage: '简体中文',
      text: 'Hello',
    })).rejects.toThrow('finish_reason=stop');
  });

  it('hints about reasoning overflow when a gateway rounds onto a reasoning model', async () => {
    // 复现 9router 聚合轮换：finish_reason=length、正文为空、思维链占满输出
    const payload = {
      id: 'gen-1',
      model: 'glm-5.2',
      object: 'chat.completion',
      usage: { prompt_tokens: 20, completion_tokens: 512 },
      request_id: 'req-1',
      choices: [{
        finish_reason: 'length',
        message: {
          role: 'assistant',
          content: '',
          reasoning_content: '这是一段非常长的思维链，充满了中间推理过程，最终没有被截断清理……',
        },
      }],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify(payload),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(translateWithOpenAICompatible({
      endpoint: 'https://9router.example/v1',
      apiKey: 'test-key',
      model: 'glm-5.2',
      targetLanguage: '简体中文',
      text: 'Hello',
    })).rejects.toThrow(/思维链|推理模型/);
  });

  it('keeps the generic content-refusal guidance when content is empty with a normal refusal shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: null }, 'finish_reason': 'stop' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(translateWithOpenAICompatible({
      endpoint: 'https://example.com/v1',
      apiKey: 'test-key',
      model: 'test-model',
      targetLanguage: '简体中文',
      text: 'Hello',
    })).rejects.toThrow(/内容拒绝策略|空正文/);
  });

  it('uses the same provider path for a pong connectivity test', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: 'pong' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(testOpenAICompatibleConnection({
      endpoint: 'https://example.com/v1',
      apiKey: 'test-key',
      model: 'test-model',
      targetLanguage: '简体中文',
    })).resolves.toBe('pong');
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string).messages[1].content).toContain('hi');
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/v1/chat/completions', expect.any(Object));
  });

  it('normalizes non-2xx responses to a typed service error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad request', { status: 401 })));

    await expect(translateWithOpenAICompatible({
      endpoint: 'https://example.com/v1',
      apiKey: 'test-key',
      model: 'test-model',
      targetLanguage: '简体中文',
      text: 'Hello',
    })).rejects.toMatchObject({ name: 'TranslationServiceError', status: 401 });
  });

  it('parses SSE frames when a gateway streams despite a non-stream request', async () => {
    // 复现 New API / 9router 强制流式：请求未带 stream:true，响应却是 SSE 帧
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"你"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"好"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      sseBody,
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(translateWithOpenAICompatible({
      endpoint: 'https://9router.example/v1',
      apiKey: 'test-key',
      model: 'glm-5.2',
      targetLanguage: '简体中文',
      text: 'Hello',
    })).resolves.toBe('你好');
  });

  it('uses the last non-DONE SSE frame for extraction', async () => {
    const sseBody = [
      'data: {"choices":[{"message":{"content":"旧"}}]}',
      '',
      'data: {"choices":[{"message":{"content":"新"}}]}',
      '',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      sseBody,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )));

    await expect(translateWithOpenAICompatible({
      endpoint: 'https://9router.example/v1',
      apiKey: 'test-key',
      model: 'glm-5.2',
      targetLanguage: '简体中文',
      text: 'Hello',
    })).resolves.toBe('新');
  });

  it('parses NDJSON rows without a data: prefix (gateway that omits SSE framing)', async () => {
    // 复现：整块 JSON.parse 失败、每行是独立裸 JSON 对象、无 data: 前缀
    const ndjsonBody = [
      '{"id":"gen-1","object":"chat.completion","model":"kimi-k2.6","choices":[{"message":{"content":"首段"}}]}',
      '{"id":"gen-2","object":"chat.completion","model":"kimi-k2.6","choices":[{"message":{"content":"末段"}}]}',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      ndjsonBody,
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(translateWithOpenAICompatible({
      endpoint: 'https://9router.example/v1',
      apiKey: 'test-key',
      model: 'kimi-k2.6',
      targetLanguage: '简体中文',
      text: 'Hello',
    })).resolves.toBe('末段');
  });

  it('merges NDJSON delta rows into the full translation', async () => {
    const ndjsonBody = [
      '{"choices":[{"delta":{"content":"前"}}]}',
      '{"choices":[{"delta":{"content":"后"}}]}',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      ndjsonBody,
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(translateWithOpenAICompatible({
      endpoint: 'https://9router.example/v1',
      apiKey: 'test-key',
      model: 'kimi-k2.6',
      targetLanguage: '简体中文',
      text: 'Hello',
    })).resolves.toBe('前后');
  });

  it('surfaces an actionable message for 429 rate limits with reset hint', async () => {
    const body = JSON.stringify({
      error: {
        message: '[openai-compatible-chat-x/glm-5.2] [429]: HTTP error 429: (reset after 13s)',
        type: 'rate_limit_error',
        code: '429',
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 429 })));

    await expect(translateWithOpenAICompatible({
      endpoint: 'https://9router.example/v1',
      apiKey: 'test-key',
      model: 'glm-5.2',
      targetLanguage: '简体中文',
      text: 'Hello',
    })).rejects.toThrow('请求过于频繁（429），请约 13 秒后重试');
  });

  it('requires an API key before making a request', async () => {
    await expect(translateWithOpenAICompatible({
      endpoint: 'https://example.com/v1',
      apiKey: '',
      model: 'test-model',
      targetLanguage: '简体中文',
      text: 'Hello',
    })).rejects.toBeInstanceOf(TranslationServiceError);
  });
});

describe('Batch translation provider', () => {
  it('parses tagged batch output with correct paragraph count', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: '<paragraph_1>Hello</paragraph_1><paragraph_2>World</paragraph_2><paragraph_3>Test</paragraph_3>' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    const result = await translateBatchWithOpenAICompatible({
      endpoint: 'https://example.com/v1',
      apiKey: 'test-key',
      model: 'test-model',
      targetLanguage: '简体中文',
      paragraphs: ['Hello', 'World', 'Test'],
    });

    expect(result).toEqual(['Hello', 'World', 'Test']);
    expect(result.length).toBe(3);
  });

  it('returns exactly N results when model output has fewer tags than paragraphs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: '<paragraph_1>First translation only</paragraph_1>' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    const result = await translateBatchWithOpenAICompatible({
      endpoint: 'https://example.com/v1',
      apiKey: 'test-key',
      model: 'test-model',
      targetLanguage: '简体中文',
      paragraphs: ['Para A', 'Para B', 'Para C'],
    });

    expect(result.length).toBe(3);
    expect(result[0]).toBe('First translation only');
    expect(result[1]).toBe('');
    expect(result[2]).toBe('');
  });

  it('respects maxBatchSize by splitting into multiple batches', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callCount += 1;
      const output = Array.from({ length: 2 }, (_, i) =>
        `<paragraph_${i + 1}>Translated ${i + 1}</paragraph_${i + 1}>`,
      ).join('');
      return Promise.resolve(new Response(
        JSON.stringify({ choices: [{ message: { content: output } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
    }));

    const result = await translateBatchWithOpenAICompatible({
      endpoint: 'https://example.com/v1',
      apiKey: 'test-key',
      model: 'test-model',
      targetLanguage: '简体中文',
      paragraphs: ['A', 'B', 'C', 'D', 'E'],
      maxBatchSize: 2,
    });

    expect(result.length).toBe(5);
    expect(callCount).toBe(3);
    expect(result[0]).toBe('Translated 1');
    expect(result[1]).toBe('Translated 2');
    expect(result[4]).toBe('Translated 1');
  });
});

describe('streaming batch provider', () => {
  const sseResponse = (frames: string[]): Response =>
    new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );

  const baseRequest = {
    endpoint: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'test-model',
    targetLanguage: '简体中文',
  };

  it('streams paragraphs progressively via SSE deltas', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: '<paragraph_1>你' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: '好</paragraph_1><paragraph_2>世' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: '界</paragraph_2>' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const trace: string[] = [];
    const result = await streamTranslateBatch(
      { ...baseRequest, paragraphs: ['Hello', 'World'] },
      {
        onPartial: (index, text) => trace.push(`partial:${index}:${text}`),
        onParagraph: (index, text) => trace.push(`paragraph:${index}:${text}`),
      },
    );

    const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(requestBody.stream).toBe(true);
    expect(result.completedCount).toBe(2);
    expect(trace).toEqual([
      'partial:0:你',
      'paragraph:0:你好',
      'partial:1:世',
      'paragraph:1:世界',
    ]);
  });

  it('skips reasoning deltas and only forwards content deltas', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '思考过程' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: '<paragraph_1>你好</paragraph_1>' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ])));

    const trace: string[] = [];
    await streamTranslateBatch(
      { ...baseRequest, paragraphs: ['Hello'] },
      {
        onPartial: () => trace.push('partial'),
        onParagraph: (_index, text) => trace.push(text),
      },
    );

    expect(trace).toEqual(['你好']);
  });

  it('falls back to JSON parsing when provider ignores streaming', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: '<paragraph_1>你好</paragraph_1><paragraph_2>世界</paragraph_2>' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    const trace: string[] = [];
    const result = await streamTranslateBatch(
      { ...baseRequest, paragraphs: ['Hello', 'World'] },
      {
        onPartial: () => trace.push('partial'),
        onParagraph: (_index, text) => trace.push(text),
      },
    );

    expect(trace).toEqual(['你好', '世界']);
    expect(result.completedCount).toBe(2);
  });

  it('handles a final SSE frame without trailing newline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: '<paragraph_1>你好</paragraph_1>' } }] })}`,
    ])));

    const trace: string[] = [];
    const result = await streamTranslateBatch(
      { ...baseRequest, paragraphs: ['Hello'] },
      {
        onPartial: () => trace.push('partial'),
        onParagraph: (_index, text) => trace.push(text),
      },
    );

    expect(trace).toEqual(['你好']);
    expect(result.completedCount).toBe(1);
  });

  it('normalizes non-2xx stream responses to a typed service error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 })));

    await expect(streamTranslateBatch(
      { ...baseRequest, paragraphs: ['Hello'] },
      { onPartial: () => undefined, onParagraph: () => undefined },
    )).rejects.toMatchObject({ name: 'TranslationServiceError', status: 401 });
  });
});
