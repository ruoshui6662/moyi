import { describe, expect, it } from 'vitest';
import { createTagStreamParser } from '../chrome-plugin/src/service/common';

describe('tag stream parser', () => {
  it('emits partial while open and completed when closing tag arrives across chunks', () => {
    const parser = createTagStreamParser(2);

    const first = parser.push('<paragraph_1>你好');
    expect(first).toEqual([{ partial: { index: 0, text: '你好' } }]);

    const second = parser.push('世界</paragraph_1>');
    expect(second).toEqual([{ completed: { index: 0, text: '你好世界' } }]);

    const third = parser.push('<paragraph_2>再见</paragraph_2>');
    expect(third).toEqual([{ completed: { index: 1, text: '再见' } }]);

    expect(parser.getCompletedCount()).toBe(2);
  });

  it('handles a single chunk containing multiple complete tags', () => {
    const parser = createTagStreamParser(2);
    const events = parser.push('<paragraph_1>甲</paragraph_1><paragraph_2>乙</paragraph_2>');
    expect(events).toContainEqual({ completed: { index: 0, text: '甲' } });
    expect(events).toContainEqual({ completed: { index: 1, text: '乙' } });
    expect(parser.getCompletedCount()).toBe(2);
  });

  it('strips a dangling partial tag fragment at the buffer end', () => {
    const parser = createTagStreamParser(2);
    const events = parser.push('<paragraph_1>文本<paragraph_');
    expect(events).toEqual([{ partial: { index: 0, text: '文本' } }]);
  });

  it('does not re-emit completed paragraphs on later pushes', () => {
    const parser = createTagStreamParser(1);
    parser.push('<paragraph_1>完成</paragraph_1>');
    expect(parser.push('后续无关内容')).toEqual([]);
    expect(parser.getCompletedCount()).toBe(1);
  });

  it('ignores preamble text outside tags', () => {
    const parser = createTagStreamParser(1);
    const events = parser.push('以下是翻译：\n<paragraph_1>你好</paragraph_1>');
    expect(events).toEqual([{ completed: { index: 0, text: '你好' } }]);
  });

  it('reports zero completed when output has no tags at all', () => {
    const parser = createTagStreamParser(3);
    parser.push('完全不符合格式的输出');
    parser.push('继续乱输出');
    expect(parser.getCompletedCount()).toBe(0);
  });

  it('emits partial for the in-flight paragraph only', () => {
    const parser = createTagStreamParser(3);
    const events = parser.push('<paragraph_1>一</paragraph_1><paragraph_2>二');
    const partials = events.filter((event) => event.partial);
    expect(partials).toEqual([{ partial: { index: 1, text: '二' } }]);
  });
});
