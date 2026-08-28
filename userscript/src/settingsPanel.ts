/**
 * 页内设置面板：油猴环境没有扩展的 options/popup 页面，设置 UI 必须自绘在网页内。
 *
 * 设计约束：
 *   - closed shadow DOM 承载样式与结构：页面 CSS 无法覆盖、页面脚本无法触达内部节点；
 *   - 用户数据一律经 textContent 写入；innerHTML 仅用于 providers.ts 编译期常量（logo）；
 *   - 配置读写全部复用 utils/config 的清洗函数，保存后经本地 storage.onChanged
 *     自动驱动已打开页面的样式热刷新（与扩展行为一致）；
 *   - 功能面对齐扩展 options 页：服务商管理 / 翻译偏好 / 译文样式 / 快捷键 / 数据管理。
 */

import {
  DEFAULT_CONFIG,
  FLOAT_OPACITY_DEFAULT,
  FLOAT_OPACITY_MAX,
  FLOAT_OPACITY_MIN,
  FLOAT_SIZE_DEFAULT,
  FLOAT_SIZE_MAX,
  FLOAT_SIZE_MIN,
  getConfig,
  saveConfig,
  sanitizeFloatOpacity,
  sanitizeFloatSize,
  sanitizeTranslationColor,
  sanitizeTranslationFontFamily,
  sanitizeTranslationFontSize,
  sanitizeTranslationLetterSpacing,
  sanitizeTranslationLineHeight,
  sanitizeTranslationStylePreset,
  TRANSLATION_STYLE_PRESETS,
  type TranslatorConfig,
} from '../../chrome-plugin/src/utils/config';
import { PROMPT_STYLES, sanitizePromptStyle } from '../../chrome-plugin/src/utils/prompts';
import { formatShortcut, validateShortcut, waitForKeyCombo } from '../../chrome-plugin/src/utils/shortcuts';
import { clearTranslationCache } from '../../chrome-plugin/src/entrypoints/content/translationCache';
import { FLOAT_LOGO_DATA_URI } from '../../chrome-plugin/src/entrypoints/content/floatLogo';
import { resolveReadableColor } from '../../chrome-plugin/src/utils/colorReadability';
import { captureElementTypography, computeTranslationTypography } from '../../chrome-plugin/src/translation-core/typography';
import {
  BUILT_IN_PROVIDERS,
  createCustomProviderId,
  getCustomProviderIds,
  getProviderDisplayName,
  getProviderMark,
  getProviderMeta,
  isCustomProviderId,
  isDeeplProviderId,
  isMtProviderId,
  isNoKeyMtProviderId,
  isProviderConfigured,
  resolveProviderSettings,
  type ProviderMeta,
  type ProviderSettings,
} from '../../chrome-plugin/src/utils/providers';

export const SETTINGS_HOST_ID = 'moyi-settings-host';

const SUPPORTED_LANGUAGES = ['简体中文', '繁體中文', 'English', '日本語', '한국어'] as const;

const STYLE_PRESET_LABELS: Record<string, string> = {
  'ink-line': '朱砂界线',
  'jade-line': '黛青界线',
  underline: '竹青下划',
  highlight: '月白高亮',
  plain: '无标记',
  replace: '直接替换',
};

const COLOR_SWATCHES = [
  { value: '#3f4a56', label: '默认墨灰' },
  { value: '#17171a', label: '墨黑' },
  { value: '#2c3e6b', label: '黛青' },
  { value: '#a33a2b', label: '朱砂' },
  { value: '#3f7a52', label: '竹青' },
];

const FONT_PRESETS = [
  { value: '', label: '跟随原文' },
  { value: "'Source Han Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif", label: '黑体（自动匹配系统）' },
  { value: "'Songti SC', 'STSong', 'SimSun', 'Noto Serif CJK SC', serif", label: '宋体（衬线）' },
  { value: "'Kaiti SC', 'KaiTi', 'STKaiti', serif", label: '楷体' },
  { value: "'FangSong', 'STFangsong', serif", label: '仿宋' },
  { value: "'DengXian', serif", label: '等线' },
  { value: "ui-monospace, 'SFMono-Regular', Consolas, monospace", label: '等宽（代码风）' },
];

// ── 轻量 DOM 构造辅助 ──

type Child = Node | string | null | undefined;

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<Record<string, string | boolean>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === undefined) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (typeof value === 'boolean') (node as HTMLInputElement).checked = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
};

let host: HTMLElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let activeTab = 'service';

const PANEL_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, 'PingFang SC', 'Microsoft YaHei', sans-serif; }
  .overlay {
    position: fixed; inset: 0; z-index: 2147483000;
    background: rgba(15, 18, 22, 0.45);
    display: flex; align-items: center; justify-content: center;
    padding: 16px;
  }
  .panel {
    width: 560px; max-width: 100%; max-height: min(84vh, 720px);
    background: #ffffff; color: #1c1e21;
    border-radius: 14px; overflow: hidden;
    display: flex; flex-direction: column;
    box-shadow: 0 24px 64px -12px rgba(0, 0, 0, 0.45);
  }
  header.head {
    display: flex; align-items: center; gap: 10px;
    padding: 14px 18px; border-bottom: 1px solid #eceef1;
  }
  .logo { width: 26px; height: 26px; border-radius: 50%; display: block; flex: none;
    user-select: none; }
  .title { font-size: 15px; font-weight: 700; flex: 1; }
  .close-btn { border: none; background: transparent; font-size: 20px; line-height: 1;
    cursor: pointer; color: #6b7280; padding: 4px 8px; border-radius: 6px; }
  .close-btn:hover { background: #f2f3f5; color: #111; }
  nav.tabs { display: flex; gap: 2px; padding: 8px 12px 0; border-bottom: 1px solid #eceef1; overflow-x: auto; }
  nav.tabs button {
    border: none; background: transparent; padding: 8px 14px; font-size: 13.5px;
    color: #6b7280; cursor: pointer; border-radius: 8px 8px 0 0;
    border-bottom: 2px solid transparent; white-space: nowrap;
  }
  nav.tabs button.active { color: #17171a; font-weight: 600; border-bottom-color: #17171a; }
  main.body { padding: 16px 18px 22px; overflow-y: auto; }
  section { display: none; }
  section.active { display: block; }

  .hint { font-size: 12px; color: #8a919c; margin: 4px 0 12px; line-height: 1.5; }
  .field { display: block; margin-block: 12px; }
  .field > span.lab { display: block; font-size: 12.5px; font-weight: 600; color: #4b5563; margin-bottom: 6px; }
  input[type="text"], input[type="password"], select, textarea {
    width: 100%; padding: 8px 10px; font-size: 13.5px; color: #1c1e21;
    border: 1px solid #d7dbe0; border-radius: 8px; background: #fff; outline: none;
  }
  input:focus, select:focus, textarea:focus { border-color: #17171a; }
  textarea { min-height: 76px; resize: vertical; }
  .row { display: flex; gap: 8px; align-items: center; }
  button.act {
    border: 1px solid #d7dbe0; background: #fff; color: #1c1e21;
    padding: 7px 14px; font-size: 13px; border-radius: 8px; cursor: pointer;
  }
  button.act:hover { border-color: #9aa1a9; }
  button.primary { background: #17171a; color: #fff; border-color: #17171a; font-weight: 600; }
  button.primary:hover { background: #2b2b30; }
  button.danger { color: #b03a2e; border-color: #e4c4bf; }
  button.danger:hover { background: #fdf3f2; }
  button.act:disabled { opacity: 0.45; cursor: not-allowed; }
  .status { font-size: 12.5px; margin-top: 10px; min-height: 18px; line-height: 1.45; white-space: pre-wrap; }
  .status.ok { color: #2f7a4d; }
  .status.error { color: #b03a2e; }
  .status.busy { color: #6b7280; }

  /* 服务商 rail */
  .rail { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .rail-label { flex-basis: 100%; font-size: 12px; font-weight: 600; color: #6b7280; margin-bottom: -2px; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px;
    border: 1px solid #d7dbe0; border-radius: 999px; padding: 4px 10px 4px 6px;
    background: #fff; cursor: pointer; font-size: 12.5px; color: #374151;
  }
  .chip.selected { border-color: #17171a; background: #f4f4f5; font-weight: 600; }
  .plogo { width: 20px; height: 20px; border-radius: 50%; display: inline-flex; align-items: center;
    justify-content: center; color: var(--c, #666); background: rgba(0,0,0,0.04); font-size: 10px; font-weight: 700; flex: none; }
  .plogo svg { width: 13px; height: 13px; }
  .pdot { width: 7px; height: 7px; border-radius: 50%; background: #d1d5db; flex: none; }
  .pdot.on { background: #22a06b; }
  .badge-active { font-size: 11px; color: #22a06b; font-weight: 700; }

  .checkline { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-block: 12px; cursor: pointer; }

  /* 样式区 */
  .preset-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .preset-item { border: 1px solid #d7dbe0; border-radius: 10px; padding: 10px 8px; text-align: center;
    cursor: pointer; font-size: 12.5px; background: #fff; }
  .preset-item.selected { border-color: #17171a; background: #f4f4f5; font-weight: 600; }
  .swatches { display: flex; gap: 8px; align-items: center; margin-top: 6px; }
  .swatch { width: 24px; height: 24px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
  .swatch[aria-pressed="true"] { border-color: #17171a; }
  input[type="color"] { width: 40px; height: 28px; padding: 2px; border: 1px solid #d7dbe0; border-radius: 6px; background: #fff; }
  input[type="range"] { width: 100%; accent-color: #17171a; }
  .slider-row { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 10px; }
  .slider-val { font-size: 12.5px; color: #4b5563; min-width: 72px; text-align: right; }
  .preview-box { border: 1px solid #eceef1; border-radius: 10px; padding: 12px 14px; margin-top: 14px; background: #fafafa; }
  .preview-tag { font-size: 11px; color: #8a919c; letter-spacing: 0.08em; margin-bottom: 8px; }
  .kv { display: flex; justify-content: space-between; align-items: center; gap: 10px; }

  .radio-line { display: flex; gap: 14px; flex-wrap: wrap; margin-block: 6px; }
  .radio-line label { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; cursor: pointer; }
  .charcount { font-size: 11.5px; color: #8a919c; text-align: right; margin-top: 3px; }
  hr.sep { border: none; border-top: 1px solid #eceef1; margin: 16px 0; }
`;

const buildProviderLogo = (meta: ProviderMeta): HTMLElement => {
  const logo = el('span', { class: 'plogo' });
  logo.style.setProperty('--c', meta.color);
  if (meta.logoSvg) {
    logo.innerHTML = meta.logoSvg;
    return logo;
  }
  if (meta.svgPath) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'currentColor');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', meta.svgPath);
    if (meta.svgPathFillRule) path.setAttribute('fill-rule', meta.svgPathFillRule);
    svg.appendChild(path);
    logo.appendChild(svg);
    return logo;
  }
  logo.textContent = meta.mark;
  return logo;
};

// ── 面板状态 ──

interface PanelState {
  config: TranslatorConfig;
  selectedProviderId: string;
  savedApiKey: string;
  /** 腾讯翻译 SecretKey 的「留空保持不变」回退基准。 */
  savedApiSecret: string;
}

let state: PanelState | null = null;

const setStatus = (box: HTMLElement, message: string, tone: '' | 'ok' | 'error' | 'busy' = ''): void => {
  box.textContent = message;
  box.className = `status${tone ? ` ${tone}` : ''}`;
};

/** 经本地总线测试连接（与 options 页同一条消息路径，安全契约一致）。 */
const sendBusMessage = async <T>(message: unknown): Promise<T> => {
  const runtime = (window as typeof window & { chrome?: { runtime?: { sendMessage: (m: unknown) => Promise<T> } } }).chrome?.runtime;
  if (!runtime?.sendMessage) throw new Error('消息总线未就绪。');
  return runtime.sendMessage(message);
};

// ── 服务商 Tab ──

const renderServiceTab = (container: HTMLElement): void => {
  if (!state) return;
  const { config } = state;
  const statusBox = el('div', { class: 'status' });
  const selectedId = state.selectedProviderId;
  const meta = getProviderMeta(selectedId);
  const isDeepl = isDeeplProviderId(selectedId);
  const isMt = isMtProviderId(selectedId);
  const isTencent = selectedId === 'tencent';
  const isMicrosoft = selectedId === 'microsoft';
  const isGoogle = selectedId === 'google';
  const isNoKeyMt = isNoKeyMtProviderId(selectedId);
  const runtime = resolveProviderSettings(config, selectedId);

  // rail：机器翻译 → 内置服务商 → 自定义服务商，三组分类展示
  const rail = el('div', { class: 'rail' });
  const renderChip = (id: string): void => {
    const pm = getProviderMeta(id);
    const chip = el('button', { class: `chip${id === selectedId ? ' selected' : ''}`, type: 'button' }) as HTMLButtonElement;
    chip.append(
      buildProviderLogo(pm),
      el('span', { text: getProviderDisplayName(config.providers, id) }),
    );
    if (config.providerId === id) chip.append(el('span', { class: 'pdot on', title: '使用中' }));
    chip.addEventListener('click', () => {
      state!.selectedProviderId = id;
      // API Key 输入框「留空保持不变」的回退基准必须跟随所选服务商
      state!.savedApiKey = state!.config.providers[id]?.apiKey ?? '';
      state!.savedApiSecret = state!.config.providers[id]?.apiSecret ?? '';
      rerender();
    });
    rail.append(chip);
  };
  const renderGroup = (label: string, ids: string[]): void => {
    rail.append(el('span', { class: 'rail-label', text: label }));
    ids.forEach(renderChip);
  };
  renderGroup('机器翻译', BUILT_IN_PROVIDERS.filter((p) => p.kind === 'mt').map((p) => p.id));
  renderGroup('内置服务商', BUILT_IN_PROVIDERS.filter((p) => p.kind !== 'mt').map((p) => p.id));
  renderGroup('自定义服务商', getCustomProviderIds(config.providers));
  const addChip = el('button', { class: 'chip', type: 'button', title: '添加自定义服务商' }) as HTMLButtonElement;
  addChip.append(el('span', { text: '＋ 自定义' }));
  addChip.addEventListener('click', () => {
    state!.selectedProviderId = createCustomProviderId();
    rerender();
  });
  rail.append(addChip);

  // 表单
  const endpointInput = el('input', { type: 'text', value: runtime.endpoint ?? '', placeholder: 'https://api.example.com/v1' }) as HTMLInputElement;
  const keyInput = el('input', { type: 'password', placeholder: runtime.apiKey.trim() ? '已保存（留空保持不变，输入新值以替换）' : 'sk-…' }) as HTMLInputElement;
  const modelInput = el('input', { type: 'text', value: runtime.model ?? '', placeholder: 'gpt-4o-mini' }) as HTMLInputElement;
  const secretKeyInput = el('input', { type: 'password', placeholder: runtime.apiSecret.trim() ? '已保存（留空保持不变，输入新值以替换）' : 'SecretKey' }) as HTMLInputElement;
  const regionInput = el('input', { type: 'text', value: runtime.region || 'ap-guangzhou', placeholder: 'ap-guangzhou' }) as HTMLInputElement;

  const effectiveApiKey = (): string => keyInput.value.trim() || state!.savedApiKey;
  const effectiveApiSecret = (): string => secretKeyInput.value.trim() || state!.savedApiSecret;

  const configuredNow = (): boolean =>
    isProviderConfigured({ apiKey: effectiveApiKey(), apiSecret: effectiveApiSecret(), endpoint: endpointInput.value, model: modelInput.value }, selectedId);

  const configuredBadge = el('span', {}) as HTMLElement;

  const refreshBadge = (): void => {
    const ok = configuredNow();
    configuredBadge.textContent = ok ? (isMt ? '已配置' : `已配置：${modelInput.value.trim()}`) : '未配置';
    configuredBadge.className = ok ? 'badge-active' : 'hint';
  };
  [endpointInput, keyInput, modelInput, secretKeyInput, regionInput].forEach((input) => input.addEventListener('input', refreshBadge));

  const nameFieldWrap = el('div');
  let nameInput: HTMLInputElement | null = null;
  if (isCustomProviderId(selectedId)) {
    nameInput = el('input', { type: 'text', maxlength: '24', value: config.providers[selectedId]?.name ?? '', placeholder: '自定义服务商名称' }) as HTMLInputElement;
    nameFieldWrap.append(el('label', { class: 'field' }, el('span', { class: 'lab', text: '服务商名称' }), nameInput));
  }

  const deeplPlanWrap = el('div');
  if (isDeepl) {
    const planSelect = el('select') as HTMLSelectElement;
    for (const [value, label] of [
      ['https://api-free.deepl.com/v2', 'DeepL 免费版（api-free.deepl.com）'],
      ['https://api.deepl.com/v2', 'DeepL 专业版（api.deepl.com）'],
    ] as const) {
      planSelect.append(new Option(label, value));
    }
    planSelect.value = endpointInput.value.includes('api.deepl.com') && !endpointInput.value.includes('api-free')
      ? 'https://api.deepl.com/v2'
      : 'https://api-free.deepl.com/v2';
    planSelect.addEventListener('change', () => {
      endpointInput.value = planSelect.value;
      refreshBadge();
    });
    deeplPlanWrap.append(el('label', { class: 'field' }, el('span', { class: 'lab', text: '接口套餐' }), planSelect));
  }

  const tencentWrap = el('div');
  if (isTencent) {
    tencentWrap.append(
      el('label', { class: 'field' }, el('span', { class: 'lab', text: 'SecretKey（API 密钥）' }), secretKeyInput),
      el('label', { class: 'field' }, el('span', { class: 'lab', text: '地域（Region）' }), regionInput),
      el('p', { class: 'hint', text: '腾讯翻译用 SecretId + SecretKey 双密钥：SecretId 填在表单上方的「SecretId」字段。密钥在腾讯云控制台「API 密钥管理」申请，并在机器翻译控制台开通服务；基础翻译每月有免费额度，超出按字符计费。' }),
    );
  }

  const microsoftHint = el('p', {
    class: 'hint',
    text: '微软翻译使用 Edge 内置的网页翻译端点：无需密钥与接口地址，直接点「测试连接」即可验证。该端点为未公开的在线服务（非 Microsoft 商业 SLA），文本会发送到微软服务器。',
  });
  const googleHint = el('p', {
    class: 'hint',
    text: '谷歌翻译使用 Google 翻译服务端点：无需密钥与接口地址，直接点「测试连接」即可验证。该端点为未公开的在线服务（非 Google 商业 SLA），文本会发送到 Google 服务器；Google 服务在国内通常无法直连，测试失败多半是网络不可达。',
  });

  const disableReasoningInput = el('input', { type: 'checkbox' }) as HTMLInputElement;
  disableReasoningInput.checked = config.disableReasoning;
  const reasoningLine = el('label', { class: 'checkline' }, disableReasoningInput, el('span', { text: '关闭推理模式（省 token，建议聚合渠道开启）' }));

  const deleteButton = el('button', { class: 'act danger', type: 'button', text: '删除该自定义服务商' }) as HTMLButtonElement;
  deleteButton.hidden = !(isCustomProviderId(selectedId) && config.providers[selectedId]);
  deleteButton.addEventListener('click', () => {
    void (async () => {
      if (!state) return;
      const id = state.selectedProviderId;
      if (!isCustomProviderId(id) || !state.config.providers[id]) return;
      const name = getProviderDisplayName(state.config.providers, id);
      if (!window.confirm(`确定删除「${name}」？此操作会清除其 API Key 与配置，无法撤销。`)) return;
      try {
        const base = await getConfig();
        const providers = { ...base.providers };
        delete providers[id];
        await saveConfig({
          ...base,
          providerId: base.providerId === id ? 'openai' : base.providerId,
          providers,
        });
        state.config = await getConfig();
        state.selectedProviderId = state.config.providerId;
        rerender();
        setStatus(statusBox, `已删除「${name}」。`, 'ok');
      } catch (error) {
        setStatus(statusBox, error instanceof Error ? error.message : '删除失败。', 'error');
      }
    })();
  });

  const testButton = el('button', { class: 'act', type: 'button', text: '测试连接' }) as HTMLButtonElement;
  testButton.addEventListener('click', () => {
    void (async () => {
      try {
        // 微软翻译免密钥：不要求 API Key；接口地址留空时回退内置默认
        const endpointValue = endpointInput.value.trim() || meta.endpoint;
        const keyValue = effectiveApiKey();
        if (!endpointValue || (!keyValue && !isNoKeyMt)) {
          throw new Error(isNoKeyMt ? '无需填写任何字段，直接点击即可测试。' : '请先填写接口地址与 API Key。');
        }
        setStatus(statusBox, '正在测试连接…', 'busy');
        testButton.disabled = true;
        const result = await sendBusMessage<{ ok?: boolean; pong?: string; error?: string }>({
          type: 'test-connection',
          endpoint: endpointValue,
          apiKey: keyValue,
          apiSecret: effectiveApiSecret(),
          region: regionInput.value.trim(),
          model: modelInput.value.trim(),
          kind: getProviderMeta(state!.selectedProviderId).kind,
          providerId: state!.selectedProviderId,
        });
        if (!result?.ok) throw new Error(result?.error || '模型连接失败。');
        setStatus(statusBox, '连接成功。', 'ok');
      } catch (error) {
        setStatus(statusBox, `连接失败：${error instanceof Error ? error.message : '未知错误'}。请检查 API Key 或 Base URL。`, 'error');
      } finally {
        testButton.disabled = false;
      }
    })();
  });

  const fetchModelsButton = el('button', { class: 'act', type: 'button', text: '获取模型' }) as HTMLButtonElement;
  fetchModelsButton.addEventListener('click', () => {
    void (async () => {
      try {
        const endpointValue = endpointInput.value.trim();
        if (!endpointValue) throw new Error('请先填写接口地址。');
        fetchModelsButton.disabled = true;
        setStatus(statusBox, '正在获取模型列表…', 'busy');
        const result = await sendBusMessage<{ ok?: boolean; models?: string[]; error?: string }>({
          type: 'fetch-models',
          endpoint: endpointValue,
          apiKey: effectiveApiKey(),
          kind: getProviderMeta(state!.selectedProviderId).kind,
        });
        const models = result?.ok && Array.isArray(result.models) ? result.models : [];
        if (models.length === 0) throw new Error(result?.error || '服务商未返回模型列表。');
        const pick = window.prompt(`共 ${models.length} 个模型，请复制/选择填入：\n${models.slice(0, 60).map((m, i) => `${i + 1}. ${m}`).join('\n')}`, modelInput.value.trim() || models[0]);
        if (pick && pick.trim()) {
          modelInput.value = pick.trim();
          refreshBadge();
        }
        setStatus(statusBox, `已获取 ${models.length} 个模型，填写到模型名后记得「保存并使用」。`, 'ok');
      } catch (error) {
        const fallback = [...getProviderMeta(state!.selectedProviderId).fallbackModels];
        if (fallback.length > 0) {
          const pick = window.prompt(`获取失败（${error instanceof Error ? error.message : '未知错误'}），可从常用模型中选择：`, modelInput.value.trim() || fallback[0]);
          if (pick && pick.trim()) {
            modelInput.value = pick.trim();
            refreshBadge();
          }
        }
        setStatus(statusBox, error instanceof Error ? error.message : '获取失败。', 'error');
      } finally {
        fetchModelsButton.disabled = false;
      }
    })();
  });

  const saveButton = el('button', { class: 'act primary', type: 'button', text: '保存并使用' }) as HTMLButtonElement;
  saveButton.addEventListener('click', () => {
    void (async () => {
      try {
        const keyValue = effectiveApiKey();
        const endpointValue = endpointInput.value.trim() || meta.endpoint;
        const modelValue = modelInput.value.trim();
        if (!isNoKeyMt && (!keyValue || !endpointValue || (!isMt && !modelValue))) {
          setStatus(statusBox, isMt ? '请填写接口地址与 API Key（腾讯翻译另需 SecretKey）。' : '请填写接口地址、API Key 与模型名称后再保存。', 'error');
          return;
        }
        if (isTencent && !effectiveApiSecret()) {
          setStatus(statusBox, '腾讯翻译需要 SecretKey：SecretId 填在表单上方的「SecretId」字段，SecretKey 填在下方「SecretKey」字段。', 'error');
          return;
        }
        saveButton.disabled = true;
        const base = await getConfig();
        const entry: ProviderSettings = isNoKeyMt ? { apiKey: '', endpoint: '' } : { apiKey: keyValue, endpoint: endpointValue };
        if (!isMt && !isNoKeyMt) entry.model = modelValue;
        if (isTencent) {
          entry.apiSecret = effectiveApiSecret();
          entry.region = regionInput.value.trim() || 'ap-guangzhou';
        }
        if (nameInput?.value.trim()) entry.name = nameInput.value.trim().slice(0, 24);
        await saveConfig({
          ...base,
          providerId: state!.selectedProviderId,
          providers: { ...base.providers, [state!.selectedProviderId]: entry },
          disableReasoning: disableReasoningInput.checked,
        });
        const verified = await getConfig();
        state!.config = verified;
        state!.savedApiKey = verified.providers[state!.selectedProviderId]?.apiKey ?? '';
        state!.savedApiSecret = verified.providers[state!.selectedProviderId]?.apiSecret ?? '';
        rerender();
        setStatus(statusBox, `已保存，当前服务：${getProviderDisplayName(verified.providers, verified.providerId)}。`, 'ok');
      } catch (error) {
        loggerWarn(error);
        setStatus(statusBox, error instanceof Error ? error.message : '保存失败。', 'error');
      } finally {
        saveButton.disabled = false;
      }
    })();
  });

  refreshBadge();

  container.append(
    el('p', { class: 'hint', text: '选择服务商并填写凭据；OpenAI 兼容接口支持「获取模型」与「测试连接」，DeepL / 腾讯翻译 / 微软翻译使用官方或内置翻译端点（无需提示词）。公网地址必须 https://，本机/内网可用 http://' }),
    rail,
    nameFieldWrap,
    isNoKeyMt ? el('div') : el('label', { class: 'field' }, el('span', { class: 'lab', text: '接口地址（Base URL）' }), endpointInput),
    isNoKeyMt ? el('div') : el('label', { class: 'field' }, el('span', { class: 'lab', text: isTencent ? 'SecretId（API 密钥 ID）' : 'API Key' }), keyInput),
    isMicrosoft ? microsoftHint : (isGoogle ? googleHint : el('div')),
    isDeepl ? deeplPlanWrap : el('div'),
    isTencent ? tencentWrap : el('div'),
    isMt ? el('div') : el('label', { class: 'field' },
      el('span', { class: 'lab' }, el('span', { text: '模型名称 ' }), configuredBadge),
      modelInput,
      el('div', { class: 'row', style: 'margin-top:8px;' }, fetchModelsButton),
    ),
    el('div', { class: 'row', style: 'margin-top:8px;' }, testButton),
    isMt ? el('div') : reasoningLine,
    el('div', { class: 'row', style: 'margin-top:6px;' }, saveButton, deleteButton),
    statusBox,
  );
};

// ── 翻译 Tab ──

const renderTranslateTab = async (container: HTMLElement): Promise<void> => {
  const config = await getConfig();
  const statusBox = el('div', { class: 'status' });

  const langSelect = el('select') as HTMLSelectElement;
  for (const language of SUPPORTED_LANGUAGES) langSelect.append(new Option(language, language));
  langSelect.value = (SUPPORTED_LANGUAGES as readonly string[]).includes(config.targetLanguage)
    ? config.targetLanguage
    : DEFAULT_CONFIG.targetLanguage;
  langSelect.addEventListener('change', () => {
    void (async () => {
      try {
        const latest = await getConfig();
        await saveConfig({ ...latest, targetLanguage: langSelect.value });
        setStatus(statusBox, `目标语言已切换为${langSelect.value}。`, 'ok');
      } catch (error) {
        setStatus(statusBox, error instanceof Error ? error.message : '语言设置保存失败。', 'error');
      }
    })();
  });

  const promptRadios: HTMLInputElement[] = [];
  const radioLine = el('div', { class: 'radio-line' });
  for (const style of PROMPT_STYLES) {
    const input = el('input', { type: 'radio', name: 'moyi-prompt-style', value: style.id }) as HTMLInputElement;
    input.checked = sanitizePromptStyle(config.promptStyle) === style.id;
    input.addEventListener('change', () => void savePrompt());
    radioLine.append(el('label', {}, input, el('span', { text: `${style.label} · ${style.description}` })));
    promptRadios.push(input);
  }

  const useCustomInput = el('input', { type: 'checkbox' }) as HTMLInputElement;
  useCustomInput.checked = config.useCustomPrompt;
  const customTextarea = el('textarea', { maxlength: '500', placeholder: '用中文或英文描述你的翻译风格要求（最多 500 字）' }) as HTMLTextAreaElement;
  customTextarea.value = config.customPrompt;
  customTextarea.disabled = !config.useCustomPrompt;
  const charCount = el('div', { class: 'charcount', text: `${customTextarea.value.length}/500` });
  customTextarea.addEventListener('input', () => {
    charCount.textContent = `${customTextarea.value.length}/500`;
  });
  useCustomInput.addEventListener('change', () => {
    customTextarea.disabled = !useCustomInput.checked;
    void savePrompt();
  });

  const savePrompt = async (): Promise<void> => {
    try {
      const latest = await getConfig();
      await saveConfig({
        ...latest,
        promptStyle: sanitizePromptStyle(promptRadios.find((r) => r.checked)?.value),
        useCustomPrompt: useCustomInput.checked,
        customPrompt: customTextarea.value.trim(),
      });
      setStatus(statusBox, '提示词已保存。', 'ok');
    } catch (error) {
      setStatus(statusBox, error instanceof Error ? error.message : '提示词保存失败。', 'error');
    }
  };

  container.append(
    el('p', { class: 'hint', text: '目标语言决定译文语种；提示词风格只影响「怎么译」，输出格式契约不受影响。' }),
    el('label', { class: 'field' }, el('span', { class: 'lab', text: '目标语言' }), langSelect),
    el('hr', { class: 'sep' }),
    el('span', { class: 'lab', text: '翻译风格' }),
    radioLine,
    el('label', { class: 'checkline' }, useCustomInput, el('span', { text: '使用自定义风格要求' })),
    customTextarea,
    charCount,
    statusBox,
  );
};

// ── 样式 Tab ──

const renderStyleTab = async (container: HTMLElement): Promise<void> => {
  const config = await getConfig();
  const previewBox = el('div', { class: 'preview-box' });

  /** 面板内预览：用导出的排版基元派生译文样式，不触碰页面级渲染器状态。 */
  const renderPreview = (
    theme: { preset: string; color: string; fontScale: number; fontFamily: string; lineHeight: number; letterSpacing: number },
  ): void => {
    previewBox.textContent = '';
    previewBox.append(el('div', { class: 'preview-tag', text: '预览 · The ink flows gently across the paper.' }));
    const sample = el('p', { text: 'The ink flows gently across the paper.', style: 'margin:0;color:#1c1e21;' }) as HTMLParagraphElement;
    const snapshot = captureElementTypography(sample);
    const { fontSizePx, lineHeightPx, gapPx } = computeTranslationTypography(snapshot, theme.fontScale);
    const translation = el('p', {
      text: '墨迹在纸上轻轻流淌。',
      style: [
        'margin:0',
        `margin-top:${theme.preset === 'replace' ? 0 : gapPx}px`,
        `font-size:${fontSizePx}px`,
        `line-height:${theme.lineHeight > 0 ? Math.round(fontSizePx * theme.lineHeight * 100) / 100 : lineHeightPx}px`,
        `color:${resolveReadableColor(theme.color, snapshot.bgLuminance)}`,
        theme.fontFamily ? `font-family:${theme.fontFamily}` : '',
        theme.letterSpacing !== 0 ? `letter-spacing:${theme.letterSpacing}em` : '',
        theme.preset === 'ink-line'
          ? 'border-left:2px solid rgba(176,58,46,.3);padding-left:.6em'
          : theme.preset === 'jade-line'
            ? 'border-left:2px solid rgba(63,74,86,.35);padding-left:.6em'
            : theme.preset === 'underline'
              ? 'border-bottom:1px dashed rgba(103,135,116,.55)'
              : theme.preset === 'highlight'
                ? 'background:rgba(226,238,241,.9);padding:.2em .55em;border-radius:2px;display:inline-block'
                : '',
      ].filter(Boolean).join(';'),
    }) as HTMLParagraphElement;
    previewBox.append(sample, translation);
  };

  const collectTheme = (): {
    translationStyle: ReturnType<typeof sanitizeTranslationStylePreset>;
    translationColor: string;
    translationFontSize: number;
    translationFontFamily: string;
    translationLineHeight: number;
    translationLetterSpacing: number;
    floatSize: number;
    floatOpacity: number;
  } => ({
    translationStyle: sanitizeTranslationStylePreset(currentPreset),
    translationColor: sanitizeTranslationColor(colorInput.value),
    translationFontSize: sanitizeTranslationFontSize(sizeInput.value),
    translationFontFamily: sanitizeTranslationFontFamily(fontSelect.value === '__custom__' ? fontCustom.value : fontSelect.value),
    translationLineHeight: sanitizeTranslationLineHeight(lineHeightInput.value),
    translationLetterSpacing: sanitizeTranslationLetterSpacing(letterSpacingInput.value),
    floatSize: sanitizeFloatSize(floatSizeInput.value),
    floatOpacity: sanitizeFloatOpacity(floatOpacityInput.value),
  });

  const persist = async (): Promise<void> => {
    try {
      const latest = await getConfig();
      await saveConfig({ ...latest, ...collectTheme() });
      statusBox.textContent = '';
    } catch (error) {
      setStatus(statusBox, error instanceof Error ? error.message : '样式保存失败。', 'error');
    }
  };

  // 滑杆连续拖动会产生高频 input：统一 300ms 防抖后落盘（与 options 页防抖一致）
  let persistTimer: number | undefined;
  const schedulePersist = (): void => {
    window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => void persist(), 300);
  };

  let currentPreset = config.translationStyle;

  const presetGrid = el('div', { class: 'preset-grid' });
  const presetButtons: HTMLButtonElement[] = [];
  for (const preset of TRANSLATION_STYLE_PRESETS) {
    const btn = el('button', { class: `preset-item${preset === currentPreset ? ' selected' : ''}`, type: 'button', text: STYLE_PRESET_LABELS[preset] ?? preset }) as HTMLButtonElement;
    btn.addEventListener('click', () => {
      currentPreset = preset;
      presetButtons.forEach((b) => b.classList.toggle('selected', b.textContent === (STYLE_PRESET_LABELS[preset] ?? preset)));
      syncAll();
    });
    presetButtons.push(btn);
    presetGrid.append(btn);
  }

  const colorInput = el('input', { type: 'color', value: sanitizeTranslationColor(config.translationColor) }) as HTMLInputElement;
  const swatchWrap = el('div', { class: 'swatches' });
  for (const swatch of COLOR_SWATCHES) {
    const btn = el('button', { class: 'swatch', type: 'button', 'aria-label': swatch.label, 'aria-pressed': 'false' }) as HTMLButtonElement;
    btn.style.background = swatch.value;
    btn.addEventListener('click', () => {
      colorInput.value = swatch.value;
      syncSwatches();
      syncAll();
    });
    swatchWrap.append(btn);
  }
  const syncSwatches = (): void => {
    const current = sanitizeTranslationColor(colorInput.value).toLowerCase();
    swatchWrap.querySelectorAll<HTMLButtonElement>('.swatch').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(rgbHex(btn.style.background) === current));
    });
  };

  const sizeInput = el('input', { type: 'range', min: '0.8', max: '1.15', step: '0.01', value: String(config.translationFontSize) }) as HTMLInputElement;
  const lineHeightInput = el('input', { type: 'range', min: '0', max: '2.5', step: '0.05', value: String(config.translationLineHeight) }) as HTMLInputElement;
  const letterSpacingInput = el('input', { type: 'range', min: '-0.05', max: '0.3', step: '0.005', value: String(config.translationLetterSpacing) }) as HTMLInputElement;
  const sizeVal = el('span', { class: 'slider-val' });
  const lhVal = el('span', { class: 'slider-val' });
  const lsVal = el('span', { class: 'slider-val' });

  // 悬浮按钮外观：大小与透明度（保存后经 storage.onChanged 热同步到页面上真实按钮，天然实时预览）
  const floatSizeInput = el('input', { type: 'range', min: String(FLOAT_SIZE_MIN), max: String(FLOAT_SIZE_MAX), step: '1', value: String(sanitizeFloatSize(config.floatSize)) }) as HTMLInputElement;
  const floatOpacityInput = el('input', { type: 'range', min: String(FLOAT_OPACITY_MIN), max: String(FLOAT_OPACITY_MAX), step: '0.05', value: String(sanitizeFloatOpacity(config.floatOpacity)) }) as HTMLInputElement;
  const floatSizeVal = el('span', { class: 'slider-val' });
  const floatOpacityVal = el('span', { class: 'slider-val' });

  const fontSelect = el('select') as HTMLSelectElement;
  for (const font of FONT_PRESETS) fontSelect.append(new Option(font.label, font.value));
  fontSelect.append(new Option('自定义…', '__custom__'));
  const fontCustom = el('input', { type: 'text', maxlength: '80', placeholder: '输入任意已安装字体名，如：霞鹜文楷' }) as HTMLInputElement;
  fontCustom.hidden = true;
  const savedFont = sanitizeTranslationFontFamily(config.translationFontFamily);
  if (!savedFont) fontSelect.value = '';
  else if (FONT_PRESETS.some((f) => f.value === savedFont)) fontSelect.value = savedFont;
  else {
    fontSelect.value = '__custom__';
    fontCustom.hidden = false;
    fontCustom.value = savedFont;
  }

  const syncLabels = (): void => {
    sizeVal.textContent = `${Math.round(sanitizeTranslationFontSize(sizeInput.value) * 100)}%`;
    const lh = sanitizeTranslationLineHeight(lineHeightInput.value);
    lhVal.textContent = lh > 0 ? `${lh.toFixed(2)}×` : '跟随原文';
    const ls = sanitizeTranslationLetterSpacing(letterSpacingInput.value);
    lsVal.textContent = ls === 0 ? '跟随原文' : `${ls > 0 ? '+' : ''}${ls.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}em`;
    floatSizeVal.textContent = `${sanitizeFloatSize(floatSizeInput.value)}px`;
    floatOpacityVal.textContent = `${Math.round(sanitizeFloatOpacity(floatOpacityInput.value) * 100)}%`;
  };
  const syncAll = (): void => {
    syncLabels();
    syncSwatches();
    renderPreview({
      preset: currentPreset,
      color: colorInput.value,
      fontScale: sanitizeTranslationFontSize(sizeInput.value),
      fontFamily: fontSelect.value === '__custom__' ? fontCustom.value : fontSelect.value,
      lineHeight: sanitizeTranslationLineHeight(lineHeightInput.value),
      letterSpacing: sanitizeTranslationLetterSpacing(letterSpacingInput.value),
    });
    schedulePersist();
  };

  [sizeInput, lineHeightInput, letterSpacingInput, floatSizeInput, floatOpacityInput].forEach(
    (input) => input.addEventListener('input', syncAll),
  );
  // 行距物理下限磁性吸附：CJK 倍率 <1.0 必然行重叠，拖入非法区立即弹回 1.0
  lineHeightInput.addEventListener('input', () => {
    const raw = Number.parseFloat(lineHeightInput.value);
    if (raw > 0 && raw < 1) lineHeightInput.value = String(sanitizeTranslationLineHeight(raw));
  });
  colorInput.addEventListener('input', syncAll);
  fontSelect.addEventListener('change', () => {
    fontCustom.hidden = fontSelect.value !== '__custom__';
    if (!fontCustom.hidden) fontCustom.focus();
    syncAll();
  });
  let fontTimer: number | undefined;
  fontCustom.addEventListener('input', () => {
    window.clearTimeout(fontTimer);
    fontTimer = window.setTimeout(syncAll, 400);
  });

  const resetStyleBtn = el('button', { class: 'act', type: 'button', text: '恢复默认样式' }) as HTMLButtonElement;
  resetStyleBtn.addEventListener('click', () => {
    void (async () => {
      currentPreset = DEFAULT_CONFIG.translationStyle;
      presetButtons.forEach((b) => b.classList.toggle('selected', b.textContent === (STYLE_PRESET_LABELS[currentPreset] ?? currentPreset)));
      colorInput.value = DEFAULT_CONFIG.translationColor;
      sizeInput.value = String(DEFAULT_CONFIG.translationFontSize);
      lineHeightInput.value = String(DEFAULT_CONFIG.translationLineHeight);
      letterSpacingInput.value = String(DEFAULT_CONFIG.translationLetterSpacing);
      floatSizeInput.value = String(FLOAT_SIZE_DEFAULT);
      floatOpacityInput.value = String(FLOAT_OPACITY_DEFAULT);
      fontSelect.value = '';
      fontCustom.value = '';
      fontCustom.hidden = true;
      syncAll();
      setStatus(statusBox, '已恢复默认样式。', 'ok');
    })();
  });

  const statusBox = el('div', { class: 'status' });

  container.append(
    el('p', { class: 'hint', text: '六种双语版式；字号相对原文、行距字距可独立调节，改动自动保存并对已渲染译文即时生效。' }),
    presetGrid,
    el('label', { class: 'field' }, el('span', { class: 'lab', text: '译文颜色' }), swatchWrap,
      el('div', { class: 'swatches' }, colorInput)),
    el('label', { class: 'field' }, el('span', { class: 'lab', text: '译文字号（相对原文）' }),
      el('div', { class: 'slider-row' }, sizeInput, sizeVal)),
    el('label', { class: 'field' }, el('span', { class: 'lab', text: '行距（0 = 跟随原文；最小 1.0×）' }),
      el('div', { class: 'slider-row' }, lineHeightInput, lhVal)),
    el('label', { class: 'field' }, el('span', { class: 'lab', text: '字距 em（0 = 跟随原文）' }),
      el('div', { class: 'slider-row' }, letterSpacingInput, lsVal)),
    el('hr', { class: 'sep' }),
    el('p', { class: 'hint', text: '悬浮按钮：越小越不遮挡阅读；闲置半透明，悬停/按下时自动全显。拖动滑杆即刻生效。' }),
    el('label', { class: 'field' }, el('span', { class: 'lab', text: `悬浮按钮大小（${FLOAT_SIZE_MIN}–${FLOAT_SIZE_MAX}px）` }),
      el('div', { class: 'slider-row' }, floatSizeInput, floatSizeVal)),
    el('label', { class: 'field' }, el('span', { class: 'lab', text: '悬浮按钮透明度' }),
      el('div', { class: 'slider-row' }, floatOpacityInput, floatOpacityVal)),
    el('hr', { class: 'sep' }),
    el('label', { class: 'field' }, el('span', { class: 'lab', text: '译文字体' }), fontSelect, fontCustom),
    resetStyleBtn,
    previewBox,
    statusBox,
  );
  syncAll();
};

// ── 快捷键 Tab ──

const renderShortcutsTab = async (container: HTMLElement): Promise<void> => {
  const config = await getConfig();
  const statusBox = el('div', { class: 'status' });

  const buildRow = async (target: 'translate' | 'restore'): Promise<HTMLElement> => {
    const label = target === 'translate' ? '翻译当前页' : '还原原文';
    const display = el('button', { class: 'act', type: 'button', style: 'min-width:120px;font-family:inherit;' }) as HTMLButtonElement;
    const clearBtn = el('button', { class: 'act', type: 'button', text: '清除' }) as HTMLButtonElement;
    let currentCombo = config.shortcuts[target];

    const sync = (): void => {
      display.textContent = currentCombo ? formatShortcut(currentCombo) : '点击录制';
      clearBtn.hidden = !currentCombo;
    };
    display.addEventListener('click', () => {
      display.textContent = '请按组合键…';
      void waitForKeyCombo().then((combo) => {
        void (async () => {
          if (combo === null) {
            setStatus(statusBox, '已取消录制。');
            sync();
            return;
          }
          const validationError = validateShortcut(combo);
          if (validationError) {
            setStatus(statusBox, validationError, 'error');
            sync();
            return;
          }
          try {
            const latest = await getConfig();
            const other = target === 'translate' ? latest.shortcuts.restore : latest.shortcuts.translate;
            if (other === combo) {
              setStatus(statusBox, `「${label}」与另一动作的快捷键相同，请换一个组合。`, 'error');
              sync();
              return;
            }
            await saveConfig({ ...latest, shortcuts: { ...latest.shortcuts, [target]: combo } });
            currentCombo = combo;
            sync();
            setStatus(statusBox, `「${label}」已设为 ${formatShortcut(combo)}`, 'ok');
          } catch (error) {
            setStatus(statusBox, error instanceof Error ? error.message : '录制失败。', 'error');
          }
        })();
      });
    });
    clearBtn.addEventListener('click', () => {
      void (async () => {
        try {
          const latest = await getConfig();
          await saveConfig({ ...latest, shortcuts: { ...latest.shortcuts, [target]: '' } });
          currentCombo = '';
          sync();
          setStatus(statusBox, `已清除${label}快捷键。`, 'ok');
        } catch (error) {
          setStatus(statusBox, error instanceof Error ? error.message : '操作失败。', 'error');
        }
      })();
    });
    sync();
    return el('div', { class: 'kv', style: 'margin-block:10px;' },
      el('span', { class: 'lab', text: label, style: 'font-size:13px;' }),
      el('div', { class: 'row' }, display, clearBtn));
  };

  container.append(
    el('p', { class: 'hint', text: '组合键在页面内触发（无需浏览器级快捷键）；必须包含 Ctrl / ⌘ / Alt 之一，避免与打字冲突。' }),
    await buildRow('translate'),
    await buildRow('restore'),
    statusBox,
  );
};

// ── 数据 Tab ──

const renderDataTab = (container: HTMLElement): void => {
  const statusBox = el('div', { class: 'status' });

  const cacheInfo = el('p', { class: 'hint', text: '段落级译文缓存按「目标语言 + 原文哈希」存储（7 天过期、上限 5000 条自动淘汰），命中后零请求即时显示。' });
  const clearCacheButton = el('button', { class: 'act danger', type: 'button', text: '清空译文缓存' }) as HTMLButtonElement;
  clearCacheButton.addEventListener('click', () => {
    void (async () => {
      try {
        await clearTranslationCache();
        setStatus(statusBox, '译文缓存已清空。', 'ok');
      } catch (error) {
        setStatus(statusBox, error instanceof Error ? error.message : '清空失败。', 'error');
      }
    })();
  });

  const resetAllButton = el('button', { class: 'act danger', type: 'button', text: '恢复全部默认配置' }) as HTMLButtonElement;
  resetAllButton.addEventListener('click', () => {
    void (async () => {
      if (!window.confirm('确定恢复全部默认配置？将清除所有服务商凭据、样式与快捷键，无法撤销。')) return;
      try {
        await saveConfig({ ...DEFAULT_CONFIG, providers: {} });
        await clearTranslationCache();
        setStatus(statusBox, '已恢复默认配置。', 'ok');
        void reloadAndRerender();
      } catch (error) {
        setStatus(statusBox, error instanceof Error ? error.message : '重置失败。', 'error');
      }
    })();
  });

  const about = el('p', {
    class: 'hint',
    text: '墨译 · 油猴脚本版 — 基于大模型的沉浸式网页双语翻译：流式渲染、视口优先、上下文感知；支持 OpenAI 兼容服务商与 DeepL。',
  });

  container.append(cacheInfo, clearCacheButton, el('hr', { class: 'sep' }), resetAllButton, el('hr', { class: 'sep' }), about, statusBox);
};

// ── 面板装配 ──

const TAB_DEFS: { id: string; label: string; render: (container: HTMLElement) => void | Promise<void> }[] = [
  { id: 'service', label: '服务商', render: (c) => renderServiceTab(c) },
  { id: 'translate', label: '翻译', render: (c) => renderTranslateTab(c) },
  { id: 'style', label: '样式', render: (c) => renderStyleTab(c) },
  { id: 'shortcuts', label: '快捷键', render: (c) => renderShortcutsTab(c) },
  { id: 'data', label: '数据', render: (c) => renderDataTab(c) },
];

const rerender = (): void => {
  if (!shadowRoot) return;
  const body = shadowRoot.querySelector<HTMLElement>('.body');
  if (!body) return;
  body.textContent = '';
  const def = TAB_DEFS.find((tab) => tab.id === activeTab) ?? TAB_DEFS[0];
  void def.render(body);
};

const reloadAndRerender = async (): Promise<void> => {
  const config = await getConfig();
  state = { config, selectedProviderId: config.providerId, savedApiKey: config.providers[config.providerId]?.apiKey ?? '', savedApiSecret: config.providers[config.providerId]?.apiSecret ?? '' };
  rerender();
};

const loggerWarn = (error: unknown): void => {
  console.warn('[PersonalTranslator]', 'panel.save.failure', error);
};

const rgbHex = (styleColor: string): string => {
  // computed 形如 rgb(r, g, b)；仅用于 swatch 高亮比对，解析失败返回空串
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(styleColor);
  if (!match) return '';
  return `#${[match[1], match[2], match[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
};

export const isPanelOpen = (): boolean => Boolean(host?.isConnected);

export const openSettingsPanel = (): void => {
  if (isPanelOpen()) return;
  host = document.createElement('div');
  host.id = SETTINGS_HOST_ID;
  shadowRoot = host.attachShadow({ mode: 'closed' });

  const overlay = el('div', { class: 'overlay' });
  const panel = el('div', { class: 'panel' });

  const head = el('header', { class: 'head' },
    el('img', { class: 'logo', src: FLOAT_LOGO_DATA_URI, alt: '' }),
    el('span', { class: 'title', text: '墨译 · 设置' }),
  );
  const closeButton = el('button', { class: 'close-btn', type: 'button', text: '×', 'aria-label': '关闭设置' }) as HTMLButtonElement;
  closeButton.addEventListener('click', closeSettingsPanel);
  head.append(closeButton);

  const tabsNav = el('nav', { class: 'tabs' });
  const body = el('main', { class: 'body' });
  for (const tab of TAB_DEFS) {
    const btn = el('button', { class: `tab-btn${tab.id === activeTab ? ' active' : ''}`, type: 'button', text: tab.label }) as HTMLButtonElement;
    btn.dataset.tab = tab.id;
    btn.addEventListener('click', () => {
      activeTab = tab.id;
      tabsNav.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.tab === activeTab));
      rerender();
    });
    tabsNav.append(btn);
  }

  overlay.appendChild(panel);
  panel.append(head, tabsNav, body);

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeSettingsPanel();
  });

  const styleEl = document.createElement('style');
  styleEl.textContent = PANEL_CSS;
  shadowRoot.append(styleEl, overlay);
  document.documentElement.appendChild(host);

  // Esc 关闭：捕获在 window 上，面板关闭时移除
  window.addEventListener('keydown', escToClose, true);
  void reloadAndRerender();
};

const escToClose = (event: KeyboardEvent): void => {
  if (event.key !== 'Escape' || !isPanelOpen()) return;
  event.stopPropagation();
  closeSettingsPanel();
};

export const closeSettingsPanel = (): void => {
  window.removeEventListener('keydown', escToClose, true);
  host?.remove();
  host = null;
  shadowRoot = null;
};
