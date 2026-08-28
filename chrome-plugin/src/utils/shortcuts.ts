/**
 * 应用内快捷键：用户在设置页录制组合键，内容脚本在页面内监听 keydown 触发。
 * 与 Chrome 原生命令（chrome.commands）并存——此机制不修改浏览器级快捷键。
 *
 * 存储格式：修饰键（Control/Meta/Alt/Shift）+ 主键，如 "Control+Shift+K"；
 * 主键使用 event.key 的语义化写法（字母大写、空格为 Space、F 键原名、方向键原名）。
 */

export interface PageShortcuts {
  translate: string;
  restore: string;
}

export const EMPTY_SHORTCUTS: PageShortcuts = { translate: '', restore: '' };

const MODIFIER_ORDER = ['Control', 'Meta', 'Alt', 'Shift'] as const;

const describeSingleKey = (key: string): string | null => {
  if (key.length === 1) {
    const lower = key.toLowerCase();
    if (/^[a-z0-9]$/.test(lower)) return lower.toUpperCase();
    if (key === ' ') return 'Space';
    return null; // 标点/其他单字符不录制（依赖键盘布局，层次不稳定）
  }
  if (/^F\d{1,2}$/.test(key)) return key;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Tab', 'Escape'].includes(key)) return key;
  return null;
};

/**
 * 由键盘事件生成组合键字符串；纯修饰键（无主键）返回 null。
 * event.key 为纯修饰键时（如 key === 'Shift'）无主键，忽略。
 */
export const describeKeyEvent = (event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string | null => {
  const parts: string[] = [];
  const isModifierKey = ['Control', 'Meta', 'Alt', 'Shift'].includes(event.key);
  if (event.ctrlKey) parts.push('Control');
  if (event.metaKey) parts.push('Meta');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (isModifierKey) return null;
  const main = describeSingleKey(event.key);
  if (!main) return null;
  parts.push(main);
  return parts.join('+');
};

/** 显示格式：Control/⌃·Meta/⌘·Alt/⌥·Shift/⇧，mac 上 Meta 显示 ⌘。 */
export const formatShortcut = (shortcut: string, isMac = false): string => {
  if (!shortcut) return '未设置';
  return shortcut
    .split('+')
    .map((part) => {
      if (part === 'Meta') return isMac ? '⌘' : 'Win';
      if (part === 'Control') return isMac ? '⌃' : 'Ctrl';
      if (part === 'Alt') return '⌥';
      if (part === 'Shift') return '⇧';
      if (part === 'ArrowUp') return '↑';
      if (part === 'ArrowDown') return '↓';
      if (part === 'ArrowLeft') return '←';
      if (part === 'ArrowRight') return '→';
      if (part === 'Space') return '空格';
      if (part === 'Escape') return 'Esc';
      return part;
    })
    .join(' ');
};

/**
 * 浏览器/系统保留组合黑名单：这些组合即使 preventDefault 也会被浏览器接管
 * （新标签页、关闭标签、地址栏、缩放、开发者工具等），必须禁止作为应用内快捷键。
 * 匹配采用前缀判断，例如 "Control+T"、"Control+Shift+T" 均被 "Control+T" 拦截。
 */
const RESERVED: string[] = [
  'Control+W', // 关闭标签
  'Control+Shift+W', // 关闭窗口
  'Control+T', // 新标签
  'Control+Shift+T', // 恢复关闭标签
  'Control+N', // 新窗口
  'Control+Shift+N', // 隐身窗口
  'Control+O', // 打开文件
  'Control+R', // 刷新
  'Control+Shift+R', // 强制刷新
  'Control+F5', // 强制刷新（历史变体）
  'Control+Z', // 撤销
  'Control+Y', // 重做
  'Control+C', 'Control+V', 'Control+X', 'Control+A', // 剪贴板/全选
  'Control+P', // 打印
  'Control+S', // 保存页面
  'Control+F', // 页面查找
  'Control+K', 'Control+L', 'Control+E', // 地址栏/搜索
  'Control+H', // 历史
  'Control+J', // 下载
  'Control+Q', // 退出
  'Control+D', // 书签
  'Control+U', // 查看源码
  'Control+0', 'Control+Plus', 'Control+Minus', // 缩放
  'Control+Shift+J', 'Control+Shift+I', // 开发者工具
  'Control+Shift+C', // 检查元素
  'Control+Shift+Delete', // 清除浏览数据
  'Control+Tab', 'Control+PageUp', 'Control+PageDown', // 切换标签
  'Alt+W', 'Alt+F4', 'Alt+Tab', 'Alt+Left', 'Alt+Right', // 窗口/导航
  'Alt+ArrowLeft', 'Alt+ArrowRight',
  'F5', 'F12', 'F11', 'F1', // 刷新/开发者工具/全屏/帮助
  'Meta+Q', 'Meta+W', 'Meta+T', 'Meta+H', // macOS 系统保留
  'Meta+Space', 'Meta+Tab', 'Meta+ArrowUp', 'Meta+ArrowDown',
];

const MODIFIER_SET = new Set(['Control', 'Meta', 'Alt', 'Shift']);

/** 预解析保留组合：{ 修饰键集合, 主键, 原始写法 }，匹配时以“主键相同且修饰键被包含”判断。 */
const RESERVED_PARSED = RESERVED.map((combo) => {
  const parts = combo.split('+');
  return {
    mods: new Set(parts.filter((part) => MODIFIER_SET.has(part))),
    main: parts.filter((part) => !MODIFIER_SET.has(part)).join('+'),
    label: combo,
  };
});

/**
 * 校验组合键是否可作为应用内快捷键：
 * 必须含 Control/Meta/Alt 之一（纯 Shift 组合容易误触，不设），
 * 主键存在，且不与浏览器/系统保留组合冲突。
 * 冲突判定为「主键相同且修饰键集合完全一致」——例如 Control+K 是地址栏保留，
 * 而 Control+Shift+K 是不同组合、可用；Control+Shift+T（恢复关闭标签）由
 * 保留清单中的 Control+Shift+T 精确拦截。
 */
export const validateShortcut = (shortcut: string): string | null => {
  const parts = shortcut.split('+');
  const mods = parts.filter((part) => MODIFIER_SET.has(part));
  const main = parts.filter((part) => !MODIFIER_SET.has(part)).join('+');
  if (mods.length === 0 || !['Control', 'Meta', 'Alt'].some((strong) => mods.includes(strong))) {
    return '请包含 Ctrl / ⌘ / Alt 之一，避免与打字冲突。';
  }
  if (!main) return '缺少主键。';

  for (const reserved of RESERVED_PARSED) {
    if (main !== reserved.main) continue;
    if (mods.length === reserved.mods.size && [...reserved.mods].every((mod) => mods.includes(mod))) {
      return `该组合被浏览器或系统快捷键占用（${reserved.label}），请换一个组合。`;
    }
  }
  return null;
};

/** 请求时监听一次 keydown 并返回组合键（用于录制），Esc 取消返回 null。 */
export const waitForKeyCombo = (): Promise<string | null> =>
  new Promise((resolve) => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        cleanup();
        resolve(null);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const combo = describeKeyEvent(event);
      if (combo) {
        cleanup();
        resolve(combo);
      }
    };
    const cleanup = (): void => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
    window.addEventListener('keydown', onKeyDown, true);
  });