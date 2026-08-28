/**
 * X（Twitter）字幕翻译编排脚本（隔离世界）：
 * 桥接脚本收割播放器加载的 HLS 主清单 → 解析 EXT-X-MEDIA 字幕轨道
 * → 拉取 WebVTT 分段（含 X-TIMESTAMP-MAP 时基校正）→ 断句重组
 * → 调度器批量预翻（复用后台翻译通道）→ Shadow DOM 覆盖层随播放渲染。
 *
 * 与 youtube.content.ts 的差异点：
 * - 无 yt-navigate-finish：SPA 导航用 location.href 轮询识别；
 * - 清单可能在会话开始后才到达（视频懒加载）：带轮询等待窗口；
 * - 视频标识优先取 /status/<id>，时间线内嵌视频退化为清单地址派生键。
 */

import {
  SUBTITLE_CONFIG_STORAGE_KEY,
  getSubtitleConfig,
  saveSubtitleConfig,
  type SubtitleConfig,
} from '../utils/subtitles/config';
import { findCueAtWithHold, type SubtitleCue } from '../utils/subtitles/trackLoader';
import {
  extractVttSegmentUrls,
  hasActiveEncryption,
  looksLikeVttSegmentList,
  mergeVttCues,
  parseHlsSubtitleRenditions,
  parseWebVtt,
  selectRendition,
  type HlsSubtitleRendition,
} from '../utils/subtitles/vtt';
import { SubtitleRenderer, clampStepFontSize } from '../utils/subtitles/renderer';
import { buildSubtitleUnits } from '../utils/subtitles/segmenter';
import {
  UNIT_CACHE_PREFIX_X,
  buildUnitCacheKey,
  readCachedUnits,
  writeCachedUnits,
} from '../utils/subtitles/unitCache';
import { createSubtitleScheduler } from '../utils/subtitles/engineAdapter';
import { refineCuesWithAi } from '../utils/subtitles/ai-segmenter';
import { requestViaBridge } from '../utils/subtitles/bridgeChannel';
import { getConfig } from '../utils/config';
import { logger } from '../utils/logger';
import { getProviderMeta } from '../utils/providers';
import { SubtitleScheduler } from '../utils/subtitles/scheduler';
import {
  cacheKey,
  loadTranslationCache,
  saveTranslationCache,
  type TranslationCache,
} from './content/translationCache';

const X_BRIDGE_SOURCE = 'moyi-x-subtitles';

/** 桥接请求超时：收割记录在内存里，响应应即时。 */
const MANIFEST_REQUEST_TIMEOUT_MS = 1_500;
/** 等待清单到达的总窗口：覆盖「点开详情页 → 播放器起播」的常规延迟。 */
const MANIFEST_WAIT_WINDOW_MS = 20_000;
const MANIFEST_POLL_INTERVAL_MS = 1_500;
/** SPA 路由轮询间隔（X 无导航事件可监听）。 */
const HREF_POLL_INTERVAL_MS = 600;
/** 新增译文写持久缓存的防抖窗口。 */
const CACHE_FLUSH_DEBOUNCE_MS = 3_000;
/** 会话级暂停的标签页内记忆键。 */
const PAUSE_STORAGE_KEY = 'moyi-x-subtitle-paused';
/** VTT 分段并发拉取数。 */
const SEGMENT_CONCURRENCY = 6;

type CachePair = { language: string; text: string; translation: string };

interface HarvestedManifest {
  url: string;
  body: string;
}

let config: SubtitleConfig | null = null;
let sessionToken = 0;
let sessionKey = '';
/** 最近一次尝试启动的会话键：防止轮询对同一目标反复重启。 */
let attemptedKey = '';
let subtitleUnits: SubtitleCue[] = [];
let videoElement: HTMLVideoElement | null = null;
let scheduler: SubtitleScheduler | null = null;
let targetLanguage = '';
let activeBackendKind: 'openai' | 'mt' = 'openai';
let lastTranslateError = '';
let paused = false;
let hrefPollTimer: number | undefined;

const renderer = new SubtitleRenderer();
let cacheTable: TranslationCache = {};
let pendingCachePairs: CachePair[] = [];
let cacheFlushTimer: number | undefined;
let requestSeq = 0;

const delay = (ms: number): Promise<void> => new Promise((resolve) => { window.setTimeout(resolve, ms); });

const nextRequestId = (): string => `${X_BRIDGE_SOURCE}-${++requestSeq}`;

const getStatusId = (): string => /\/status\/(\d+)/.exec(window.location.pathname)?.[1] ?? '';

/** 目标语言是否为中文系：决定「同语言无需翻译」判断与缓存语言键。 */
const looksLikeChinese = (language: string): boolean =>
  /^(zh|chi)/i.test(language) || /中文|汉语|华语|chinese/i.test(language);

// ── 缓存 ──

const flushCachePairs = async (): Promise<void> => {
  window.clearTimeout(cacheFlushTimer);
  cacheFlushTimer = undefined;
  if (pendingCachePairs.length === 0) return;
  const pairs = pendingCachePairs;
  pendingCachePairs = [];
  try {
    await saveTranslationCache(cacheTable, pairs);
  } catch {
    // 缓存失败静默降级，不影响字幕显示
  }
};

const queueCachePair = (text: string, translation: string): void => {
  pendingCachePairs.push({ language: targetLanguage, text, translation });
  if (cacheFlushTimer === undefined) {
    cacheFlushTimer = window.setTimeout(() => void flushCachePairs(), CACHE_FLUSH_DEBOUNCE_MS);
  }
};

const cachedTranslation = (text: string): string | undefined => {
  const entry = cacheTable[cacheKey(targetLanguage, text)];
  return typeof entry?.t === 'string' ? entry.t : undefined;
};

const setStatusIfActive = (message: string): void => {
  if (!paused) renderer.setStatus(message);
};

// ── 引擎 ──

/** 取某单元的前一单元原文：批量翻译附带上文，改善跨句代词与衔接。 */
const findPreviousSubtitleOriginal = (currentText: string): string => {
  if (!currentText) return '';
  const index = subtitleUnits.findIndex((unit) => unit.text === currentText);
  return index > 0 ? subtitleUnits[index - 1].text : '';
};

const createScheduler = (pageContext: string): SubtitleScheduler =>
  createSubtitleScheduler({
    getBackendKind: () => activeBackendKind,
    getPageContext: (texts: string[]) => {
      const previous = findPreviousSubtitleOriginal(texts[0] ?? '');
      return [pageContext, previous ? `Previous subtitle: ${previous}` : '']
        .filter(Boolean)
        .join('\n');
    },
    onNewTranslation: queueCachePair,
    onTranslateError: (message) => {
      lastTranslateError = message;
    },
    onChannelInvalidated: () => {
      renderer.setStatus('插件刚更新过，请刷新页面（F5）后再使用字幕翻译。');
    },
  });

// ── 面板控制回调（与 YouTube 版同机制：写回配置存储热更） ──

const handleTogglePause = (): void => {
  paused = !paused;
  try {
    window.sessionStorage.setItem(PAUSE_STORAGE_KEY, paused ? '1' : '0');
  } catch {
    // 存储不可用仅影响刷新记忆，不影响本次会话
  }
  renderer.setPausedVisual(paused);
  if (paused) {
    scheduler?.reset();
    renderer.show(null, null);
    renderer.setStatus(null);
  } else {
    lastTranslateError = '';
    void syncNow();
  }
};

const handleSetMode = (mode: SubtitleConfig['displayMode']): void => {
  void (async () => {
    const current = await getSubtitleConfig();
    await saveSubtitleConfig({ ...current, displayMode: mode });
  })();
};

const handleFontSizeDelta = (delta: number): void => {
  void (async () => {
    const current = await getSubtitleConfig();
    await saveSubtitleConfig({ ...current, fontSize: clampStepFontSize(current.fontSize, delta) });
  })();
};

// ── 播放器定位与同步 ──

const PLAYER_SELECTOR = '[data-testid="videoPlayer"]';

/**
 * 定位播放器容器：优先 X 原生 videoPlayer；testid 失效（X 改版常见）时退化为
 * 「找有内容的 <video> → 取其最近的可定位祖先」。保证 testid 变动后会话仍能启动。
 */
const findPlayerContainer = (): HTMLElement | null => {
  const byTestid = Array.from(document.querySelectorAll<HTMLElement>(PLAYER_SELECTOR))
    .find((container) => container.querySelector('video'));
  if (byTestid) return byTestid;
  // 选择器退化：扫描所有 <video>，跳过未加载的占位视频
  const videos = Array.from(document.querySelectorAll<HTMLVideoElement>('video'));
  for (const video of videos) {
    const hasSource = Boolean(video.src) || Boolean(video.querySelector('source[src]'));
    if (video.readyState < 2 && !hasSource) continue;
    // 沿祖先链找最近的可定位元素作为挂载容器（overlay 的 inset:0 依赖定位锚点）
    let node: HTMLElement | null = video.parentElement;
    while (node) {
      const pos = getComputedStyle(node).position;
      if (pos === 'absolute' || pos === 'relative' || pos === 'fixed' || pos === 'sticky') return node;
      node = node.parentElement;
    }
    return video.parentElement;
  }
  return null;
};

const waitForPlayerContainer = async (token: number): Promise<HTMLElement | null> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (token !== sessionToken) return null;
    const container = findPlayerContainer();
    if (container) return container;
    await delay(250);
  }
  return null;
};

const syncNow = async (): Promise<void> => {
  if (paused) {
    renderer.show(null, null);
    return;
  }
  const video = videoElement;
  if (!video || !scheduler) return;
  const timeMs = video.currentTime * 1000;
  // 间隙保持：单元间 ≤800ms 的空隙沿用上一条，消除闪烁
  const unit = findCueAtWithHold(subtitleUnits, timeMs);
  renderer.show(unit?.text ?? null, unit ? scheduler.lookup(unit.text) ?? null : null);
  await scheduler.tick(subtitleUnits, timeMs, video.playbackRate);
  // 批量翻译刚完成，若仍停留在同一单元上则补显译文
  const latest = findCueAtWithHold(subtitleUnits, video.currentTime * 1000);
  if (latest) renderer.show(latest.text, scheduler.lookup(latest.text) ?? null);

  const stats = scheduler.getStats();
  if (stats.translatedCount === 0 && stats.failedCount >= 6) {
    renderer.setStatus(
      `字幕翻译多次失败：请检查「翻译服务」是否配置可用。${lastTranslateError ? `最近错误：${lastTranslateError.slice(0, 120)}` : ''}`,
    );
  }
};

const detachVideoListeners = (): void => {
  if (!videoElement) return;
  videoElement.removeEventListener('timeupdate', handleVideoSync);
  videoElement.removeEventListener('seeked', handleVideoSync);
  videoElement.removeEventListener('play', handleVideoSync);
  videoElement.removeEventListener('pause', handleVideoSync);
  videoElement = null;
};

function handleVideoSync(): void {
  void syncNow();
}

// ── 字幕获取：桥接收割清单 → 选轨 → 拉 VTT 分段 ──

interface ManifestListResponse extends Record<string, unknown> {
  type: 'manifest-list';
  requestId: string;
  manifests: HarvestedManifest[];
}

const requestManifests = async (): Promise<HarvestedManifest[]> => {
  const response = await requestViaBridge<ManifestListResponse>({
    request: { source: X_BRIDGE_SOURCE, type: 'get-latest-manifests', requestId: nextRequestId() },
    responseType: 'manifest-list',
    timeoutMs: MANIFEST_REQUEST_TIMEOUT_MS,
    isResponseData: (data): data is ManifestListResponse =>
      typeof data === 'object'
      && data !== null
      && (data as { type?: unknown }).type === 'manifest-list',
  });
  return response?.manifests ?? [];
};

/**
 * 从一条收割的清单中提取字幕轨道候选：
 * - 主清单 → 解析 EXT-X-MEDIA SUBTITLES 轨道（主清单本体不含 .vtt 字样）；
 * - 已是字幕分段清单（用户开过 CC，播放器自己拉过子清单）→ 直接当作唯一轨道。
 */
const collectRenditionsFromManifest = (capture: HarvestedManifest): HlsSubtitleRendition[] => {
  const renditions = parseHlsSubtitleRenditions(capture.body, capture.url);
  if (renditions.length > 0) return renditions;
  if (!looksLikeVttSegmentList(capture.body)) return [];
  return [{ url: capture.url, languageCode: '', name: undefined }];
};

/** 并发（限流）拉取全部分段文本；任一失败即整体失败，保证 cue 完整性。 */
const fetchSegmentTexts = async (urls: string[]): Promise<string[]> => {
  const results: string[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(SEGMENT_CONCURRENCY, urls.length) }, async () => {
    while (cursor < urls.length) {
      const index = cursor;
      cursor += 1;
      const response = await fetch(urls[index], { credentials: 'omit' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      results[index] = await response.text();
    }
  });
  await Promise.all(workers);
  return results;
};

const fetchCuesFromPlaylist = async (playlistUrl: string): Promise<SubtitleCue[]> => {
  const response = await fetch(playlistUrl, { credentials: 'omit' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const playlistText = await response.text();
  if (hasActiveEncryption(playlistText)) {
    throw new Error('字幕分声明了加密，暂不支持。');
  }
  const segmentUrls = extractVttSegmentUrls(playlistText, playlistUrl);
  if (segmentUrls.length === 0) throw new Error('字幕分段清单为空。');

  const bodies = await fetchSegmentTexts(segmentUrls);
  const rawCues = bodies.flatMap((body) => parseWebVtt(body));
  const cues = mergeVttCues(rawCues);
  if (cues.length === 0) throw new Error('字幕内容为空。');
  return cues;
};

/**
 * 在等待窗口内轮询桥接收割记录并尝试构建 cue 列表。
 * 视频起播通常先于会话启动，主清单往往已在归档中；首帧前才起播的场景靠轮询兜住。
 * 播放器被关闭/切走时立即放弃。
 */
const loadCuesWithWait = async (token: number): Promise<{ cues: SubtitleCue[]; rendition: HlsSubtitleRendition } | { failure: string }> => {
  const deadline = Date.now() + MANIFEST_WAIT_WINDOW_MS;
  let lastReason = '未捕获到视频清单。';
  let captureCount = 0;
  let renditionCount = 0;
  while (Date.now() < deadline && findPlayerContainer()) {
    if (token !== sessionToken) return { failure: '会话已切换。' };
    let captures: HarvestedManifest[] = [];
    try {
      captures = await requestManifests();
    } catch {
      captures = [];
    }
    captureCount = Math.max(captureCount, captures.length);

    for (const capture of captures) {
      const renditions = collectRenditionsFromManifest(capture);
      if (renditions.length === 0) continue;
      renditionCount += renditions.length;
      const rendition = selectRendition(renditions, (code) => looksLikeChinese(targetLanguage) && code.toLowerCase().startsWith('zh'));
      if (!rendition) {
        logger.info('x.subtitle_no_foreign_track', {
          languages: renditions.map((item) => item.languageCode).join(','),
          playlistUrl: capture.url.slice(0, 120),
        });
        return { failure: '__NO_FOREIGN_TRACK__' };
      }
      logger.info('x.subtitle_rendition.selected', {
        playlistUrl: capture.url.slice(0, 120),
        languageCode: rendition.languageCode,
        name: rendition.name ?? '',
        candidates: renditions.length,
      });
      try {
        const cues = await fetchCuesFromPlaylist(rendition.url);
        return { cues, rendition };
      } catch (error) {
        lastReason = error instanceof Error ? error.message : String(error);
        logger.info('x.subtitle_fetch.retry', { reason: lastReason });
      }
    }
    await delay(MANIFEST_POLL_INTERVAL_MS);
  }
  if (captureCount === 0) {
    // 三类故障分开表述：定位时才能区分「桥接失效」与「站点无字幕轨」
    return { failure: '未捕获到视频清单（扩展更新后请先刷新页面）' };
  }
  if (renditionCount === 0) {
    return { failure: `已捕获 ${captureCount} 个视频清单，均未声明字幕轨道（该视频可能无原生字幕）` };
  }
  return { failure: lastReason };
};

// ── 会话生命周期 ──

const teardownSession = (): void => {
  sessionToken += 1;
  sessionKey = '';
  attemptedKey = '';
  lastTranslateError = '';
  detachVideoListeners();
  scheduler?.reset();
  scheduler = null;
  subtitleUnits = [];
  renderer.setStatus(null);
  renderer.show(null, null);
  void flushCachePairs();
};

/**
 * desiredKey：详情页为 status id；时间线等内嵌场景无稳定 id，用占位键。
 * 占位键保证「时间线上点开视频」同样能触发会话——这是此前版本
 * 只认 /status/<id> 变化导致的启动死区（首次探测放弃后永不重试）。
 */
const startSession = async (desiredKey: string): Promise<void> => {
  // evaluateNavigation 已做启用判断，这里只防轮询竞态下配置未就绪
  if (!config) {
    attemptedKey = '';
    return;
  }
  attemptedKey = desiredKey;
  const token = ++sessionToken;
  const container = await waitForPlayerContainer(token);
  if (token !== sessionToken || !container) {
    // 视频尚未渲染（慢加载）：清空目标键让轮询稍后重试；会话已切换则交给导航逻辑
    if (token === sessionToken && !container) attemptedKey = '';
    return;
  }

  // 会话键：详情页用 status id；时间线等无 id 场景延后到拿到清单时再补
  sessionKey = desiredKey === 'adhoc' ? '' : desiredKey;

  renderer.mount(container);
  renderer.applyConfig(config);
  renderer.bindControlCallbacks({
    onTogglePause: handleTogglePause,
    onSetMode: handleSetMode,
    onFontSizeDelta: handleFontSizeDelta,
  });
  renderer.setPanelState(config.displayMode, config.fontSize, paused);
  setStatusIfActive('正在获取字幕…');
  // 诊断：覆层已挂载到播放器，浮窗开关应已出现；若不可见多为层叠/覆盖问题
  logger.info('x.subtitle.mounted', { desiredKey, hasVideo: Boolean(container.querySelector('video')) });

  try {
    const mainConfig = await getConfig();
    targetLanguage = mainConfig.targetLanguage;
    activeBackendKind = getProviderMeta(mainConfig.providerId).kind === 'mt' ? 'mt' : 'openai';
  } catch {
    targetLanguage = '简体中文';
  }

  const result = await loadCuesWithWait(token);
  if (token !== sessionToken) return;

  if ('failure' in result) {
    if (result.failure === '__NO_FOREIGN_TRACK__') {
      setStatusIfActive('该视频字幕与目标语言相同，无需翻译。');
    } else {
      setStatusIfActive(`未找到可用的原生字幕（${result.failure}）。仅支持带字幕的推文视频。`);
      logger.info('x.subtitle_no_captions', { reason: result.failure, sessionKey });
    }
    return;
  }

  // 会话键兜底：无 status id 时用字幕清单路径派生稳定键
  if (!sessionKey) {
    sessionKey = result.rendition.url.split('?')[0].split('/').slice(-2).join('/');
  }

  const unitCacheKey = buildUnitCacheKey(sessionKey, result.rendition.languageCode, undefined, UNIT_CACHE_PREFIX_X);
  const cachedUnits = readCachedUnits(window.sessionStorage, unitCacheKey, Date.now());
  let units: SubtitleCue[];
  let unitSource: 'cache' | 'network' = 'cache';
  if (cachedUnits) {
    units = cachedUnits;
  } else {
    unitSource = 'network';
    units = buildSubtitleUnits(result.cues, result.rendition.languageCode);
    writeCachedUnits(window.sessionStorage, unitCacheKey, units, Date.now());
  }
  subtitleUnits = units;

  const videoTitle = document.title.replace(/\s*[|·]\s*(X|Twitter)\s*$/i, '').trim();
  scheduler = createScheduler(videoTitle && videoTitle !== 'X' ? `Video title: ${videoTitle}` : '');
  scheduler.seedFromCache(subtitleUnits, cachedTranslation);

  const video = container.querySelector<HTMLVideoElement>('video')
    ?? document.querySelector<HTMLVideoElement>('video');
  if (!video) {
    setStatusIfActive('未找到视频元素。');
    return;
  }
  videoElement = video;
  video.addEventListener('timeupdate', handleVideoSync);
  video.addEventListener('seeked', handleVideoSync);
  video.addEventListener('play', handleVideoSync);
  // 暂停时 timeupdate 不再触发，显式补一次同步
  video.addEventListener('pause', handleVideoSync);

  renderer.setStatus(null);
  if (paused) return;
  logger.info('x.subtitle_session.start', {
    sessionKey,
    languageCode: result.rendition.languageCode,
    unitSource,
    unitCount: subtitleUnits.length,
  });
  void syncNow();

  // AI 断句异步精修：规则断句先保证秒出，AI 结果就绪后整体替换并重翻受影响批次。
  // 仅网络路径触发（缓存命中即此前已优化过）；失败静默保留规则结果。
  if (config?.aiSegmentation !== false && activeBackendKind === 'openai' && unitSource === 'network') {
    const { languageCode } = result.rendition;
    void (async () => {
      try {
        setStatusIfActive('正在用 AI 优化断句…');
        const refined = await refineCuesWithAi(result.cues, languageCode);
        if (token !== sessionToken) return;
        subtitleUnits = refined;
        writeCachedUnits(window.sessionStorage, unitCacheKey, refined, Date.now());
        scheduler?.reset();
        renderer.setStatus(null);
        logger.info('x.subtitle_ai_segmentation.applied', { unitCount: refined.length });
        void syncNow();
      } catch (error) {
        if (token !== sessionToken) return;
        logger.info('x.subtitle_ai_segmentation.fallback_rules', { error });
        if (!paused) renderer.setStatus(null);
      }
    })();
  }
};

/**
 * 路由/播放器状态评估（每 600ms 轮询）：
 * - 无播放器 → 清理残留会话；
 * - 功能未启用 → 仅清理，不登记目标键（启用瞬间即可自然启动）；
 * - 有播放器且目标键变化（含时间线占位键）→ 重开会话。
 */
const evaluateNavigation = (): void => {
  const hasPlayer = Boolean(findPlayerContainer());
  if (!hasPlayer) {
    if (renderer.isMounted || scheduler || attemptedKey) {
      teardownSession();
      renderer.unmount();
    }
    return;
  }
  if (!config?.enabled || config.xEnabled === false) {
    if (renderer.isMounted || scheduler) {
      teardownSession();
      renderer.unmount();
    }
    // 诊断：字幕功能未启用时记录原因，便于用户在控制台定位「为何 X 视频无开关」
    logger.info('x.subtitle.disabled', { enabled: config?.enabled, xEnabled: config?.xEnabled });
    return;
  }
  const desiredKey = getStatusId() || 'adhoc';
  if (desiredKey === attemptedKey) {
    // 同一目标下，宿主可能被站点（X）React 重渲染摘除：检测断连后重挂，避免字幕层/开关永久消失
    if (renderer.isMounted && !renderer.hostConnected) {
      teardownSession();
      renderer.unmount();
      void startSession(desiredKey);
    }
    return;
  }
  teardownSession();
  renderer.unmount();
  void startSession(desiredKey);
};

export default defineContentScript({
  matches: ['*://*.x.com/*', '*://*.twitter.com/*'],
  runAt: 'document_idle',
  main() {
    // SPA 导航轮询：X 的路由跳转不产生内容脚本可感知的事件
    hrefPollTimer = window.setInterval(evaluateNavigation, HREF_POLL_INTERVAL_MS);

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes[SUBTITLE_CONFIG_STORAGE_KEY]) return;
      void (async () => {
        const wasMounted = renderer.isMounted;
        config = await getSubtitleConfig();
        evaluateNavigation();
        // 启停由 evaluateNavigation 决策；仍在会话中且未发生启停切换时仅热更样式
        if (wasMounted && renderer.isMounted) {
          renderer.applyConfig(config);
          renderer.setPanelState(config.displayMode, config.fontSize, paused);
        }
      })();
    });

    try {
      paused = window.sessionStorage.getItem(PAUSE_STORAGE_KEY) === '1';
    } catch {
      paused = false;
    }

    void (async () => {
      config = await getSubtitleConfig();
      cacheTable = await loadTranslationCache();
      evaluateNavigation();
    })();

    window.addEventListener('pagehide', () => {
      if (hrefPollTimer !== undefined) window.clearInterval(hrefPollTimer);
      teardownSession();
      renderer.unmount();
    }, { once: true });
  },
});
