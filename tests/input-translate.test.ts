import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INPUT_TRANSLATE_HOST_ID,
  captureInputText,
  editableFromEvent,
  getInputTranslateShadowForTest,
  insertTranslation,
  mountInputTranslateOverlay,
  stripParagraphTags,
} from '../chrome-plugin/src/entrypoints/content/inputTranslate';

describe('captureInputText', () => {
  it('prefers the selected slice and records its boundaries', () => {
    const textarea = document.createElement('textarea');
    textarea.value = 'hello brave world';
    textarea.setSelectionRange(6, 11);
    expect(captureInputText(textarea)).toEqual({ text: 'brave', start: 6, end: 11 });
  });

  it('falls back to the whole draft when nothing is selected', () => {
    const input = document.createElement('input');
    input.value = '  full draft  ';
    input.setSelectionRange(12, 12);
    // 无选区 → 翻译整篇；回填点落在原始 value 末尾（12 + 尾随空白中的位置），
    // 保证译文追加在用户最后输入之后
    expect(captureInputText(input)).toEqual({ text: 'full draft', start: 14, end: 14 });
  });
});

describe('stripParagraphTags', () => {
  it('removes the output-contract tags from streaming fragments', () => {
    expect(stripParagraphTags('<paragraph_1>你好世')).toBe('你好世');
    expect(stripParagraphTags('你好世界</paragraph_1>')).toBe('你好世界');
    expect(stripParagraphTags('no tags here')).toBe('no tags here');
  });
});

describe('insertTranslation', () => {
  afterEach(() => {
    document.body.textContent = '';
  });

  it('writes into textarea/input at the given range and fires input for React', () => {
    const textarea = document.createElement('textarea');
    textarea.value = 'hello world';
    textarea.setSelectionRange(0, 5);
    document.body.append(textarea);
    const onInput = vi.fn();
    textarea.addEventListener('input', onInput);

    expect(insertTranslation(textarea, '你好', 0, 5)).toBe(true);
    expect(textarea.value).toBe('你好 world');
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it('appends when no explicit range is given', () => {
    const input = document.createElement('input');
    input.value = 'note';
    input.setSelectionRange(4, 4);
    document.body.append(input);

    expect(insertTranslation(input, '：译文')).toBe(true);
    expect(input.value).toBe('note：译文');
  });

  it('inserts into contenteditable via execCommand, falling back to Range', () => {
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const text = document.createTextNode('hello');
    editor.append(text);
    document.body.append(editor);
    document.execCommand = vi.fn().mockReturnValue(false);
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(insertTranslation(editor, '你好')).toBe(true);
    expect(editor.textContent).toBe('你好');
  });

  it('refuses non-editable targets', () => {
    const div = document.createElement('div');
    expect(insertTranslation(div, 'x')).toBe(false);
  });
});

describe('editableFromEvent', () => {
  it('accepts text inputs, textareas and contenteditable; rejects the rest', () => {
    const input = document.createElement('input');
    input.type = 'text';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const paragraph = document.createElement('p');
    expect(editableFromEvent(input)).toBe(input);
    expect(editableFromEvent(editor)).toBe(editor);
    expect(editableFromEvent(checkbox)).toBeNull();
    expect(editableFromEvent(paragraph)).toBeNull();
    expect(editableFromEvent(null)).toBeNull();
  });
});

describe('input translate overlay', () => {
  const shadowOf = (): ShadowRoot => getInputTranslateShadowForTest(
    document.getElementById(INPUT_TRANSLATE_HOST_ID) as HTMLElement,
  )!;

  afterEach(() => {
    document.getElementById(INPUT_TRANSLATE_HOST_ID)?.remove();
  });

  it('流式展示剥标签；「替换」仅在非空结果后可用，点击回填并自动收起', () => {
    const onInsert = vi.fn();
    const overlay = mountInputTranslateOverlay({ onInsert });
    overlay.open('hello', { top: 100, bottom: 130, left: 40 });
    const target = shadowOf().querySelector<HTMLElement>('.target')!;
    const insertButton = shadowOf().querySelector<HTMLButtonElement>('.insert')!;
    expect(overlay.isOpen()).toBe(true);
    expect(insertButton.disabled).toBe(true);

    overlay.appendDelta('<paragraph_1>你');
    expect(target.textContent).toBe('你');
    overlay.appendDelta('<paragraph_1>你好世界');
    expect(target.textContent).toBe('你好世界');
    expect(target.classList.contains('streaming')).toBe(true);
    expect(insertButton.disabled).toBe(true);

    overlay.finish('  <paragraph_1>你好世界</paragraph_1>  ');
    expect(target.classList.contains('streaming')).toBe(false);
    expect(target.textContent).toBe('你好世界');
    expect(insertButton.disabled).toBe(false);

    insertButton.click();
    expect(onInsert).toHaveBeenCalledWith('你好世界');
    expect(overlay.isOpen()).toBe(false);
    overlay.destroy();
    expect(document.getElementById(INPUT_TRANSLATE_HOST_ID)).toBeNull();
  });

  it('空译文不开放替换；错误态不遮挡回填入口', () => {
    const overlay = mountInputTranslateOverlay({ onInsert: vi.fn() });
    overlay.open('hello', { top: 10, bottom: 40, left: 10 });
    overlay.finish('   ');
    expect(shadowOf().querySelector<HTMLButtonElement>('.insert')!.disabled).toBe(true);
    overlay.showError('翻译服务请求失败 (500)');
    expect(shadowOf().querySelector<HTMLElement>('.status')!.textContent).toContain('500');
    expect(shadowOf().querySelector<HTMLElement>('.target')!.classList.contains('streaming')).toBe(false);
    overlay.destroy();
  });

  it('closes on Escape and blocks a second mount on the same page', () => {
    const overlay = mountInputTranslateOverlay({ onInsert: vi.fn() });
    overlay.open('hello', { top: 10, bottom: 40, left: 10 });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(overlay.isOpen()).toBe(false);
    expect(() => mountInputTranslateOverlay({ onInsert: vi.fn() })).toThrow(INPUT_TRANSLATE_HOST_ID);
    overlay.destroy();
  });
});
