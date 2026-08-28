import { describe, expect, it } from 'vitest';
import {
  describeKeyEvent,
  formatShortcut,
  validateShortcut,
} from '../chrome-plugin/src/utils/shortcuts';
import { sanitizeShortcut } from '../chrome-plugin/src/utils/config';

describe('describeKeyEvent', () => {
  it('combines modifiers in fixed order and uppercases the key', () => {
    expect(describeKeyEvent({ key: 'k', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe('Control+Shift+K');
    expect(describeKeyEvent({ key: '5', ctrlKey: false, metaKey: false, altKey: true, shiftKey: false })).toBe('Alt+5');
    expect(describeKeyEvent({ key: 'K', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe('Control+K');
  });

  it('maps space and arrow keys to stable names', () => {
    expect(describeKeyEvent({ key: ' ', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe('Control+Space');
    expect(describeKeyEvent({ key: 'ArrowUp', ctrlKey: false, metaKey: false, altKey: true, shiftKey: false })).toBe('Alt+ArrowUp');
    expect(describeKeyEvent({ key: 'F5', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe('Control+F5');
  });

  it('ignores pure modifier presses and unsupported punctuation', () => {
    expect(describeKeyEvent({ key: 'Shift', ctrlKey: false, metaKey: false, altKey: false, shiftKey: true })).toBeNull();
    expect(describeKeyEvent({ key: 'Control', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBeNull();
    expect(describeKeyEvent({ key: '?', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBeNull();
  });
});

describe('validateShortcut', () => {
  it('requires a strong modifier (Control/Meta/Alt)', () => {
    expect(validateShortcut('Shift+K')).toMatch(/Ctrl|⌘|Alt/);
    expect(validateShortcut('A')).toMatch(/主键|Ctrl/);
  });

  it('rejects browser-reserved combinations', () => {
    expect(validateShortcut('Control+T')).toMatch(/浏览器或系统快捷键占用/);
    expect(validateShortcut('Control+Shift+T')).toMatch(/浏览器或系统快捷键占用/);
    expect(validateShortcut('Control+R')).toMatch(/浏览器或系统快捷键占用/);
    expect(validateShortcut('Control+W')).toMatch(/浏览器或系统快捷键占用/);
    expect(validateShortcut('Alt+F4')).toMatch(/浏览器或系统快捷键占用/);
  });

  it('rejects unbounded keys like F5 either way', () => {
    // 无修饰组合先被「必须含修饰键」拦截；带修饰的保留组合命中原保留检测
    expect(validateShortcut('F5')).toMatch(/请包含 Ctrl/);
    expect(validateShortcut('Control+F5')).toMatch(/浏览器或系统快捷键占用/);
  });

  it('accepts usable combinations', () => {
    expect(validateShortcut('Control+Shift+K')).toBeNull();
    expect(validateShortcut('Alt+Shift+T')).toBeNull();
    expect(validateShortcut('Control+Alt+D')).toBeNull();
    expect(validateShortcut('Meta+Shift+Enter')).toBeNull();
  });
});

describe('formatShortcut', () => {
  it('renders platform-aware symbols', () => {
    expect(formatShortcut('Control+Shift+K', true)).toBe('⌃ ⇧ K');
    expect(formatShortcut('Control+Shift+K', false)).toBe('Ctrl ⇧ K');
    expect(formatShortcut('Meta+Alt+ArrowUp', true)).toBe('⌘ ⌥ ↑');
    expect(formatShortcut('')).toBe('未设置');
  });
});

describe('sanitizeShortcut', () => {
  it('keeps valid combos and blanks everything else', () => {
    expect(sanitizeShortcut('Control+Shift+K')).toBe('Control+Shift+K');
    expect(sanitizeShortcut('  Alt + T ')).toBe('Alt+T');
    expect(sanitizeShortcut('T')).toBe('');
    expect(sanitizeShortcut(undefined)).toBe('');
    expect(sanitizeShortcut(42)).toBe('');
    expect(sanitizeShortcut('')).toBe('');
  });
});