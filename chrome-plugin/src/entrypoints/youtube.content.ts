/**
 * YouTube 字幕翻译编排脚本（隔离世界）：
 * 桥接脚本拿轨道与令牌 → 选轨并拉取 json3 → 调度器批量翻译（复用后台翻译通道）
 * → Shadow DOM 覆盖层随播放进度渲染。
 *
 * 本入口只匹配 youtube.com 且不修改任何被油猴脚本引用的共享模块；
 * 配置存于独立存储键（subtitleConfig），经 storage.onChanged 热更新。
 */

import {
  BRIDGE_SOURCE,
  isBridgeResponse,
  requestFromBridge,
  type BridgeResponse,
  type CaptionTrackInfo,
  type PlayerDataPayload,
} from '../utils/subtitles/protocol';
import {
  SUBTITLE_CONFIG_STORAGE_KEY,
  getSubtitleConfig,
  saveSubtitleConfig,
  type SubtitleConfig,
  type SubtitleDisplayMode,
} from '../utils/subtitles/config';
import {
  extractPotFromUrl,
  fetchJson3Cues,
  fetchPageFallbackCaptionData,
  findCueAtWithHold,
  selectTrack,
  type SubtitleCue,
} from '../utils/subtitles/trackLoader';
import { SubtitleScheduler } from '../utils/subtitles/scheduler';
import { SubtitleRenderer, clampStepFontSize } from '../utils/subtitles/renderer';
import { buildSubtitleUnits } from '../utils/subtitles/segmenter';
import { buildUnitCacheKey, readCachedUnits, writeCachedUnits } from '../utils/subtitles/unitCache';
import { createSubtitleScheduler } from '../utils/subtitles/engineAdapter';
import { refineCuesWithAi } from '../utils/subtitles/ai-segmenter';
import { getConfig } from '../utils/config';
import { logger } from '../utils/logger';
import { getProviderMeta } from '../utils/providers';
import {
  cacheKey,
  loadTranslationCache,
  saveTranslationCache,
  type TranslationCache,
} from './content/translationCache';

const PLAYER_DATA_TIMEOUT_MS = 6_000;
/** SPA 切换视频后等待路由与播放器稳定的兜底延迟。 */
const NAVIGATION_DELAY_MS = 900;
/** 强开字幕触发 timedtext 后等待收割的时长。 */
const POT_WAIT_AFTER_TOGGLE_MS = 3_000;
/** 新增译文写持久缓存的防抖窗口。 */
const CACHE_FLUSH_DEBOUNCE_MS = 3_000;
/** 会话级暂停的标签页内记忆键（sessionStorage：刷新保留、关页即清）。 */
const PAUSE_STORAGE_KEY = 'moyi-yt-subtitle-paused';

type CachePair = { language: string; text: string; translation: string };

let config: SubtitleConfig | null = null;
let sessionToken = 0;
/** 当前会话正在处理的视频（同步登记，供导航守卫识别同视频重复导航）。 */
let sessionVideoId = '';
/** 断句重组后的展示/调度单元（非原始碎片）。 */
let subtitleUnits: SubtitleCue[] = [];
let videoElement: HTMLVideoElement | null = null;
let scheduler: SubtitleScheduler | null = null;
let targetLanguage = '';
/** 当前激活服务商的后端种类：决定字幕翻译走流式端口还是 DeepL 批量。 */
let activeBackendKind: 'openai' | 'mt' = 'openai';
/** 最近一次翻译通道错误（用于浮层升级提示，免翻控制台）。 */
let lastTranslateError = '';
/** 会话级暂停：logo 电源键切换，独立于设置页总开关（总门）。 */
let paused = false;

const renderer = new SubtitleRenderer();
/** 桥接脚本广播的含 pot 的 timedtext 地址，按 videoId 归档。 */
const harvestedPotUrls = new Map<string, string[]>();
let cacheTable: TranslationCache = {};
let pendingCachePairs: CachePair[] = [];
let cacheFlushTimer: number | undefined;
let requestSeq = 0;

const delay = (ms: number): Promise<void> => new Promise((resolve) => { window.setTimeout(resolve, ms); });

const nextRequestId = (): string => `${BRIDGE_SOURCE}-${++requestSeq}`;

const getVideoId = (): string =>
  new URLSearchParams(window.location.search).get('v')
  ?? (/^\/live\/([A-Za-z0-9_-]{6,})/.exec(window.location.pathname)?.[1] ?? '');

const isWatchPage = (): boolean =>
  window.location.pathname === '/watch' || /^\/live\//.test(window.location.pathname);

/** 目标语言是否为中文系：决定「同语言无需翻译」判断与缓存语言键。 */
const looksLikeChinese = (language: string): boolean =>
  /^(zh|chi)/i.test(language) || /中文|汉语|华语|chinese/i.test(language);

const requestPlayerData = async (
  timeoutMs: number,
): Promise<Extract<BridgeResponse, { type: 'player-data' }> | null> =>
  requestFromBridge<Extract<BridgeResponse, { type: 'player-data' }>>(
    { source: BRIDGE_SOURCE, type: 'get-player-data', requestId: nextRequestId() },
    'player-data',
    timeoutMs,
  );

const requestToggleSubtitles = async (): Promise<boolean> => {
  const response = await requestFromBridge<Extract<BridgeResponse, { type: 'subtitles-toggled' }>>(
    { source: BRIDGE_SOURCE, type: 'toggle-subtitles', requestId: nextRequestId() },
    'subtitles-toggled',
    2_000,
  );
  return response !== null;
};

/** 收集当前可用的 pot 候选：音轨地址自带令牌 + 桥接收割的地址。 */
const collectPotCandidates = (payload: PlayerDataPayload, videoId: string): string[] => {
  const urls: string[] = [];
  for (const track of payload.audioTracks) {
    if (track.baseUrl.includes('/api/timedtext')) urls.push(track.baseUrl);
  }
  for (const url of harvestedPotUrls.get(videoId) ?? []) urls.push(url);
  return [...new Set(urls)];
};

const EMPTY_PLAYER_DATA: PlayerDataPayload = {
  videoId: '',
  tracks: [],
  audioTracks: [],
  device: null,
  cver: null,
};

/**
 * 获取播放器数据：优先走 MAIN 世界桥接（能拿到音轨/指纹/令牌）；
 * 桥接不可用时退化为重新拉取页面 HTML 提取 captionTracks（无指纹无令牌，直连成功率较低但仍值得一试）。
 */
const obtainPlayerData = async (videoId: string): Promise<{ payload: PlayerDataPayload; bridgeAlive: boolean }> => {
  const response = await requestPlayerData(PLAYER_DATA_TIMEOUT_MS);
  const payload = response?.payload ?? null;
  if (payload) {
    logger.info('youtube.subtitle_player_data.bridge', {
      videoId,
      tracks: payload.tracks.length,
      audioTracks: payload.audioTracks.length,
    });
    return { payload, bridgeAlive: true };
  }

  // 桥接不可用（未注入/播放器未就绪）：降级为重新拉取页面 HTML 提取轨道与音轨令牌。
  // 音轨地址（audioTracks）通常自带 pot/potc，是降级路径下唯一的令牌来源，必须一并提取。
  logger.info('youtube.subtitle_bridge.unavailable', { videoId });
  try {
    const fallback = await fetchPageFallbackCaptionData();
    if (fallback.tracks.length > 0) {
      return {
        payload: {
          ...EMPTY_PLAYER_DATA,
          videoId,
          tracks: fallback.tracks,
          audioTracks: fallback.audioTrackUrls.map((baseUrl) => ({ baseUrl, languageCode: '' })),
        },
        bridgeAlive: false,
      };
    }
  } catch (error) {
    logger.info('youtube.subtitle_html_fallback.failure', { error });
  }
  return { payload: { ...EMPTY_PLAYER_DATA, videoId }, bridgeAlive: false };
};

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

// ── 会话生命周期 ──

/** 暂停期间不向浮层写任何进度/错误状态，保持「休眠」观感。 */
const setStatusIfActive = (message: string): void => {
  if (!paused) renderer.setStatus(message);
};

/** 播放器 logo 电源键：切换会话级暂停（不触碰设置页总开关）。 */
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

const handleSetMode = (mode: SubtitleDisplayMode): void => {
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

const waitForPlayerContainer = async (token: number): Promise<HTMLElement | null> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (token !== sessionToken) return null;
    const container = document.querySelector<HTMLElement>('#movie_player.html5-video-player')
      ?? document.querySelector<HTMLElement>('.html5-video-player');
    const video = document.querySelector<HTMLVideoElement>('video');
    if (container && video) return container;
    await delay(250);
  }
  return null;
};

/** 单次同步：渲染当前单元并驱动调度器补翻前方窗口。 */
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
  if (unit) {
    renderer.show(unit.text, scheduler.lookup(unit.text) ?? null);
  } else {
    renderer.show(null, null);
  }
  await scheduler.tick(subtitleUnits, timeMs, video.playbackRate);
  // 批量翻译刚完成，若仍停留在同一单元上则补显译文
  const latest = findCueAtWithHold(subtitleUnits, video.currentTime * 1000);
  if (latest) renderer.show(latest.text, scheduler.lookup(latest.text) ?? null);

  // 升级提示：整个会话至今零译文且多次失败，多半是服务商配置或网络问题；
  // 附带最近一次通道错误，免去翻控制台定位
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

const teardownSession = (): void => {
  sessionToken += 1;
  sessionVideoId = '';
  lastTranslateError = '';
  detachVideoListeners();
  scheduler?.reset();
  scheduler = null;
  subtitleUnits = [];
  renderer.setStatus(null);
  renderer.show(null, null);
  void flushCachePairs();
};

/** 拉取字幕正文：先带现有候选尝试，失败且桥接可用时强开字幕收割令牌再试一轮。 */
const loadCues = async (
  track: CaptionTrackInfo,
  payload: PlayerDataPayload,
  videoId: string,
  bridgeAlive: boolean,
  token: number,
): Promise<SubtitleCue[]> => {
  const baseOptions = { device: payload.device, cver: payload.cver };
  try {
    return await fetchJson3Cues(track, { ...baseOptions, potCandidates: collectPotCandidates(payload, videoId) });
  } catch (firstError) {
    if (token !== sessionToken) throw firstError;
    if (!bridgeAlive) throw firstError;
    logger.info('youtube.subtitle_fetch.retry_with_pot', { error: firstError });

    await requestToggleSubtitles();
    await delay(POT_WAIT_AFTER_TOGGLE_MS);
    if (token !== sessionToken) throw firstError;

    const retryResponse = await requestPlayerData(PLAYER_DATA_TIMEOUT_MS);
    const retryPayload = retryResponse?.payload;
    if (!retryPayload || token !== sessionToken) throw firstError;
    return fetchJson3Cues(track, {
      ...baseOptions,
      device: retryPayload.device ?? baseOptions.device,
      cver: retryPayload.cver ?? baseOptions.cver,
      potCandidates: collectPotCandidates(retryPayload, videoId),
    });
  }
};

const startSession = async (): Promise<void> => {
  if (!config?.enabled || !isWatchPage()) return;
  const videoId = getVideoId();
  if (!videoId) return;
  // 必须在任何 await 之前同步登记，导航守卫才能识别并发中的同视频会话
  sessionVideoId = videoId;
  const token = ++sessionToken;

  try {
    const mainConfig = await getConfig();
    if (token !== sessionToken) return;
    targetLanguage = mainConfig.targetLanguage;
    activeBackendKind = getProviderMeta(mainConfig.providerId).kind === 'mt' ? 'mt' : 'openai';
  } catch {
    targetLanguage = '简体中文';
  }

  const container = await waitForPlayerContainer(token);
  if (token !== sessionToken || !container) return;

  renderer.mount(container);
  renderer.applyConfig(config);
  renderer.bindControlCallbacks({
    onTogglePause: handleTogglePause,
    onSetMode: handleSetMode,
    onFontSizeDelta: handleFontSizeDelta,
  });
  renderer.setPanelState(config.displayMode, config.fontSize, paused);
  setStatusIfActive('正在获取字幕…');

  const { payload, bridgeAlive } = await obtainPlayerData(videoId);
  if (token !== sessionToken) return;

  const track = selectTrack(payload.tracks, (code) => looksLikeChinese(targetLanguage) && code.toLowerCase().startsWith('zh'));
  if (!track) {
    setStatusIfActive(
      payload.tracks.length > 0
        ? '该视频字幕与目标语言相同，无需翻译。'
        : '未找到可用字幕轨道。',
    );
    logger.info('youtube.subtitle_no_track', { videoId, trackCount: payload.tracks.length });
    return;
  }

  setStatusIfActive('正在拉取字幕数据…');
  // 跨刷新复用：同标签页内反复打开同一视频时直接命中 sessionStorage，完全不触网，
  // 从源头避开「高频刷新 → 边缘风控 → 字幕获取失败」的负反馈
  const unitCacheKey = buildUnitCacheKey(videoId, track.languageCode, track.kind);
  const cachedUnits = readCachedUnits(window.sessionStorage, unitCacheKey, Date.now());
  let units: SubtitleCue[];
  let unitSource: 'cache' | 'network' = 'cache';
  let rawCues: SubtitleCue[] | null = null;
  if (cachedUnits) {
    units = cachedUnits;
  } else {
    unitSource = 'network';
    let loadedCues: SubtitleCue[];
    try {
      loadedCues = await loadCues(track, payload, videoId, bridgeAlive, token);
    } catch (error) {
      if (token !== sessionToken) return;
      const message = error instanceof Error ? error.message : String(error);
      lastTranslateError = message;
      setStatusIfActive(
        `字幕获取失败：${message}${bridgeAlive ? '' : '。注：桥接脚本未注入，本次走降级通道'}`,
      );
      logger.error('youtube.subtitle_fetch.failure', { error, bridgeAlive });
      return;
    }
    if (token !== sessionToken) return;
    rawCues = loadedCues;
    // 断句重组：碎片 → 完整子句/句子单元，翻译与展示都以单元为单位，
    // 从源头消除「中文半句被标点截开后跳变」；结果落盘供下次刷新复用
    units = buildSubtitleUnits(loadedCues, track.languageCode);
    writeCachedUnits(window.sessionStorage, unitCacheKey, units, Date.now());
  }
  if (token !== sessionToken) return;

  subtitleUnits = units;
  const videoTitle = document.title.replace(/\s*[-|]\s*YouTube\s*$/i, '').trim();
  scheduler = createScheduler(videoTitle ? `Video title: ${videoTitle}` : '');
  scheduler.seedFromCache(subtitleUnits, cachedTranslation);

  const video = document.querySelector<HTMLVideoElement>('video');
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
  if (paused) {
    // 暂停态下单元已就绪（缓存命中时近乎即时），恢复播放交给面板电源键
    return;
  }
  logger.info('youtube.subtitle_session.start', {
    videoId,
    languageCode: track.languageCode,
    kind: track.kind ?? 'manual',
    unitSource,
    unitCount: subtitleUnits.length,
  });
  void syncNow();

  // AI 断句异步精修：规则断句先保证秒出，AI 结果就绪后整体替换并重翻受影响批次。
  // 仅网络路径触发（缓存命中即此前已优化过）；失败静默保留规则结果。
  if (config.aiSegmentation !== false && activeBackendKind === 'openai' && unitSource === 'network' && rawCues) {
    void (async () => {
      try {
        setStatusIfActive('正在用 AI 优化断句…');
        const refined = await refineCuesWithAi(rawCues, track.languageCode);
        if (token !== sessionToken) return;
        subtitleUnits = refined;
        writeCachedUnits(window.sessionStorage, unitCacheKey, refined, Date.now());
        scheduler?.reset();
        renderer.setStatus(null);
        logger.info('youtube.subtitle_ai_segmentation.applied', { unitCount: refined.length });
        void syncNow();
      } catch (error) {
        if (token !== sessionToken) return;
        logger.info('youtube.subtitle_ai_segmentation.fallback_rules', { error });
        if (!paused) renderer.setStatus(null);
      }
    })();
  }
};

// ── 全局监听 ──

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_idle',
  main() {
    // 持续接收桥接广播的 pot 地址（会话开始前捕获的同样有效）
    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data: unknown = event.data;
      if (!isBridgeResponse(data) || data.type !== 'pot-url') return;
      const list = harvestedPotUrls.get(data.videoId) ?? [];
      list.push(data.url);
      harvestedPotUrls.set(data.videoId, list.slice(-6));
      // 只保留最近几个视频的收割记录，防止长会话内存膨胀
      if (harvestedPotUrls.size > 8) {
        const oldest = harvestedPotUrls.keys().next().value;
        if (oldest !== undefined) harvestedPotUrls.delete(oldest);
      }
    });

    // SPA 导航：YouTube 不刷新页面，必须按新 videoId 重开会话。
    // 注意 yt-navigate-finish 在首次加载时也会派发一次：同视频重复导航若不拦截，
    // 会把进行中的会话打断重来——每次刷新请求翻倍，反复刷新极易触发风控。
    window.addEventListener('yt-navigate-finish', () => {
      window.setTimeout(() => {
        const nextVideoId = getVideoId();
        if (nextVideoId && nextVideoId === sessionVideoId) return;
        teardownSession();
        renderer.unmount();
        void startSession();
      }, NAVIGATION_DELAY_MS);
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes[SUBTITLE_CONFIG_STORAGE_KEY]) return;
      void (async () => {
        const previousEnabled = config?.enabled ?? false;
        config = await getSubtitleConfig();
        if (!renderer.isMounted) {
          if (config.enabled) void startSession();
          return;
        }
        if (config.enabled !== previousEnabled) {
          if (config.enabled) {
            void startSession();
          } else {
            teardownSession();
            renderer.unmount();
          }
          return;
        }
        renderer.applyConfig(config);
        renderer.setPanelState(config.displayMode, config.fontSize, paused);
      })();
    });

    // 恢复会话级暂停记忆（sessionStorage：同标签页刷新保留、关页即清）
    try {
      paused = window.sessionStorage.getItem(PAUSE_STORAGE_KEY) === '1';
    } catch {
      paused = false;
    }

    void (async () => {
      config = await getSubtitleConfig();
      cacheTable = await loadTranslationCache();
      if (config.enabled) void startSession();
    })();

    window.addEventListener('pagehide', () => {
      teardownSession();
      renderer.unmount();
    }, { once: true });
  },
});
