import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildTimedtextUrl,
  extractCaptionDataFromHtml,
  extractPotFromUrl,
  fetchJson3Cues,
  findCueAt,
  isNoiseText,
  joinSegs,
  parseJson3Events,
  parseJson3Payload,
  selectTrack,
} from '../chrome-plugin/src/utils/subtitles/trackLoader';
import type { CaptionTrackInfo } from '../chrome-plugin/src/utils/subtitles/protocol';

const isZh = (code: string): boolean => code.toLowerCase().startsWith('zh');

const track = (overrides: Partial<CaptionTrackInfo> & { baseUrl?: string }): CaptionTrackInfo => ({
  baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=en',
  languageCode: 'en',
  ...overrides,
});

describe('segs 拼接与噪声过滤', () => {
  it('拉丁片段保留词间空格，CJK 片段不留空格', () => {
    expect(joinSegs([{ utf8: 'Hello' }, { utf8: ' world' }, { utf8: '!' }])).toBe('Hello world!');
    expect(joinSegs([{ utf8: '你' }, { utf8: ' 好' }])).toBe('你好');
  });

  it('识别纯噪声行', () => {
    for (const noise of ['', '   ', '[Music]', '[Applause]', '（掌声）', '(Laughter)', '♪♪♪', '🎵🎶']) {
      expect(isNoiseText(noise)).toBe(true);
    }
    expect(isNoiseText('Hello world')).toBe(false);
    expect(isNoiseText('你好世界')).toBe(false);
  });
});

describe('json3 解析归一化', () => {
  it('标准字幕：一条 event 一条 cue，结束时间钳到下一条开始', () => {
    const cues = parseJson3Events([
      { tStartMs: 0, dDurationMs: 5000, segs: [{ utf8: 'First line' }] },
      { tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: 'Second line' }] },
      { tStartMs: 6000, dDurationMs: 1500, segs: [{ utf8: 'Third' }] },
    ]);
    expect(cues).toEqual([
      { start: 0, end: 2000, text: 'First line' },
      { start: 2000, end: 4000, text: 'Second line' },
      { start: 6000, end: 7500, text: 'Third' },
    ]);
  });

  it('ASR 滚动追加：aAppend=1 向当前条目归并文本并推进结束时间', () => {
    const cues = parseJson3Events([
      { tStartMs: 1000, dDurationMs: 4000, segs: [{ utf8: 'rolling' }] },
      { tStartMs: 1500, dDurationMs: 3000, aAppend: 1, segs: [{ utf8: ' window' }] },
      { tStartMs: 6000, dDurationMs: 2000, segs: [{ utf8: 'Next' }] },
    ]);
    expect(cues[0]).toMatchObject({ start: 1000, end: 5000, text: 'rolling window' });
    expect(cues).toHaveLength(2);
  });

  it('噪声与缺时间戳的 event 被丢弃，相邻同文合并', () => {
    const cues = parseJson3Events([
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: '[Music]' }] },
      { segs: [{ utf8: 'no timestamp' }] },
      { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Repeat' }] },
      { tStartMs: 1200, dDurationMs: 1800, segs: [{ utf8: 'Repeat' }] },
      { tStartMs: 5000, dDurationMs: 1000, segs: [{ utf8: 'End' }] },
    ]);
    expect(cues.map((cue) => cue.text)).toEqual(['Repeat', 'End']);
    // 合并取两段结束时间的较大者：max(3000, 3000) = 3000，且未被下一条（5s）钳小
    expect(cues[0].end).toBe(3000);
  });
});

describe('parseJson3Payload 容错', () => {
  it('非法 JSON / 缺 events / 空数据均抛错', () => {
    expect(() => parseJson3Payload('not-json')).toThrow();
    expect(() => parseJson3Payload('{}')).toThrow();
    expect(() => parseJson3Payload(JSON.stringify({ events: [] }))).toThrow();
  });

  it('合法数据返回归一化结果', () => {
    const cues = parseJson3Payload(JSON.stringify({
      events: [{ tStartMs: 0, dDurationMs: 1200, segs: [{ utf8: 'Hi' }] }],
    }));
    expect(cues).toHaveLength(1);
  });
});

describe('取轨选择', () => {
  it('优先非目标语言的人工字幕，其次 ASR；全部同语言返回 null', () => {
    const tracks = [
      track({ languageCode: 'zh', kind: 'asr' }),
      track({ languageCode: 'en', kind: 'asr' }),
      track({ languageCode: 'en' }),
      track({ languageCode: 'ja' }),
    ];
    expect(selectTrack(tracks, isZh)?.languageCode).toBe('en');
    expect(selectTrack(tracks, isZh)?.kind).toBeUndefined();

    expect(selectTrack([track({ languageCode: 'en', kind: 'asr' })], isZh)?.kind).toBe('asr');
    expect(selectTrack([track({ languageCode: 'zh' }), track({ languageCode: 'zh-CN', kind: 'asr' })], isZh)).toBeNull();
  });

  it('忽略没有 timedtext 地址的轨道（防御脏数据）', () => {
    const tracks = [
      { baseUrl: 'https://example.com/other', languageCode: 'en' },
      track({ languageCode: 'fr' }),
    ];
    expect(selectTrack(tracks as CaptionTrackInfo[], isZh)?.languageCode).toBe('fr');
  });
});

describe('timedtext URL 拼装与令牌提取', () => {
  it('固定配方参数 + 设备指纹 + cver + pot/potc；HTML 转义先还原', () => {
    const url = buildTimedtextUrl(
      'https://www.youtube.com/api/timedtext?v=abc&amp;lang=en',
      {
        device: { cbrand: 'Google', cbr: 'Chrome', cbrver: '126', cos: 'Windows', cosver: '10', cplatform: 'DESKTOP', junk: 'x' },
        cver: '20240101',
        pot: 'POT123',
        potc: '1',
      },
    );
    const params = new URL(url).searchParams;
    expect(params.get('fmt')).toBe('json3');
    expect(params.get('xorb')).toBe('2');
    expect(params.get('xobt')).toBe('3');
    expect(params.get('xovt')).toBe('3');
    expect(params.get('c')).toBe('WEB');
    expect(params.get('cplayer')).toBe('UNIPLAYER');
    expect(params.get('lang')).toBe('en');
    expect(params.get('cbrand')).toBe('Google');
    expect(params.get('cplatform')).toBe('DESKTOP');
    expect(params.get('junk')).toBeNull();
    expect(params.get('cver')).toBe('20240101');
    expect(params.get('pot')).toBe('POT123');
    expect(params.get('potc')).toBe('1');
  });

  it('从任意地址中提取 pot/potc', () => {
    const extracted = extractPotFromUrl('https://www.youtube.com/api/timedtext?v=x&pot=TOKEN&potc=1');
    expect(extracted.pot).toBe('TOKEN');
    expect(extracted.potc).toBe('1');
    expect(extractPotFromUrl('https://www.youtube.com/api/timedtext?v=x').pot).toBeUndefined();
  });
});

describe('按时间查 cue（二分）', () => {
  const cues = [
    { start: 0, end: 2000, text: 'A' },
    { start: 3000, end: 5000, text: 'B' },
    { start: 8000, end: 9000, text: 'C' },
  ];

  it('命中区间返回 cue，间隙返回 null', () => {
    expect(findCueAt(cues, 1000)?.text).toBe('A');
    expect(findCueAt(cues, 2500)).toBeNull();
    expect(findCueAt(cues, 8500)?.text).toBe('C');
    expect(findCueAt(cues, 9500)).toBeNull();
    expect(findCueAt([], 0)).toBeNull();
  });
});

describe('页面 HTML 兜底提取（桥接不可用时的降级通道）', () => {
  const html = [
    '<script>',
    'var ytInitialPlayerResponse = {',
    '"videoDetails":{"videoId":"abc123"},',
    '"captions":{"playerCaptionsTracklistRenderer":{',
    '"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=abc&amp;lang=en","languageCode":"en","name":{"simpleText":"English"}},',
    '{"baseUrl":"https://www.youtube.com/api/timedtext?v=abc&lang=zh&kind=asr","languageCode":"zh","kind":"asr"}]',
    '}},',
    '"audioTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=abc&pot=TOKEN1&potc=1"},{"baseUrl":"https://other.invalid/x"}]',
    '};',
    '</script>',
  ].join('\n');

  it('提取 captionTracks 与 audioTracks，且音轨地址仅保留 timedtext 域', () => {
    const data = extractCaptionDataFromHtml(html);
    expect(data.tracks).toHaveLength(2);
    expect(data.tracks[0]).toMatchObject({ languageCode: 'en', kind: undefined, name: 'English' });
    expect(data.tracks[1]?.kind).toBe('asr');
    expect(data.audioTrackUrls).toEqual(['https://www.youtube.com/api/timedtext?v=abc&pot=TOKEN1&potc=1']);
  });

  it('无字幕数据时返回空结构而非抛错', () => {
    expect(extractCaptionDataFromHtml('<html><body>hello</body></html>')).toEqual({ tracks: [], audioTrackUrls: [] });
  });

  it('JSON 被截断（括号不闭合）时安全返回空结构', () => {
    const broken = '"captionTracks":[{"baseUrl":"https://x/api/timedtext","languageCode":"en"';
    expect(extractCaptionDataFromHtml(broken)).toEqual({ tracks: [], audioTrackUrls: [] });
  });
});

describe('fetchJson3Cues 候选轮询与错误聚合', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const track: CaptionTrackInfo = {
    baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=en',
    languageCode: 'en',
  };

  const mockFetch = (impl: (url: string) => { ok: boolean; status?: number; body?: string }): void => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const response = impl(String(input));
      return {
        ok: response.ok,
        status: response.status ?? 200,
        text: async () => response.body ?? '',
      } as unknown as Response;
    }));
  };

  it('优先使用带令牌候选；成功时 URL 携带 fmt=json3 与 pot', async () => {
    let requestedUrl = '';
    mockFetch((url) => {
      requestedUrl = url;
      return { ok: true, body: JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hi' }] }] }) };
    });
    const cues = await fetchJson3Cues(track, { attemptGapMs: 0, potCandidates: ['https://www.youtube.com/api/timedtext?v=abc&pot=P1'] });
    expect(cues.map((cue) => cue.text)).toEqual(['Hi']);
    expect(requestedUrl).toContain('fmt=json3');
    expect(requestedUrl).toContain('pot=P1');
  });

  it('全部失败时抛出含尝试明细的聚合错误；空响应被单独标注', async () => {
    mockFetch((url) => (url.includes('pot=') ? { ok: false, status: 403 } : { ok: true, body: '' }));
    await expect(
      fetchJson3Cues(track, { attemptGapMs: 0, potCandidates: ['https://www.youtube.com/api/timedtext?v=abc&pot=BAD'] }),
    ).rejects.toThrow(/共尝试 2 个地址全部失败.*带令牌.*HTTP 403.*裸地址.*空响应/s);
  });

  it('突发限幅：令牌候选再多也只试 2 个，加裸地址共 3 次', async () => {
    const requestedUrls: string[] = [];
    mockFetch((url) => {
      requestedUrls.push(url);
      return { ok: false, status: 403 };
    });
    const pots = ['A', 'B', 'C', 'D']
      .map((token) => `https://www.youtube.com/api/timedtext?v=abc&pot=${token}`);
    await expect(
      fetchJson3Cues(track, { attemptGapMs: 0, potCandidates: pots }),
    ).rejects.toThrow(/共尝试 3 个地址全部失败/);
    expect(requestedUrls).toHaveLength(3);
    expect(requestedUrls[0]).toContain('pot=A');
    expect(requestedUrls[1]).toContain('pot=B');
    // 裸地址兜底始终保留在最后
    expect(requestedUrls[2]).not.toContain('pot=');
  });
});
