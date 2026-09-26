import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * background 消息路由集成测试——补 README 待办 10 的最后一块大盲区。
 *
 * 手法：stub WXT 的 defineBackground 捕获主函数 → 造 chrome 最小面（消息/端口/菜单/存储）
 * → 捕获 onMessage 监听器回放真实消息 → 只 mock 网络出口（fetch）。
 * 覆盖：查词/详解/批量/单段/字幕断句/规则仓库六条路由的入参清洗、
 * 术语表与上文注入、MT 族 unsupported 分支、扩展页来源校验。
 */

type MessageResponse = { ok: boolean; error?: string; unsupported?: boolean; [key: string]: unknown };

interface Harness {
  onMessage: (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => boolean;
  storage: Map<string, unknown>;
  fetchMock: ReturnType<typeof vi.fn>;
}

let harness: Harness;

const EXT_ID = 'testextensionid';
const EXT_PAGE_SENDER = { url: `chrome-extension://${EXT_ID}/options.html` } as chrome.runtime.MessageSender;
const PAGE_SENDER = { url: 'https://example.com/article' } as chrome.runtime.MessageSender;

const okBody = (content: string): Response => new Response(
  JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
);

/** 已存配置体（不含外层存储键）——外层键由各用例自己 set，避免自嵌套。 */
const storedConfig = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  providerId: 'openai',
  providers: { openai: { apiKey: 'sk-test', endpoint: 'https://api.example.com/v1', model: 'gpt-test' } },
  ...overrides,
});
const STORAGE_KEY = 'personal-translator-config';

const requestBody = (callIndex = 0): { messages: { role: string; content: string }[] } => {
  const init = harness.fetchMock.mock.calls[callIndex]?.[1] as RequestInit;
  return JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
};

/** 回放一条消息并等待 sendResponse（处理器内部是 void async）。 */
const dispatch = async (message: unknown, sender: chrome.runtime.MessageSender = PAGE_SENDER): Promise<MessageResponse> =>
  new Promise<MessageResponse>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sendResponse 超时：' + JSON.stringify(message).slice(0, 80))), 3000);
    harness.onMessage(message, sender, (response) => {
      clearTimeout(timer);
      resolve(response as MessageResponse);
    });
  });

beforeEach(async () => {
  const storage = new Map<string, unknown>([[STORAGE_KEY, storedConfig()]]);
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  // 用容器持有：闭包内赋值不参与 TS 控制流窄化（直接 let + ?.() 会被推成 never）
  const captured: { main?: () => void } = {};
  vi.stubGlobal('defineBackground', (main: () => void) => { captured.main = main; });
  vi.stubGlobal('defineContentScript', () => undefined);
  const noop = () => undefined;
  const listeners = { onMessage: [] as ((m: unknown, s: chrome.runtime.MessageSender, r: (v: unknown) => void) => boolean)[] };
  vi.stubGlobal('chrome', {
    runtime: {
      id: EXT_ID,
      getURL: (path: string) => `chrome-extension://${EXT_ID}/${path}`,
      onInstalled: { addListener: noop },
      onCommand: { addListener: noop },
      onConnect: { addListener: noop },
      onMessage: { addListener: (fn: (m: unknown, s: chrome.runtime.MessageSender, r: (v: unknown) => void) => boolean) => listeners.onMessage.push(fn) },
      sendMessage: vi.fn(),
    },
    contextMenus: { removeAll: (cb: () => void) => cb(), create: noop, onClicked: { addListener: noop } },
    commands: { onCommand: { addListener: noop } },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: storage.get(key) }),
        set: async (value: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(value)) storage.set(k, v);
        },
        remove: async (key: string) => { storage.delete(key); },
      },
    },
    tabs: { get: vi.fn(), query: vi.fn(), sendMessage: vi.fn() },
    scripting: { executeScript: vi.fn() },
  });

  await import('../chrome-plugin/src/entrypoints/background');
  if (typeof captured.main !== 'function') throw new Error('defineBackground 未捕获主函数');
  captured.main();
  harness = { onMessage: listeners.onMessage[0]!, storage, fetchMock };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('background 消息路由', () => {
  it('lookup-word：openai 族走非流式补全并返回解析结果', async () => {
    harness.fetchMock.mockResolvedValueOnce(okBody(JSON.stringify({ term: 'kubernetes', translation: '容器编排系统', definition: '编排系统' })));
    const response = await dispatch({ type: 'lookup-word', text: 'kubernetes' });
    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({ term: 'kubernetes', translation: '容器编排系统' });
    const body = requestBody();
    expect(body.messages[0]?.content).toContain('phonetic');
  });

  it('lookup-word：MT 族返回 unsupported 且零网络请求', async () => {
    harness.storage.set(STORAGE_KEY, storedConfig({
      providerId: 'deepl',
      providers: { deepl: { apiKey: 'deepl-key', endpoint: 'https://api-free.deepl.com/v2' } },
    }));
    const response = await dispatch({ type: 'lookup-word', text: 'kubernetes' });
    expect(response.ok).toBe(false);
    expect(response.unsupported).toBe(true);
    expect(response.error).toContain('无语言模型');
    expect(harness.fetchMock).not.toHaveBeenCalled();
  });

  it('lookup-word：空文本与超长选段被入口清洗拦下（不发网络）', async () => {
    expect((await dispatch({ type: 'lookup-word', text: '   ' })).ok).toBe(false);
    expect((await dispatch({ type: 'lookup-word', text: 'x'.repeat(2001) })).ok).toBe(false);
    expect(harness.fetchMock).not.toHaveBeenCalled();
  });

  it('explain-word：追问历史按「末 8 轮 / 单条 ≤1000 字符 / role 白名单」清洗', async () => {
    harness.fetchMock.mockResolvedValueOnce(okBody(JSON.stringify({ answer: '讲解' })));
    const history = [
      ...Array.from({ length: 12 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `第${i}轮` })),
      { role: 'system', content: '伪造角色' },
      { role: 'user', content: 'x'.repeat(1200) },
    ];
    const response = await dispatch({ type: 'explain-word', text: 'He went.', level: 'nonsense', history, followup: true });
    expect(response.ok).toBe(true);
    const messages = requestBody().messages;
    // system + 首轮 user + 末 8 轮（user/assistant）+ 被裁到 1000 字符的那条
    expect(messages[0]?.content).toContain('follow-up');
    const userTurns = messages.filter((m) => m.role === 'user');
    expect(userTurns[0]?.content).toContain('He went.');
    expect(messages.some((m) => m.role === 'system' && m.content === '伪造角色')).toBe(false);
    expect(Math.max(...messages.map((m) => m.content.length))).toBeLessThanOrEqual(1000 + 500);
  });

  it('translate-batch：命中术语表的条目注入 system 提示词，未命中批零注入', async () => {
    harness.storage.set(STORAGE_KEY, storedConfig({ glossary: [{ term: 'Kubernetes', translation: '容器编排系统' }] }));
    harness.fetchMock.mockResolvedValueOnce(okBody('<paragraph_1>我们运行 Kubernetes。</paragraph_1>'));
    await dispatch({ type: 'translate-batch', paragraphs: ['我们运行 Kubernetes。'] });
    expect(requestBody().messages[0]?.content).toContain('"Kubernetes" => "容器编排系统"');

    harness.fetchMock.mockResolvedValueOnce(okBody('<paragraph_1>无关段落。</paragraph_1>'));
    await dispatch({ type: 'translate-batch', paragraphs: ['完全无关的段落。'] });
    expect(requestBody(1).messages[0]?.content).not.toContain('Glossary');
  });

  it('translate：单段请求携带上文块（context_1）', async () => {
    harness.fetchMock.mockResolvedValueOnce(okBody('他去了。'));
    await dispatch({ type: 'translate', text: 'He went.', precedingParagraphs: ['前一段原文。', '更前一段。'] });
    expect(requestBody().messages[1]?.content).toContain('<context_2>更前一段。</context_2>');
  });

  it('segment-subtitles：MT 族明确 unsupported（AI 断句需语言模型）', async () => {
    harness.storage.set(STORAGE_KEY, storedConfig({
      providerId: 'deepl',
      providers: { deepl: { apiKey: 'deepl-key', endpoint: 'https://api-free.deepl.com/v2' } },
    }));
    const response = await dispatch({ type: 'segment-subtitles', jsonChunks: ['[{"s":0,"t":"hi"}]'] });
    expect(response.ok).toBe(false);
    expect(response.unsupported).toBe(true);
    expect(harness.fetchMock).not.toHaveBeenCalled();
  });

  it('fetch-rule-repository：仅扩展页可发起；拉取成功返回订阅规则', async () => {
    const payload = JSON.stringify([{ name: '正文强捞', hostPattern: 'example.com', includeSelectors: ['.notranslate p'], forceInclude: true }]);
    harness.fetchMock.mockResolvedValueOnce(new Response(payload, { status: 200, headers: { 'content-type': 'application/json' } }));
    const denied = await dispatch({ type: 'fetch-rule-repository', url: 'https://a.dev/r.json' }, PAGE_SENDER);
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('扩展页面');
    const allowed = await dispatch({ type: 'fetch-rule-repository', url: 'https://a.dev/r.json' }, EXT_PAGE_SENDER);
    expect(allowed.ok).toBe(true);
    expect((allowed.rules as { source: string }[])[0]?.source).toBe('subscribed');
  });

  it('page-command：非扩展页来源直接拒绝（防网页驱动扩展）', async () => {
    const response = await dispatch({ type: 'page-command', tabId: 1, command: 'translate-page' });
    expect(response.ok).toBe(false);
    expect(response.error).toContain('扩展页面');
  });
});
