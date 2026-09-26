import { beforeEach, describe, expect, it } from 'vitest';
import { buildElementSelector, MAX_SELECTOR_DEPTH } from '../chrome-plugin/src/utils/selectorGen';

const mount = (html: string): void => {
  document.body.innerHTML = html;
};

describe('buildElementSelector', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('唯一 id → #id', () => {
    mount('<div><p id="target">x</p></div>');
    const result = buildElementSelector(document.getElementById('target')!);
    expect(result.selector).toBe('#target');
    expect(result.unique).toBe(true);
  });

  it('id 非唯一或非法 → 不用 id', () => {
    mount('<div><b class="k" id="dup">1</b><b class="k" id="dup">2</b></div>');
    const result = buildElementSelector(document.querySelector('b')!);
    expect(result.selector).not.toContain('#dup');
    expect(result.unique).toBe(true);
  });

  it('自身 tag.classes 唯一 → 直接用', () => {
    mount('<section><p class="lead intro">a</p><p class="lead">b</p></section>');
    const result = buildElementSelector(document.querySelector('.intro')!);
    expect(result.selector).toBe('p.lead.intro');
    expect(result.unique).toBe(true);
  });

  it('class 重复 → 向上拼路径/nth 兜底，结果唯一定位原元素', () => {
    mount(`
      <main class="wrap">
        <div class="row"><span class="cell">a</span><span class="cell">b</span></div>
        <div class="row"><span class="cell">c</span></div>
      </main>`);
    const target = document.querySelectorAll('.cell')[2]!;
    const result = buildElementSelector(target);
    expect(result.unique).toBe(true);
    // 真正的契约：选择器必须回指原元素
    expect(document.querySelector(result.selector)).toBe(target);
    expect(result.selector.split(' > ').length).toBeLessThanOrEqual(MAX_SELECTOR_DEPTH + 1);
  });

  it('哈希类名被跳过（CSS-in-JS 产物不稳定）', () => {
    mount('<div class="css-1x2y3z"><p class="sc-bdVaJa title">t</p></div>');
    const result = buildElementSelector(document.querySelector('.title')!);
    expect(result.selector).not.toContain('sc-bdVaJa');
  });

  it('简报含 tag 与 id/class 供确认', () => {
    mount('<div><p id="q" class="a b">x</p></div>');
    const result = buildElementSelector(document.getElementById('q')!);
    expect(result.label).toBe('p#q.a.b');
  });

  it('两条同构深分支：深度上限内无法唯一定位 → 标记 unique=false 交 UI 提示', () => {
    const deep = (leaf: string): string => {
      let html = '<div>';
      for (let i = 0; i < 9; i += 1) html += '<div>';
      html += `<span class="leaf">${leaf}</span>`;
      for (let i = 0; i < 10; i += 1) html += '</div>';
      return html;
    };
    mount(`<section>${deep('a')}${deep('b')}</section>`);
    const target = document.querySelectorAll('.leaf')[0]!;
    const result = buildElementSelector(target);
    expect(result.unique).toBe(false);
    expect(result.selector.length).toBeGreaterThan(0);
  });
});
