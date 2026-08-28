/**
 * 字幕翻译引擎适配器：把「服务商分流 → 翻译通道调用 → 错误升级提示」
 * 封装为站点无关的调度器工厂。YouTube 与 X 的内容脚本共用，
 * 保证两条站点的翻译行为（流式选择、缓存写入、失效检测）始终一致。
 */

import { SubtitleScheduler } from './scheduler';
import { requestBatchTranslation, streamBatchTranslation } from '../../utils/translateApi';
import { logger } from '../../utils/logger';

export type SubtitleBackendKind = 'openai' | 'mt';

export interface EngineAdapterDeps {
  /** 当前激活服务商的后端种类（每次会话开始时刷新）。 */
  getBackendKind: () => SubtitleBackendKind;
  /**
   * 提供给模型的上下文。参数为本批原文（texts[0] 为最旧一条），
   * 宿主可据此附上前一条字幕原文，改善跨句代词与衔接。
   */
  getPageContext: (texts: string[]) => string;
  /** 新译文落持久缓存的回调（宿主自行防抖与语言键管理）。 */
  onNewTranslation: (text: string, translation: string) => void;
  /** 通道级错误（宿主展示在浮层状态条）。 */
  onTranslateError: (message: string) => void;
  /** 扩展重载导致消息通道永久失效（唯一出路是整页刷新）。 */
  onChannelInvalidated: () => void;
}

export const createSubtitleScheduler = (deps: EngineAdapterDeps): SubtitleScheduler =>
  new SubtitleScheduler(
    (texts) => {
      // 与网页翻译共用同一已被当前服务商验证过的通道：
      // OpenAI 兼容后端走流式端口（本地网关/中转对非流式请求的兼容性参差，
      // 流式是页面翻译实测可用的路径）；传统 MT（DeepL / 腾讯）无流式，走批量接口。
      const pageContext = deps.getPageContext(texts);
      const run: Promise<string[]> = deps.getBackendKind() !== 'openai'
        ? requestBatchTranslation(texts)
        : new Promise<string[]>((resolve, reject) => {
            const collected: string[] = [];
            streamBatchTranslation(texts, {
              maxBatchSize: texts.length,
              pageContext,
              onPartial: () => {},
              onParagraph: (index, text) => { collected[index] = text; },
              onError: (message) => reject(new Error(message)),
              onDone: () => resolve(texts.map((_, index) => collected[index] ?? '')),
            });
          });
      return run.catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (/context invalidated|Extension context/i.test(message)) {
          deps.onChannelInvalidated();
        }
        throw error;
      });
    },
    {},
    {
      onNewTranslation: deps.onNewTranslation,
      // 空串/错误占位说明模型未按协议逐条输出或请求出错，记录明细便于定位
      onBatchFailure: (items) => {
        logger.warn('subtitle_batch.invalid', {
          count: items.length,
          previews: items.slice(0, 2).map((item) => item.result.slice(0, 80)),
        });
      },
      onTranslateError: (message) => {
        deps.onTranslateError(message);
        logger.warn('subtitle_translate.error', { message: message.slice(0, 200) });
      },
    },
  );
