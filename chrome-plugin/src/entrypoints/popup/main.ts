import { DEFAULT_CONFIG, getConfig, saveConfig, type TranslatorConfig } from '../../utils/config';
import { logger } from '../../utils/logger';
import { sanitizePromptStyle } from '../../utils/prompts';
import { computeMenuPlacement } from '../../utils/popupMenuPosition';
import {
  activateConfiguredProvider,
  getConfiguredProviderIds,
  getProviderDisplayName,
  getProviderMark,
  getProviderMeta,
  isProviderConfigured,
  resolveProviderSettings,
  type ProviderMeta,
  type ProviderSettings,
} from '../../utils/providers';

const SUPPORTED_LANGUAGES = ['简体中文', '繁體中文', 'English', '日本語', '한국어'] as const;

const targetLanguage = document.querySelector<HTMLButtonElement>('#targetLanguage')!;
const targetLanguageLabel = document.querySelector<HTMLSpanElement>('#targetLanguageLabel')!;
const targetCard = document.querySelector<HTMLDivElement>('#targetCard')!;
const languageMenu = document.querySelector<HTMLDivElement>('#languageMenu')!;
let languageMenuOpen = false;
let languageActiveIndex = -1;
const translateButton = document.querySelector<HTMLButtonElement>('#translate')!;
const primaryLabel = document.querySelector<HTMLSpanElement>('#primaryLabel')!;
const primaryKbd = document.querySelector<HTMLElement>('#primaryKbd')!;
const openSettingsButton = document.querySelector<HTMLButtonElement>('#openSettings')!;
const pageHost = document.querySelector<HTMLDivElement>('#pageHost')!;
const status = document.querySelector<HTMLDivElement>('#status')!;
const statusText = document.querySelector<HTMLSpanElement>('#statusText')!;
const statusAction = document.querySelector<HTMLButtonElement>('#statusAction')!;
const providerSelect = document.querySelector<HTMLSelectElement>('#providerSelect')!;
const providerMark = document.querySelector<HTMLSpanElement>('#providerMark')!;
const providerControl = document.querySelector<HTMLDivElement>('#providerControl')!;
const providerToggle = document.querySelector<HTMLButtonElement>('#providerToggle')!;
const providerLabel = document.querySelector<HTMLSpanElement>('#providerLabel')!;
const providerMenu = document.querySelector<HTMLDivElement>('#providerMenu')!;
let providerOptions: { id: string; name: string; model: string; color: string; mark: string }[] = [];
let providerMenuOpen = false;
let providerActiveIndex = -1;
const promptStyle = document.querySelector<HTMLSelectElement>('#promptStyle')!;
const promptStyleButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>('[data-prompt-style]'),
);
const customStyleBadge = document.querySelector<HTMLSpanElement>('#customStyleBadge')!;
const version = document.querySelector<HTMLSpanElement>('#version')!;

type StatusTone = 'idle' | 'busy' | 'ok' | 'error';

const openSettings = (): void => {
  void chrome.runtime.openOptionsPage();
};

/**
 * 服务商 logo：优先图片（logoSvg / svgPath），都没有时回退为「名称首字」文字标记。
 * logoSvg/svgPath 为 providers.ts 内编译期常量，非用户数据，可经 innerHTML 写入。
 */
const renderProviderLogo = (
  meta: ProviderMeta,
  providers: Record<string, ProviderSettings>,
  selectedId: string,
): void => {
  providerMark.innerHTML = '';
  providerMark.style.setProperty('--provider-color', meta.color);
  if (meta.logoSvg) {
    providerMark.innerHTML = meta.logoSvg;
    return;
  }
  if (meta.svgPath) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'currentColor');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', meta.svgPath);
    if (meta.svgPathFillRule) path.setAttribute('fill-rule', meta.svgPathFillRule);
    svg.appendChild(path);
    providerMark.appendChild(svg);
    return;
  }
  providerMark.textContent = getProviderMark(providers, selectedId);
};

const renderConfigSummary = (config: TranslatorConfig): void => {
  const configuredIds = getConfiguredProviderIds(config);
  providerSwitchAvailable = configuredIds.length > 0;
  providerSelect.innerHTML = '';
  providerOptions = [];

  const refreshToggle = (activeId: string): void => {
    const meta = getProviderMeta(activeId);
    renderProviderLogo(meta, config.providers, activeId);
    const found = providerOptions.find((option) => option.id === activeId);
    providerLabel.textContent = found ? `${found.name} · ${found.model}` : '请选择已配置的服务';
  };

  if (configuredIds.length === 0) {
    const option = new Option('尚未配置翻译服务', '', true, true);
    providerSelect.add(option);
    providerSelect.disabled = true;
    providerToggle.disabled = true;
    providerMark.textContent = '—';
    providerMark.style.removeProperty('--provider-color');
    providerLabel.textContent = '尚未配置翻译服务';
    providerMenu.hidden = true;
    providerMenuOpen = false;
  } else {
    configuredIds.forEach((id) => {
      const meta = getProviderMeta(id);
      const model = meta.kind === 'mt' ? '官方翻译' : (config.providers[id]?.model?.trim() || '未选择模型');
      const name = getProviderDisplayName(config.providers, id);
      providerOptions.push({ id, name, model, color: meta.color, mark: getProviderMark(config.providers, id) });
      providerSelect.add(new Option(`${name} · ${model}`, id));
    });

    const activeId = configuredIds.includes(config.providerId) ? config.providerId : '';
    providerSelect.value = activeId;
    providerToggle.disabled = busy;
    if (activeId) {
      refreshToggle(activeId);
    } else {
      providerLabel.textContent = '请选择已配置的服务';
      const meta = getProviderMeta(config.providerId);
      renderProviderLogo(meta, config.providers, config.providerId);
    }
  }

  const customPromptActive = Boolean(config.useCustomPrompt && config.customPrompt.trim());
  const activeStyle = customPromptActive ? 'custom' : sanitizePromptStyle(config.promptStyle);
  promptStyle.value = activeStyle;
  promptStyleButtons.forEach((button) => {
    const selected = !customPromptActive && button.dataset.promptStyle === activeStyle;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected || (customPromptActive && button.dataset.promptStyle === config.promptStyle) ? 0 : -1;
  });
  customStyleBadge.hidden = !customPromptActive;
};

const setVersionLabel = (): void => {
  try {
    version.textContent = `v${chrome.runtime.getManifest().version}`;
  } catch {
    version.textContent = '';
  }
};

const setStatus = (message: string, tone: StatusTone = 'idle', action = false): void => {
  status.hidden = false;
  statusText.textContent = message;
  status.classList.remove('ok', 'error', 'busy');
  if (tone !== 'idle') status.classList.add(tone);
  statusAction.hidden = !action;
};

const getActiveTab = async (): Promise<chrome.tabs.Tab> => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || typeof tab.id !== 'number') throw new Error('无法找到当前标签页。');
  return tab;
};

const sendCommand = async <T>(command: 'translate-page' | 'restore-page' | 'stop-translation'): Promise<T> => {
  const tab = await getActiveTab();
  const result = await chrome.runtime.sendMessage({ type: 'page-command', tabId: tab.id, command }) as T & {
    ok?: boolean;
    error?: string;
  };
  if (result && result.ok === false) throw new Error(result.error || '页面操作失败。');
  return result;
};

const isSupportedPage = (url: string | undefined): boolean => Boolean(url && /^https?:/i.test(url));

const describePage = (tab: chrome.tabs.Tab): string => {
  if (!tab.url) return tab.title?.trim() || '当前标签页';
  try {
    const url = new URL(tab.url);
    if (url.protocol === 'file:') return url.pathname.split('/').filter(Boolean).at(-1) || '本地文件';
    return url.hostname.replace(/^www\./i, '') || tab.title?.trim() || '当前标签页';
  } catch {
    return tab.title?.trim() || '当前标签页';
  }
};

let busy = false;
let operationId = 0;
let pageSupported = true;
let providerSwitchAvailable = false;
let shortcutAvailable = true;
let selectedLanguage = DEFAULT_CONFIG.targetLanguage;

const enterBusyMode = (): void => {
  busy = true;
  primaryLabel.textContent = '停止翻译';
  primaryKbd.hidden = true;
  translateButton.classList.add('stopping');
  targetLanguage.disabled = true;
  closeLanguageMenu();
  providerToggle.disabled = true;
  closeProviderMenu();
  promptStyle.disabled = true;
  promptStyleButtons.forEach((button) => { button.disabled = true; });
};

const exitBusyMode = (): void => {
  busy = false;
  primaryLabel.textContent = '翻译当前页';
  primaryKbd.hidden = !shortcutAvailable;
  translateButton.classList.remove('stopping');
  translateButton.disabled = !pageSupported;
  targetLanguage.disabled = false;
  providerToggle.disabled = !providerSwitchAvailable;
  promptStyle.disabled = false;
  promptStyleButtons.forEach((button) => { button.disabled = false; });
};

const setShortcutLabel = async (): Promise<void> => {
  const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
  primaryKbd.textContent = isMac ? '⌥ ⇧ T' : 'Alt + Shift + T';

  try {
    const commands = await chrome.commands.getAll();
    const command = commands.find((item) => item.name === 'translate-page');
    shortcutAvailable = Boolean(command?.shortcut);
    primaryKbd.hidden = !shortcutAvailable;
    if (command?.shortcut) primaryKbd.textContent = command.shortcut.replaceAll('+', ' + ');
  } catch {
    shortcutAvailable = true;
  }
};

const load = async (): Promise<void> => {
  const [config, tab] = await Promise.all([getConfig(), getActiveTab()]);
  renderConfigSummary(config);
  const language = (SUPPORTED_LANGUAGES as readonly string[]).includes(config.targetLanguage)
    ? config.targetLanguage
    : DEFAULT_CONFIG.targetLanguage;
  selectedLanguage = language;
  targetLanguageLabel.textContent = language;

  const host = describePage(tab);
  pageHost.textContent = host;
  pageHost.title = tab.title?.trim() || host;
  pageSupported = isSupportedPage(tab.url);
  translateButton.disabled = !pageSupported;

  if (!pageSupported) {
    status.hidden = true;
  } else if (!isProviderConfigured(resolveProviderSettings(config, config.providerId), config.providerId)) {
    setStatus('尚未配置翻译服务，完成配置后即可使用。', 'error', true);
  }
};

openSettingsButton.addEventListener('click', openSettings);
statusAction.addEventListener('click', openSettings);

const renderProviderMenu = (): void => {
  providerMenu.innerHTML = '';
  if (providerOptions.length === 0) {
    providerMenu.hidden = true;
    providerMenuOpen = false;
    return;
  }
  const activeId = providerSelect.value;
  providerOptions.forEach((option, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'provider-option';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(option.id === activeId));
    item.style.setProperty('--provider-color', option.color);
    // 名称/模型均可能为自定义输入，一律 textContent 写入，杜绝 innerHTML 注入；
    // logo 只允许使用 providers.ts 内编译期常量（logoSvg/svgPath），用户数据（自定义服务商）回退首字
    const mark = document.createElement('span');
    mark.className = 'provider-option-mark';
    const optionMeta = getProviderMeta(option.id);
    if (optionMeta.logoSvg) {
      mark.innerHTML = optionMeta.logoSvg;
    } else if (optionMeta.svgPath) {
      mark.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="${optionMeta.svgPath}"${optionMeta.svgPathFillRule ? ` fill-rule="${optionMeta.svgPathFillRule}"` : ''}></path></svg>`;
    } else {
      mark.textContent = option.mark;
    }
    const name = document.createElement('span');
    name.className = 'provider-option-name';
    name.textContent = option.name;
    const model = document.createElement('span');
    model.className = 'provider-option-model';
    model.textContent = option.model;
    item.append(mark, name, model);
    item.addEventListener('click', () => selectProvider(option.id));
    item.addEventListener('mouseenter', () => setActiveIndex(index));
    providerMenu.appendChild(item);
  });
};

/**
 * 弹窗内浮层菜单定位：弹窗是固定尺寸视口，固定定位元素不会撑大窗口，
 * 直接向下展开会被视口底边裁剪。计算逻辑见 utils/popupMenuPosition
 * （择优开向 + maxHeight 钳到可用空间内，超出靠菜单内部滚动）。
 */
const positionFloatingMenu = (menu: HTMLElement, trigger: HTMLElement): void => {
  const rect = trigger.getBoundingClientRect();
  const viewportH = document.documentElement.clientHeight || window.innerHeight;
  const placement = computeMenuPlacement(rect.top, rect.bottom, viewportH);
  menu.style.maxHeight = `${placement.maxHeight}px`;
  menu.style.left = `${rect.left}px`;
  menu.style.width = `${rect.width}px`;
  if (placement.placement === 'below') {
    menu.style.top = `${placement.top}px`;
    menu.style.bottom = 'auto';
  } else {
    menu.style.bottom = `${placement.bottom}px`;
    menu.style.top = 'auto';
  }
};

const positionProviderMenu = (): void => positionFloatingMenu(providerMenu, providerToggle);

const setActiveIndex = (index: number): void => {
  // 鼠标在同一选项上反复触发 mouseenter 时跳过重绘，避免无意义的 DOM 抖动
  if (index === providerActiveIndex) return;
  providerActiveIndex = index;
  const items = Array.from(providerMenu.querySelectorAll<HTMLElement>('.provider-option'));
  items.forEach((item, i) => {
    item.setAttribute('aria-selected', String(i === index));
    item.tabIndex = i === index ? 0 : -1;
  });
  items[index]?.focus();
};

const openProviderMenu = (): void => {
  if (!providerSwitchAvailable || busy) return;
  renderProviderMenu();
  positionProviderMenu();
  providerMenu.hidden = false;
  providerMenuOpen = true;
  providerControl.classList.add('open');
  providerToggle.setAttribute('aria-expanded', 'true');
  const activeIndex = providerOptions.findIndex((option) => option.id === providerSelect.value);
  setActiveIndex(activeIndex >= 0 ? activeIndex : 0);
};

function closeProviderMenu(): void {
  providerMenu.hidden = true;
  providerMenuOpen = false;
  providerControl.classList.remove('open');
  providerToggle.setAttribute('aria-expanded', 'false');
}

const selectProvider = async (id: string): Promise<void> => {
  if (!id || id === providerSelect.value) {
    closeProviderMenu();
    return;
  }
  providerToggle.disabled = true;
  providerSelect.value = id;
  try {
    const config = await getConfig();
    const nextConfig = activateConfiguredProvider(config, id);
    await saveConfig(nextConfig);

    const verified = await getConfig();
    if (
      verified.providerId !== nextConfig.providerId ||
      verified.apiKey !== nextConfig.apiKey ||
      verified.endpoint !== nextConfig.endpoint ||
      verified.model !== nextConfig.model
    ) {
      throw new Error('翻译服务切换后校验失败。');
    }

    renderConfigSummary(verified);
    closeProviderMenu();
    setStatus(`已切换至${getProviderDisplayName(verified.providers, verified.providerId)}。`, 'ok');
  } catch (error) {
    logger.error('popup.provider_switch.failure', { error, selectedProviderId: id });
    try {
      renderConfigSummary(await getConfig());
    } catch {
      providerSelect.value = '';
      providerSwitchAvailable = false;
    }
    closeProviderMenu();
    setStatus(error instanceof Error ? error.message : '翻译服务切换失败。', 'error');
  } finally {
    providerToggle.disabled = busy || !providerSwitchAvailable;
  }
};

providerToggle.addEventListener('click', () => {
  if (providerMenuOpen) closeProviderMenu();
  else openProviderMenu();
});

providerToggle.addEventListener('keydown', (event) => {
  if (!providerMenuOpen) return;
  if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault();
    const count = providerOptions.length;
    const next = event.key === 'ArrowDown'
      ? (providerActiveIndex + 1 + count) % count
      : (providerActiveIndex - 1 + count) % count;
    setActiveIndex(next);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeProviderMenu();
    providerToggle.focus();
  }
});

document.addEventListener('click', (event) => {
  if (!providerMenuOpen) return;
  if (providerControl.contains(event.target as Node)) return;
  closeProviderMenu();
});

document.addEventListener('keydown', (event) => {
  if (!providerMenuOpen || event.key !== 'Escape') return;
  closeProviderMenu();
  providerToggle.focus();
});

const selectPromptStyle = async (selectedStyle: string): Promise<void> => {
  if (selectedStyle === 'custom') return;
  promptStyle.disabled = true;
  promptStyleButtons.forEach((button) => { button.disabled = true; });

  try {
    const config = await getConfig();
    const nextStyle = sanitizePromptStyle(selectedStyle);
    const nextConfig: TranslatorConfig = {
      ...config,
      promptStyle: nextStyle,
      useCustomPrompt: false,
    };
    await saveConfig(nextConfig);
    renderConfigSummary(nextConfig);
    const label = promptStyleButtons.find(
      (button) => button.dataset.promptStyle === nextStyle,
    )?.textContent ?? '通用';
    setStatus(`翻译风格已切换为${label}。`, 'ok');
  } catch (error) {
    logger.error('popup.prompt_style_save.failure', { error });
    try {
      renderConfigSummary(await getConfig());
    } catch {
      promptStyle.value = DEFAULT_CONFIG.promptStyle;
    }
    setStatus(error instanceof Error ? error.message : '翻译风格保存失败。', 'error');
  } finally {
    if (!busy) {
      promptStyle.disabled = false;
      promptStyleButtons.forEach((button) => { button.disabled = false; });
    }
  }
};

promptStyleButtons.forEach((button, index) => {
  button.addEventListener('click', () => {
    void selectPromptStyle(button.dataset.promptStyle ?? 'general');
  });
  button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? promptStyleButtons.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + promptStyleButtons.length)
          % promptStyleButtons.length;
    promptStyleButtons[nextIndex]?.focus();
    void selectPromptStyle(promptStyleButtons[nextIndex]?.dataset.promptStyle ?? 'general');
  });
});

const renderLanguageMenu = (): void => {
  languageMenu.innerHTML = '';
  SUPPORTED_LANGUAGES.forEach((language, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'provider-option lang-option';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(language === selectedLanguage));
    // 选项文本来自常量列表，textContent 写入
    const name = document.createElement('span');
    name.className = 'provider-option-name';
    name.textContent = language;
    item.append(name);
    item.addEventListener('click', () => void selectLanguage(language));
    item.addEventListener('mouseenter', () => setLanguageActiveIndex(index));
    languageMenu.appendChild(item);
  });
};

const positionLanguageMenu = (): void => positionFloatingMenu(languageMenu, targetCard);

const setLanguageActiveIndex = (index: number): void => {
  if (index === languageActiveIndex) return;
  languageActiveIndex = index;
  const items = Array.from(languageMenu.querySelectorAll<HTMLElement>('.provider-option'));
  items.forEach((item, i) => {
    item.setAttribute('aria-selected', String(i === index));
    item.tabIndex = i === index ? 0 : -1;
  });
  items[index]?.focus();
};

const openLanguageMenu = (): void => {
  if (busy || targetLanguage.disabled) return;
  renderLanguageMenu();
  positionLanguageMenu();
  languageMenu.hidden = false;
  languageMenuOpen = true;
  targetCard.classList.add('open');
  targetLanguage.setAttribute('aria-expanded', 'true');
  const activeIndex = SUPPORTED_LANGUAGES.indexOf(selectedLanguage as (typeof SUPPORTED_LANGUAGES)[number]);
  setLanguageActiveIndex(activeIndex >= 0 ? activeIndex : 0);
};

function closeLanguageMenu(): void {
  languageMenu.hidden = true;
  languageMenuOpen = false;
  targetCard.classList.remove('open');
  targetLanguage.setAttribute('aria-expanded', 'false');
}

const selectLanguage = async (language: string): Promise<void> => {
  if (language === selectedLanguage) {
    closeLanguageMenu();
    return;
  }
  const previous = selectedLanguage;
  selectedLanguage = language;
  targetLanguageLabel.textContent = language;
  closeLanguageMenu();
  targetLanguage.disabled = true;
  try {
    const config = await getConfig();
    await saveConfig({ ...config, targetLanguage: language });
    setStatus(`目标语言已切换为${language}。`, 'ok');
  } catch (error) {
    selectedLanguage = previous;
    targetLanguageLabel.textContent = previous;
    logger.error('popup.language_save.failure', { error });
    setStatus(error instanceof Error ? error.message : '语言设置保存失败。', 'error');
  } finally {
    if (!busy) targetLanguage.disabled = false;
  }
};

targetLanguage.addEventListener('click', () => {
  if (languageMenuOpen) closeLanguageMenu();
  else openLanguageMenu();
});

targetLanguage.addEventListener('keydown', (event) => {
  if (!languageMenuOpen) return;
  if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault();
    const count = SUPPORTED_LANGUAGES.length;
    const next = event.key === 'ArrowDown'
      ? (languageActiveIndex + 1 + count) % count
      : (languageActiveIndex - 1 + count) % count;
    setLanguageActiveIndex(next);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeLanguageMenu();
    targetLanguage.focus();
  }
});

document.addEventListener('click', (event) => {
  if (!languageMenuOpen) return;
  const target = event.target as Node;
  if (targetCard.contains(target) || languageMenu.contains(target)) return;
  closeLanguageMenu();
});

document.addEventListener('keydown', (event) => {
  if (!languageMenuOpen || event.key !== 'Escape') return;
  closeLanguageMenu();
  targetLanguage.focus();
});

translateButton.addEventListener('click', () => {
  void (async () => {
    if (busy) {
      operationId += 1;
      try {
        await sendCommand('stop-translation');
        exitBusyMode();
        setStatus('已停止，已完成的译文仍保留在页面中。');
      } catch (error) {
        setStatus(error instanceof Error ? error.message : '停止失败。', 'error');
      }
      return;
    }

    const currentOperation = ++operationId;
    try {
      const config = await getConfig();
      if (!isProviderConfigured(resolveProviderSettings(config, config.providerId), config.providerId)) {
        setStatus('请先配置翻译服务。', 'error', true);
        return;
      }
      if (config.targetLanguage !== selectedLanguage) {
        await saveConfig({ ...config, targetLanguage: selectedLanguage });
      }

      enterBusyMode();
      setStatus('正在翻译当前页，已完成的段落会立即显示。', 'busy');
      logger.info('popup.page_translation.start', { targetLanguage: selectedLanguage });
      const result = await sendCommand<{ ok?: boolean; translated?: number; deferred?: number; error?: string }>('translate-page');
      if (currentOperation !== operationId) return;
      exitBusyMode();
      if (!result?.ok) throw new Error(result?.error || '翻译失败。');

      const translated = result.translated ?? 0;
      const deferred = result.deferred ?? 0;
      logger.info('popup.page_translation.success', { translated, deferred });
      const deferredNote = deferred > 0 ? `，滚动后继续 ${deferred} 段` : '';
      setStatus(`已翻译 ${translated} 段${deferredNote}。`, 'ok');
    } catch (error) {
      if (currentOperation !== operationId) return;
      exitBusyMode();
      logger.error('popup.page_translation.failure', { error });
      setStatus(error instanceof Error ? error.message : '翻译失败，请刷新页面后重试。', 'error');
    }
  })();
});

setVersionLabel();
void setShortcutLabel();
void load().catch((error) => {
  logger.error('popup.load.failure', { error });
  pageHost.textContent = '无法读取当前页面';
  providerSelect.innerHTML = '';
  providerSelect.add(new Option('尚未配置翻译服务', '', true, true));
  providerSelect.disabled = true;
  providerMark.textContent = '—';
  providerMark.style.removeProperty('--provider-color');
  targetLanguage.disabled = true;
  promptStyle.disabled = true;
  promptStyleButtons.forEach((button) => { button.disabled = true; });
  translateButton.disabled = true;
  setStatus('无法读取扩展状态，请重新打开弹窗。', 'error');
});
