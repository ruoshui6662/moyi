/**
 * 划词查词 content entrypoint（插件独有载体，红线 3）。
 *
 * 为什么独立成文件：油猴 entry.ts 只 import `content/main`，WXT 对 `*.content.ts`
 * 自动生成 manifest 内容脚本——本文件的代码不进油猴产物，功能天然只在扩展端存在。
 *
 * 触发模型（v1 只做划词，悬停为后续切片）：
 * - 用户 `pointerup`（可信事件）后取选区 → 规则判定 → 立即弹卡（「翻译中…」）→ 异步填充；
 * - 输入框/可编辑区内的划词不触发（写作 ≠ 阅读）；扩展自有浮层内不触发（防自循环）；
 * - 同一查询重选不重复请求；换词即换请求（结果覆盖，无并发竞态：请求序号守卫）。
 */

import { getConfig } from '../utils/config';
import { requestEdgeSpeech, requestExplain, requestWordLookup } from '../utils/translateApi';
import { describeKeyEvent } from '../utils/shortcuts';
import { EXPLAIN_LEVELS, MAX_LOOKUP_CHARS, extractHoverWord, type ExplainLevel, type ExplainResult, type LookupResult } from '../utils/selectionLookup';
import { createTtsQueue, resolveTargetSpeechLang } from '../utils/tts';
import { playAudioBytes, resolveEdgeVoice } from '../utils/edgeTts';
import { clearCardPosition, loadCardPosition, saveCardPosition, type CardPosition } from '../utils/cardPosition';
import { loadVocabBook, saveVocabBook, upsertVocabEntry, vocabPageKey, type VocabEntry } from '../utils/vocabbook';
import {
  SELECTION_HOST_ID,
  isEditableTarget,
  mountSelectionCard,
  resolveLookupTrigger,
} from './content/selectionCard';

/** 选区是否落在扩展自有的浮层宿主里（closed shadow 用 rootNode→host 判定）。 */
const insideOwnOverlay = (node: Node | null): boolean => {
  const root = node?.getRootNode?.();
  if (!(root instanceof ShadowRoot)) return false;
  const hostId = (root.host as HTMLElement | undefined)?.id ?? '';
  return hostId === SELECTION_HOST_ID || hostId === 'moyi-float-control' || hostId.startsWith('moyi-');
};

/** 选区所在段落文本（Saladict 式带上下文收藏；截断到词表契约上限）。 */
const captureContext = (node: Node | null): string => {
  const element = node?.nodeType === Node.ELEMENT_NODE ? node as Element : node?.parentElement ?? null;
  const raw = element?.textContent ?? '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 160);
};

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_idle',
  main() {
    let enabled = true;
    let currentQuery = '';
    let requestId = 0;
    /** 已收藏键集合（词小写 + 页面键）：词卡按钮「已收藏」回显的数据源。 */
    const collectedKeys = new Set<string>();
    const vocabKeyOf = (word: string, url: string): string =>
      `${word.trim().toLowerCase()}\u0000${vocabPageKey(url)}`;
    void loadVocabBook().then((entries) => {
      for (const entry of entries) collectedKeys.add(vocabKeyOf(entry.word, entry.url));
    }).catch(() => undefined);
    // 设置页删除/清空后同步（storage 是唯一事实来源，集合只是缓存）
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes['moyi-vocabbook']) return;
      void loadVocabBook().then((entries) => {
        collectedKeys.clear();
        for (const entry of entries) collectedKeys.add(vocabKeyOf(entry.word, entry.url));
      }).catch(() => undefined);
    });

    const tts = createTtsQueue();
    /** 该站点记住的卡片位置（用户上次拖拽落点）；启动时读入。 */
    let rememberedPosition: CardPosition | null = null;
    void loadCardPosition(location.hostname).then((pos) => {
      rememberedPosition = pos;
    }).catch(() => undefined);
    /** 「先收藏、后出结果」时待回填的词条（结果到达后静默补译名）。 */
    let backfillPending: { word: string; url: string } | null = null;
    /** 深究态会话历史：仅内存，随新查询/关卡清零（隐私默认，background 不落盘）。 */
    const deepHistory: { role: 'user' | 'assistant'; content: string }[] = [];
    let deepBusy = false;
    let deepLevel: ExplainLevel = 'intermediate';
    let deepContext = '';
    const levelLabel = (level: ExplainLevel): string =>
      EXPLAIN_LEVELS.find((item) => item.id === level)?.label ?? '进阶';
    const card = mountSelectionCard({
      get initialPosition() { return rememberedPosition; },
      onSpeak: (text, kind) => {
        void getConfig().then(async (config) => {
          // 译文/释义是目标语言内容 → 固定用目标语言音色；只有回退读原词才按内容探测
          const lang = kind === 'query' ? undefined : resolveTargetSpeechLang(config.targetLanguage) ?? undefined;
          if (config.ttsSource === 'edge') {
            // 云端音源：任何失败都软降级到系统语音，绝不出现「点了没声音」
            try {
              const voice = resolveEdgeVoice(config.ttsEdgeVoice, lang);
              const bytes = await requestEdgeSpeech(text, voice, config.ttsRate);
              await playAudioBytes(bytes);
              return;
            } catch {
              // 降级继续
            }
          }
          tts.speak(text, { ...(lang ? { lang } : {}), voiceURI: config.ttsVoiceURI, rate: config.ttsRate });
        }).catch(() => undefined);
      },
      onStopSpeak: () => tts.stop(),
      onPositionChange: (position) => {
        // 拖到哪儿，下次同站就出现在哪儿
        rememberedPosition = position;
        void saveCardPosition(location.hostname, position);
      },
      onPositionReset: () => {
        rememberedPosition = null;
        void clearCardPosition(location.hostname);
      },
      onManualClose: () => {
        // ✕ 关闭：清掉「已开词」标记，同一个词再悬停仍可触发
        if (hoverGraceTimer !== undefined) window.clearTimeout(hoverGraceTimer);
        hoverGraceTimer = undefined;
        if (hoverTimer !== undefined) window.clearTimeout(hoverTimer);
        hoverTimer = undefined;
        hoverOpenWord = '';
      },
      onDeepRequest: (level) => {
        deepLevel = level;
        if (deepBusy) return;
        deepBusy = true;
        card.showDeepLoading('按「' + levelLabel(level) + '」讲解中…');
        void requestExplain({ type: 'explain-word', text: currentQuery, level, context: deepContext })
          .then((result) => { card.renderDeep(result as ExplainResult); })
          .catch((error: unknown) => {
            const err = error as Error & { unsupported?: boolean };
            card.showDeepError(err.unsupported
              ? (err.message || '当前翻译服务无语言模型，详解需配置 AI 服务商。')
              : (err.message || '讲解失败，请稍后重试。'));
          })
          .finally(() => { deepBusy = false; });
      },
      onAsk: (question) => {
        if (deepBusy) return;
        deepBusy = true;
        card.setAskEnabled(false);
        void requestExplain({
          type: 'explain-word', text: currentQuery, level: deepLevel, followup: true,
          history: [...deepHistory, { role: 'user' as const, content: question }],
        })
          .then((result) => {
            const parsed = result as ExplainResult;
            const answer = parsed.answer || parsed.usage || parsed.grammar || parsed.example;
            deepHistory.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
            card.appendExchange(question, answer);
          })
          .catch((error: unknown) => {
            const err = error as Error & { unsupported?: boolean };
            card.appendExchange(question, '（失败：' + (err.message || '请稍后重试') + '）');
          })
          .finally(() => { deepBusy = false; card.setAskEnabled(true); });
      },
      onSave: async (result, meta) => {
        const entry: VocabEntry = {
          word: currentQuery,
          // 查询未出结果时先存原词，结果到达后回填（upsert 同词同页覆盖）
          translation: result?.translation || result?.definition || '',
          context: meta?.context ?? '',
          pageTitle: meta?.pageTitle ?? document.title,
          url: meta?.url ?? location.href,
          createdAt: Date.now(),
        };
        try {
          const book = await loadVocabBook();
          const { entries } = upsertVocabEntry(book, entry);
          await saveVocabBook(entries);
          collectedKeys.add(vocabKeyOf(entry.word, entry.url));
          if (!entry.translation) backfillPending = { word: entry.word, url: entry.url };
          return true;
        } catch {
          return false;
        }
      },
    });

    void getConfig().then((config) => { enabled = config.selectionLookupEnabled; }).catch(() => undefined);
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes['personal-translator-config']) return;
      void getConfig().then((config) => { enabled = config.selectionLookupEnabled; }).catch(() => undefined);
    });

    /** 采集当前选区为一次可触发的查询。超长选段不静默丢弃——返回 tooLong 供卡片
     *  明示「选段过长」，用户至少知道发生了什么（两轮真机反馈换来的设计）。 */
    const captureLookup = (): { query: string; rect: DOMRect; anchorNode: Node | null } | { tooLong: number } | null => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return null;
      const text = selection.toString();
      const anchorNode = selection.focusNode ?? selection.anchorNode;
      const query = resolveLookupTrigger(text, {
        enabled,
        insideEditable: isEditableTarget(anchorNode),
        insideOwnUi: insideOwnOverlay(anchorNode),
      });
      if (!query) return null;
      const collapsedLength = text.replace(/s+/g, ' ').trim().length;
      if (collapsedLength > MAX_LOOKUP_CHARS) return { tooLong: collapsedLength };
      let rect: DOMRect;
      try {
        rect = selection.getRangeAt(0).getBoundingClientRect();
      } catch {
        return null;
      }
      if (rect.width === 0 && rect.height === 0) return null;
      return { query, rect, anchorNode };
    };

    /** 超长选段：弹卡明示 + 可操作指引（而不是无反应）。 */
    const noticeTooLong = (length: number, anchorNode: Node | null): void => {
      let rect: DOMRect;
      try {
        const range = window.getSelection()?.getRangeAt(0);
        rect = range ? range.getBoundingClientRect() : new DOMRect(0, 0, 0, 0);
      } catch {
        return;
      }
      card.openNotice('选段 ' + length + ' 字，超过 ' + MAX_LOOKUP_CHARS + ' 字上限——请缩小选区范围后重试。', {
        rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
      }, {
        context: captureContext(anchorNode),
        pageTitle: document.title,
        url: location.href,
      });
    };

    const handleCaptured = (snap: ReturnType<typeof captureLookup>): void => {
      if (!snap) return;
      if ('tooLong' in snap) {
        noticeTooLong(snap.tooLong, null);
        return;
      }
      launchLookup(snap);
    };

    const launchLookup = (snap: { query: string; rect: DOMRect; anchorNode: Node | null }): void => {
      if (card.isOpen() && snap.query === currentQuery) return; // 同词重选：不打扰
      currentQuery = snap.query;
      deepHistory.length = 0;
      deepContext = captureContext(snap.anchorNode);
      const thisRequest = ++requestId;
      card.open('翻译中…', {
        rect: { top: snap.rect.top, bottom: snap.rect.bottom, left: snap.rect.left, right: snap.rect.right },
      }, {
        query: currentQuery,
        context: deepContext,
        pageTitle: document.title,
        url: location.href,
      });
      void requestWordLookup(snap.query)
        .then((result) => {
          if (thisRequest !== requestId) return;
          const typed = result as LookupResult;
          card.render(typed, {
            collected: collectedKeys.has(vocabKeyOf(currentQuery, location.href)),
          });
          if (backfillPending && backfillPending.word === currentQuery) {
            const pending = backfillPending;
            backfillPending = null;
            void (async () => {
              try {
                const book = await loadVocabBook();
                const { entries } = upsertVocabEntry(book, {
                  word: pending.word,
                  translation: typed.translation || typed.definition || '',
                  context: deepContext,
                  pageTitle: document.title,
                  url: pending.url,
                  createdAt: Date.now(),
                });
                await saveVocabBook(entries);
              } catch {
                // 回填失败：词条仍在，只是译名为空（用户可重查再收藏）
              }
            })();
          }
        })
        .catch((error: unknown) => {
          if (thisRequest !== requestId) return;
          const err = error as Error & { unsupported?: boolean };
          card.showError(err.unsupported
            ? (err.message || '当前翻译服务无语言模型，划词查词需在设置中配置 AI 服务商。')
            : (err.message || '查词失败，请稍后重试。'));
        });
    };

    /**
     * 触发时序（三条路径，职责互斥，缺一条就出用户可见的毛病）：
     * ① pointerdown~pointerup 之间一律不触发——拖选时 selectionchange 连发，
     *    防抖定时器会在「用户中途停顿」的瞬间命中半截选区（过早弹卡）；
     * ② pointerup 立即查一次：拖选/已有选区即时生效，且页面随后清空选区也无所谓
     *    （快照已拿到）；双击选词的选区在 pointerup 之后才生成，故 60ms 补查一次；
     * ③ selectionchange 兜底键盘选词（Shift+方向键）：必须避开刚发生过指针交互的
     *    400ms 窗口，否则与 ② 抢跑；连按方向键时 120ms 防抖保证只在停手后弹一次。
     */
    let pointerDown = false;
    let lastPointerUpAt = 0;
    let settleTimer: number | undefined;
    let selectionTimer: number | undefined;

    const onPointerDown = (): void => {
      pointerDown = true;
    };
    const releasePointer = (): void => {
      pointerDown = false;
    };
    const onPointerUp = (event: PointerEvent): void => {
      if (!event.isTrusted) return;
      pointerDown = false;
      lastPointerUpAt = Date.now();
      const live = captureLookup();
      handleCaptured(live);
      if (settleTimer !== undefined) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        settleTimer = undefined;
        handleCaptured(captureLookup());
      }, 60);
    };
    const onSelectionChange = (): void => {
      if (!enabled || pointerDown || Date.now() - lastPointerUpAt < 400) return;
      if (selectionTimer !== undefined) window.clearTimeout(selectionTimer);
      selectionTimer = window.setTimeout(() => {
        selectionTimer = undefined;
        handleCaptured(captureLookup());
      }, 120);
    };


    /**
     * 第四条触发路径：应用内快捷键查词（组合键命中且当前有选区）。
     * 与前三路共用 captureLookup → handleCaptured 链路——去重、卡片生命周期、
     * 超长明示全部一致；IME 组合期与按键按住重复事件一律忽略。
     */
    let lookupShortcut = '';
    let composing = false;
    void getConfig().then((config) => {
      lookupShortcut = config.shortcuts.lookup ?? '';
    }).catch(() => undefined);
    document.addEventListener('compositionstart', () => { composing = true; }, true);
    document.addEventListener('compositionend', () => { composing = false; }, true);
    window.addEventListener('keydown', (event) => {
      if (!event.isTrusted || !lookupShortcut || composing || event.isComposing) return;
      if (describeKeyEvent(event) !== lookupShortcut) return;
      if (card.isOpen()) return; // 卡片已开：快捷键不再改写内容（Esc/点击才是关闭手段）
      event.preventDefault();
      event.stopPropagation();
      handleCaptured(captureLookup());
    }, true);

    /**
     * 悬停查词（opt-in）：mousemove 节流 → 停留 500ms 且累计位移 ≤6px 才触发；
     * 移出/滚动/按键/指针按下立即取消并收卡；页面存在选区时完全不介入
     * （用户在拖选/阅读已选文本，不该被悬停打断）。
     * 会话 LRU(50) 缓存结果：同一词反复划过只请求一次。
     */
    const HOVER_DWELL_MS = 650;
    const HOVER_MOVE_TOLERANCE_PX = 10;
    /** 离词宽限：抬手到移向卡片之间的生理间隙，宽限内不进新词也不关卡。 */
    const HOVER_GRACE_MS = 450;
    const hoverCache = new Map<string, LookupResult>();
    let hoverEnabled = false;
    let hoverTimer: number | undefined;
    let hoverGraceTimer: number | undefined;
    let hoverAnchor: { x: number; y: number; word: string; rect: DOMRect; anchorNode: Text } | null = null;
    let hoverOpenWord = '';

    const readHoverAnchor = (x: number, y: number): typeof hoverAnchor => {
      const range = document.caretRangeFromPoint?.(x, y);
      const textNode = range?.startContainer;
      // instanceof 收窄（nodeType 判断 TS 不做类型收窄）
      if (!range || !textNode || !(textNode instanceof Text)) return null;
      const text = textNode.nodeValue ?? '';
      const hit = extractHoverWord(text, range.startOffset);
      if (!hit) return null;
      // 词的实际矩形：用临时 range 量出来，卡片锚在词上而不是光标上
      const wordRange = document.createRange();
      wordRange.setStart(textNode, hit.start);
      wordRange.setEnd(textNode, hit.end);
      const rect = wordRange.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return null;
      return { x, y, word: hit.word, rect, anchorNode: textNode };
    };

    const cancelHover = (closeCard: boolean): void => {
      if (hoverTimer !== undefined) window.clearTimeout(hoverTimer);
      hoverTimer = undefined;
      if (hoverGraceTimer !== undefined) window.clearTimeout(hoverGraceTimer);
      hoverGraceTimer = undefined;
      hoverAnchor = null;
      if (closeCard && card.isOpen() && hoverOpenWord) card.close();
      hoverOpenWord = '';
    };

    const launchHoverLookup = (word: string, rect: DOMRect, anchorNode: Text): void => {
      currentQuery = word;
      deepHistory.length = 0;
      deepContext = captureContext(anchorNode);
      hoverOpenWord = word;
      const thisRequest = ++requestId;
      const cached = hoverCache.get(word.toLowerCase());
      if (cached) {
        card.open(`「${word}」`, { rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } }, {
          query: word, context: deepContext, pageTitle: document.title, url: location.href,
        });
        card.render(cached, { collected: collectedKeys.has(vocabKeyOf(word, location.href)) });
        return;
      }
      card.open('翻译中…', { rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } }, {
        query: word, context: deepContext, pageTitle: document.title, url: location.href,
      });
      void requestWordLookup(word)
        .then((result) => {
          if (thisRequest !== requestId) return;
          const typed = result as LookupResult;
          hoverCache.set(word.toLowerCase(), typed);
          if (hoverCache.size > 50) hoverCache.delete(hoverCache.keys().next().value ?? '');
          card.render(typed, { collected: collectedKeys.has(vocabKeyOf(word, location.href)) });
        })
        .catch((error: unknown) => {
          if (thisRequest !== requestId) return;
          const err = error as Error & { unsupported?: boolean };
          hoverOpenWord = ''; // 失败不占位：下一次悬停可重试
          card.showError(err.unsupported
            ? (err.message || '当前翻译服务无语言模型，悬停查词需在设置中配置 AI 服务商。')
            : (err.message || '查词失败，请稍后重试。'));
        });
    };

    const onMouseMove = (event: MouseEvent): void => {
      if (!hoverEnabled || event.isTrusted === false) return;
      // ① 指针在卡片内（含 6px 容差）→ 只停待触发器，卡片保持：
      //    closed shadow 会把 target 重定向到宿主，早期用 target 判定导致「伸手点卡片=卡片消失」
      if (card.isPointerInside(event.clientX, event.clientY)) {
        if (hoverTimer !== undefined) window.clearTimeout(hoverTimer);
        hoverTimer = undefined;
        if (hoverGraceTimer !== undefined) window.clearTimeout(hoverGraceTimer);
        hoverGraceTimer = undefined;
        return;
      }
      if (window.getSelection()?.toString().trim()) return; // 有选区：让位于划词/拖选
      if (isEditableTarget(event.target as Node) || insideOwnOverlay(event.target as Node)) {
        // 指针在扩展自有 UI（悬浮球等）上：不触发新词；卡片开着则走宽限关闭
        scheduleGraceClose();
        return;
      }
      const next = readHoverAnchor(event.clientX, event.clientY);
      if (!next) {
        // 空白/图形区：卡片开着给宽限（抬手—移动间隙），开着期间不误关
        scheduleGraceClose();
        return;
      }
      if (hoverAnchor && next.word === hoverAnchor.word) {
        // 同一词内移动：累计位移超阈值即判定「在读/在划」→ 取消
        if (Math.hypot(next.x - hoverAnchor.x, next.y - hoverAnchor.y) > HOVER_MOVE_TOLERANCE_PX) cancelHover(true);
        return;
      }
      cancelHover(true);
      hoverAnchor = next;
      hoverTimer = window.setTimeout(() => {
        hoverTimer = undefined;
        const anchor = hoverAnchor;
        if (!anchor) return;
        launchHoverLookup(anchor.word, anchor.rect, anchor.anchorNode);
      }, HOVER_DWELL_MS);
    };

    /** 宽限关闭：宽限结束时指针若已在卡内则撤销，否则收卡。 */
    const scheduleGraceClose = (): void => {
      if (hoverGraceTimer !== undefined) window.clearTimeout(hoverGraceTimer);
      hoverGraceTimer = window.setTimeout(() => {
        hoverGraceTimer = undefined;
        if (!card.isOpen()) return;
        cancelHover(true);
      }, HOVER_GRACE_MS);
    };

    void getConfig().then((config) => { hoverEnabled = config.selectionHoverEnabled === true; }).catch(() => undefined);
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes['personal-translator-config']) return;
      void getConfig().then((config) => {
        hoverEnabled = config.selectionHoverEnabled === true;
        if (!hoverEnabled) cancelHover(true);
      }).catch(() => undefined);
    });
    document.addEventListener('mouseleave', () => cancelHover(true), true);
    window.addEventListener('scroll', () => cancelHover(true), { capture: true, passive: true });
    window.addEventListener('blur', () => cancelHover(true));
    document.addEventListener('mouseover', onMouseMove, { capture: true, passive: true });

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', releasePointer, true);
    window.addEventListener('blur', releasePointer);
    document.addEventListener('selectionchange', onSelectionChange);
    window.addEventListener('pagehide', () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('pointercancel', releasePointer, true);
      window.removeEventListener('blur', releasePointer);
      document.removeEventListener('selectionchange', onSelectionChange);
      if (settleTimer !== undefined) window.clearTimeout(settleTimer);
      if (selectionTimer !== undefined) window.clearTimeout(selectionTimer);
      document.removeEventListener('mouseover', onMouseMove, true);
      cancelHover(false);
      tts.stop();
      card.destroy();
    }, { once: true });
  },
});
