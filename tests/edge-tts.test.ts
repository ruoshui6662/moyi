import { describe, expect, it, vi } from 'vitest';
import {
  EDGE_TTS_ENDPOINT,
  EDGE_TTS_VOICES_ENDPOINT,
  base64ToBytes,
  buildConfigFrame,
  buildEdgeSsml,
  buildSsmlFrame,
  bytesToBase64,
  concatBytes,
  prosodyRate,
  defaultEdgeVoiceForLang,
  resolveEdgeVoice,
  synthesizeEdgeSpeech,
  type EdgeSocket,
} from '../chrome-plugin/src/utils/edgeTts';

/** 假 socket：记录发送帧；由用例驱动 onopen/onmessage 模拟协议回放。 */
const makeFakeSocket = (): { socket: EdgeSocket; sent: string[] } => {
  const sent: string[] = [];
  const socket: EdgeSocket = {
    send: (data) => sent.push(data),
    close: () => undefined,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  return { socket, sent };
};

describe('Edge TTS 协议构造（无联网）', () => {
  it('端点含可信令牌；音色列表为独立 HTTP 接口', () => {
    expect(EDGE_TTS_ENDPOINT).toMatch(/^wss:\/\/speech\.platform\.bing\.com\//);
    expect(EDGE_TTS_ENDPOINT).toContain('TrustedClientToken=');
    expect(EDGE_TTS_VOICES_ENDPOINT).toMatch(/^https:\/\/speech\.platform\.bing\.com\//);
  });

  it('语速倍率 → prosody 百分比（0.5–2 钳制）', () => {
    expect(prosodyRate(1)).toBe('+0%');
    expect(prosodyRate(1.2)).toBe('+20%');
    expect(prosodyRate(0.65)).toBe('-35%');
    expect(prosodyRate(9)).toBe('+100%');
    expect(prosodyRate(0.1)).toBe('-50%');
    expect(prosodyRate(Number.NaN)).toBe('+0%');
  });

  it('SSML：语言取自音色 ShortName，文本 XML 转义', () => {
    const ssml = buildEdgeSsml('a < b & c', 'zh-CN-XiaoxiaoNeural', 1.1);
    expect(ssml).toContain('xml:lang="zh-cn"');
    expect(ssml).toContain('name="zh-CN-XiaoxiaoNeural"');
    expect(ssml).toContain('a &lt; b &amp; c');
    expect(ssml).toContain('rate="+10%"');
  });

  it('握手两帧：先 speech.config 再 ssml', () => {
    const config = buildConfigFrame();
    expect(config).toContain('Path:speech.config');
    expect(config).toContain('audio-24khz-48kbitrate-mono-mp3');
    const ssmlFrame = buildSsmlFrame('<speak/>', 'req-1');
    expect(ssmlFrame).toContain('Path:ssml');
    expect(ssmlFrame).toContain('X-RequestId:req-1');
  });

  it('字节工具：合并与 base64 往返（含大块数据）', () => {
    expect([...concatBytes([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])])]).toEqual([1, 2, 3, 4, 5]);
    const big = new Uint8Array(100_000).fill(7);
    expect([...base64ToBytes(bytesToBase64(big))]).toEqual([...big]);
  });
});

describe('synthesizeEdgeSpeech（假 socket 协议回放）', () => {
  it('open→发两帧→收二进制分片→response 帧结束，返回合并音频', async () => {
    const { socket, sent } = makeFakeSocket();
    const promise = synthesizeEdgeSpeech({
      text: '你好世界',
      voice: 'zh-CN-XiaoxiaoNeural',
      rate: 1.1,
      createSocket: () => socket,
    });
    socket.onopen?.();
    socket.onmessage?.({ data: new Uint8Array([1, 2]).buffer });
    socket.onmessage?.({ data: new Uint8Array([3, 4]).buffer });
    socket.onmessage?.({ data: 'X-RequestId:1\r\nPath:response\r\n\r\n' });
    const audio = await promise;
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('Path:speech.config');
    expect(sent[1]).toContain('Path:ssml');
    expect([...audio]).toEqual([1, 2, 3, 4]);
  });

  it('ArrayBuffer 视图分片同样收集', async () => {
    const { socket } = makeFakeSocket();
    const promise = synthesizeEdgeSpeech({ text: 'hi', voice: 'en-US-AvaNeural', createSocket: () => socket });
    socket.onopen?.();
    const view = new Uint8Array([9, 9, 9]);
    socket.onmessage?.({ data: view });
    socket.onmessage?.({ data: 'Path:response' });
    expect([...(await promise)]).toEqual([9, 9, 9]);
  });

  it('空文本直接拒绝，不建连', async () => {
    const createSocket = vi.fn();
    await expect(synthesizeEdgeSpeech({ text: '   ', voice: 'en-US-AvaNeural', createSocket })).rejects.toThrow(/没有可朗读/);
    expect(createSocket).not.toHaveBeenCalled();
  });

  it('连接错误 → 可读错误（宿主据此回退系统语音）', async () => {
    const { socket } = makeFakeSocket();
    const promise = synthesizeEdgeSpeech({ text: 'hi', voice: 'en-US-AvaNeural', createSocket: () => socket });
    socket.onerror?.();
    await expect(promise).rejects.toThrow(/回退系统语音/);
  });

  it('连接关闭但无音频 → 明确失败，不返回空音频', async () => {
    const { socket } = makeFakeSocket();
    const promise = synthesizeEdgeSpeech({ text: 'hi', voice: 'en-US-AvaNeural', createSocket: () => socket });
    socket.onmessage?.({ data: 'Path:response' });
    await expect(promise).rejects.toThrow(/未返回音频/);
  });

  it('超时兜底：20 秒不返回则报错（fake timers）', async () => {
    vi.useFakeTimers();
    try {
      const { socket } = makeFakeSocket();
      const promise = synthesizeEdgeSpeech({ text: 'hi', voice: 'en-US-AvaNeural', createSocket: () => socket });
      const assertion = expect(promise).rejects.toThrow(/超时/);
      await vi.advanceTimersByTimeAsync(20_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('云端音色选择（defaultEdgeVoiceForLang / resolveEdgeVoice）', () => {
  it('按语言码取默认音色；未知语言回退英文女声', () => {
    expect(defaultEdgeVoiceForLang('zh-CN')).toBe('zh-CN-XiaoxiaoNeural');
    expect(defaultEdgeVoiceForLang('ja-JP')).toBe('ja-JP-NanamiNeural');
    expect(defaultEdgeVoiceForLang('ko-KR')).toBe('ko-KR-SunHiNeural');
    expect(defaultEdgeVoiceForLang('xx-YY')).toBe('en-US-AvaNeural');
    expect(defaultEdgeVoiceForLang(undefined)).toBe('en-US-AvaNeural');
  });

  it('所选音色与朗读语言一致时保留；不一致时换该语言默认音色（读中文译文别用英文音色）', () => {
    expect(resolveEdgeVoice('zh-CN-XiaoxiaoNeural', 'zh-CN')).toBe('zh-CN-XiaoxiaoNeural');
    expect(resolveEdgeVoice('zh-CN-XiaoxiaoNeural', 'en-US')).toBe('en-US-AvaNeural');
    expect(resolveEdgeVoice('en-US-AvaNeural', undefined)).toBe('en-US-AvaNeural');
  });
});

describe('Edge TTS 配置契约（chrome.storage 桩）', () => {
  it('默认系统语音；脏值收敛；edge 音色形态校验', async () => {
    const store = new Map<string, unknown>();
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (k: string) => ({ [k]: store.get(k) }),
          set: async (v: Record<string, unknown>) => { for (const [k, val] of Object.entries(v)) store.set(k, val); },
        },
      },
    });
    try {
      const { DEFAULT_CONFIG, getConfig, saveConfig, DEFAULT_EDGE_VOICE } = await import('../chrome-plugin/src/utils/config');
      const base = await getConfig();
      expect(base.ttsSource).toBe('system');
      expect(base.ttsEdgeVoice).toBe(DEFAULT_EDGE_VOICE);
      await saveConfig({ ...DEFAULT_CONFIG, ttsSource: 'edge', ttsEdgeVoice: 'en-GB-RyanNeural' });
      expect((await getConfig()).ttsSource).toBe('edge');
      await saveConfig({ ...DEFAULT_CONFIG, ttsSource: 'weird' as never, ttsEdgeVoice: 'not a voice!!' });
      const dirty = await getConfig();
      expect(dirty.ttsSource).toBe('system');
      expect(dirty.ttsEdgeVoice).toBe(DEFAULT_EDGE_VOICE);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
