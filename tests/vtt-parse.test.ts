import { describe, expect, it } from 'vitest';
import {
  extractVttSegmentUrls,
  hasActiveEncryption,
  looksLikeVttSegmentList,
  mergeVttCues,
  parseHlsAttributes,
  parseHlsSubtitleRenditions,
  parseTimestampMapOffsetMs,
  parseWebVtt,
  selectRendition,
} from '../chrome-plugin/src/utils/subtitles/vtt';
import { buildUnitCacheKey, UNIT_CACHE_PREFIX_X } from '../chrome-plugin/src/utils/subtitles/unitCache';

const MASTER_MANIFEST = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio",DEFAULT=YES,URI="/pl/0/audio.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="captions",NAME="English",LANGUAGE="en",AUTOSELECT=YES,DEFAULT=NO,URI="/pl/1/captions/en.m3u8?tag=12"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="captions",NAME="简体中文",LANGUAGE="zh-CN",AUTOSELECT=YES,DEFAULT=NO,URI="https://video.twimg.com/pl/1/captions/zh.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1",AUDIO="audio",SUBTITLES="captions"
https://video.twimg.com/pl/0/720x1280.m3u8`;

const SEGMENT_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:11
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:10.000,
segment_0.vtt
#EXTINF:9.5,
https://video.twimg.com/pl/1/captions/segment_1.vtt?v=2`;

const VTT_WITH_MAP = `WEBVTT
X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000

00:00:00.500 --> 00:00:03.000
Hello <c>world</c> how are you

00:00:03.500 --> 00:00:06.000 line-align:start
[Music]
`;

const VTT_NO_MAP = `WEBVTT

00:00:01.000 --> 00:00:02.500
Second segment tail
`;

describe('parseHlsAttributes', () => {
  it('splits on commas outside quotes and strips quotes', () => {
    const attrs = parseHlsAttributes('TYPE=SUBTITLES,NAME="A,B (auto)",LANGUAGE=en,URI="/a.m3u8"');
    expect(attrs.TYPE).toBe('SUBTITLES');
    expect(attrs.NAME).toBe('A,B (auto)');
    expect(attrs.LANGUAGE).toBe('en');
    expect(attrs.URI).toBe('/a.m3u8');
  });
});

describe('parseHlsSubtitleRenditions', () => {
  it('extracts only SUBTITLES renditions with absolute urls', () => {
    const renditions = parseHlsSubtitleRenditions(
      MASTER_MANIFEST,
      'https://video.twimg.com/pl/0/master.m3u8',
    );
    expect(renditions).toHaveLength(2);
    expect(renditions[0]).toEqual({
      url: 'https://video.twimg.com/pl/1/captions/en.m3u8?tag=12',
      languageCode: 'en',
      name: 'English',
    });
    expect(renditions[1].languageCode).toBe('zh-CN');
    expect(renditions[0].url.startsWith('https://video.twimg.com/')).toBe(true);
  });

  it('returns empty for a playlist without subtitle tracks', () => {
    expect(parseHlsSubtitleRenditions('#EXTM3U\n#EXTINF:10,\nseg.ts', 'https://a/b.m3u8')).toEqual([]);
  });
});

describe('selectRendition', () => {
  const renditions = [
    { url: 'https://x/en', languageCode: 'en' },
    { url: 'https://x/ja', languageCode: 'ja' },
    { url: 'https://x/zh', languageCode: 'zh-CN' },
  ];

  it('prefers first non-target-language track', () => {
    const picked = selectRendition(renditions, (code) => code.toLowerCase().startsWith('zh'));
    expect(picked?.url).toBe('https://x/en');
  });

  it('returns null when all tracks are the target language', () => {
    expect(selectRendition([renditions[2]], (code) => code.toLowerCase().startsWith('zh'))).toBeNull();
  });

  it('skips renditions without language code', () => {
    const picked = selectRendition(
      [{ url: 'https://x/none', languageCode: '' }, ...renditions],
      (code) => code.toLowerCase().startsWith('zh'),
    );
    expect(picked?.url).toBe('https://x/en');
  });
});

describe('playlist helpers', () => {
  it('detects vtt segment lists', () => {
    expect(looksLikeVttSegmentList(SEGMENT_PLAYLIST)).toBe(true);
    expect(looksLikeVttSegmentList('#EXTM3U\n#EXTINF:10,\nseg_01.vtt')).toBe(true);
    expect(looksLikeVttSegmentList(MASTER_MANIFEST)).toBe(false); // 主清单只有 .m3u8 引用
    expect(looksLikeVttSegmentList('#EXTM3U\n#EXTINF:10,\nseg.ts')).toBe(false);
  });

  it('detects active encryption but ignores METHOD=NONE', () => {
    expect(hasActiveEncryption('#EXT-X-KEY:METHOD=AES-128,URI="k"')).toBe(true);
    expect(hasActiveEncryption('#EXT-X-KEY:METHOD=NONE')).toBe(false);
    expect(hasActiveEncryption(SEGMENT_PLAYLIST)).toBe(false);
  });

  it('resolves relative segment urls in order', () => {
    const urls = extractVttSegmentUrls(
      SEGMENT_PLAYLIST,
      'https://video.twimg.com/pl/1/captions/en.m3u8',
    );
    expect(urls).toEqual([
      'https://video.twimg.com/pl/1/captions/segment_0.vtt',
      'https://video.twimg.com/pl/1/captions/segment_1.vtt?v=2',
    ]);
  });
});

describe('parseTimestampMapOffsetMs', () => {
  it('maps MPEGTS 90kHz clock to milliseconds offset', () => {
    expect(parseTimestampMapOffsetMs(['X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000'])).toBe(10_000);
    expect(parseTimestampMapOffsetMs(['X-TIMESTAMP-MAP=LOCAL:00:00:02.000,MPEGTS:900000'])).toBe(8_000);
    expect(parseTimestampMapOffsetMs(['not-a-map'])).toBe(0);
  });
});

describe('parseWebVtt', () => {
  it('strips tags, filters noise and applies timestamp-map offset', () => {
    const cues = parseWebVtt(VTT_WITH_MAP);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('Hello world how are you');
    // LOCAL 0 + MPEGTS 900000 → 整体偏移 +10s
    expect(cues[0].start).toBe(10_500);
    expect(cues[0].end).toBe(13_000);
  });

  it('keeps timings untouched without a map header', () => {
    const cues = parseWebVtt(VTT_NO_MAP);
    expect(cues.map((cue) => cue.start)).toEqual([1_000]);
    expect(cues[0].text).toBe('Second segment tail');
  });
});

describe('mergeVttCues', () => {
  it('merges duplicate boundary cues and clamps overlaps', () => {
    const merged = mergeVttCues([
      { start: 1000, end: 4000, text: 'same text' },
      { start: 3500, end: 6000, text: 'same text' },
      { start: 5500, end: 9000, text: 'next line' },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ start: 1000, end: 5500, text: 'same text' });
    expect(merged[1].end).toBeGreaterThanOrEqual(merged[1].start + 400);
  });
});

describe('unit cache prefix for X', () => {
  it('builds keys under the X namespace', () => {
    expect(buildUnitCacheKey('123', 'en', undefined, UNIT_CACHE_PREFIX_X)).toBe('moyi-x-cues:123:en:manual');
    expect(buildUnitCacheKey('123', 'en')).toBe('moyi-yt-cues:123:en:manual');
  });
});
