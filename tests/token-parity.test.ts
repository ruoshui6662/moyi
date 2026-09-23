/**
 * 设计 token 一致性守护：
 *   1. overlayTokens.ts 是 tokens.css `--overlay-*` 组的 TS 镜像（Shadow DOM 无法引用 <link>），
 *      两处取值必须逐项一致——本测试是唯一的防漂移闸门；
 *   2. 页面不得再引入任何 CDN webfont（字体统一走本机开源字体栈）；
 *   3. 强调色锁定为 Apple 系统蓝（浅色 #007aff / 深色 #0a84ff）；
 *   4. options 页不得回退到被合并掉的历史层（蓝色参考稿 #1677ff、墨色阶 #252a31）。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OVERLAY_FONT_STACK, OVERLAY_TOKENS_CSS } from '../chrome-plugin/src/styles/overlayTokens';

const root = process.cwd();
const read = (relative: string): string => readFileSync(resolve(root, relative), 'utf8');

const tokensCss = read('chrome-plugin/src/styles/tokens.css');
const optionsHtml = read('chrome-plugin/src/entrypoints/options/index.html');
const popupHtml = read('chrome-plugin/src/entrypoints/popup/index.html');

/** 从 CSS 文本里抽取 `--name: value;` 形式的自定义属性。 */
const parseDeclarations = (css: string): Map<string, string> => {
  const result = new Map<string, string>();
  const pattern = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    result.set(match[1], match[2].trim());
  }
  return result;
};

describe('overlay token parity（tokens.css ↔ overlayTokens.ts）', () => {
  const fromCss = parseDeclarations(tokensCss);
  const fromTs = parseDeclarations(OVERLAY_TOKENS_CSS);

  it('overlayTokens.ts 至少声明了 overlay 组与动效档位', () => {
    expect(fromTs.has('--overlay-surface')).toBe(true);
    expect(fromTs.has('--overlay-success')).toBe(true);
    expect(fromTs.has('--duration-base')).toBe(true);
  });

  it('两处同名 token 取值逐一相等', () => {
    const shared = [...fromTs.keys()].filter((name) => fromCss.has(name));
    expect(shared.length).toBeGreaterThanOrEqual(6);
    for (const name of shared) {
      expect(fromTs.get(name), `${name} 在 tokens.css 与 overlayTokens.ts 不一致`).toBe(fromCss.get(name));
    }
  });

  it('overlay 字体栈为开源字体名且不含 URL', () => {
    expect(OVERLAY_FONT_STACK).toContain('Noto Sans SC');
    expect(OVERLAY_FONT_STACK).not.toMatch(/https?:/);
  });
});

describe('无 CDN webfont（字体全走本机栈）', () => {
  it.each([
    ['options', optionsHtml],
    ['popup', popupHtml],
  ])('%s 页不含任何 webfont CDN 引用', (_name, html) => {
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).not.toContain('fonts.gstatic.com');
    expect(html).not.toContain('cdn.jsdelivr.net');
    expect(html).not.toContain('lxgw-wenkai-webfont');
  });

  it('tokens.css 声明了开源字体优先的正文与题签字体栈', () => {
    expect(tokensCss).toContain('--font-body');
    expect(tokensCss).toContain('Noto Sans SC');
    expect(tokensCss).toContain('--font-display');
    expect(tokensCss).toContain('LXGW WenKai');
  });
});

describe('强调色合同（Apple 系统蓝）', () => {
  it('浅色为 #007aff、深色为 #0a84ff', () => {
    expect(tokensCss).toMatch(/--color-accent:\s*#007aff/i);
    expect(tokensCss).toMatch(/--color-accent:\s*#0a84ff/i);
  });

  it('强调色上的文字使用 --color-on-accent（不再写死白色导致暗色白底白字）', () => {
    expect(tokensCss).toMatch(/--color-on-accent:/);
  });
});

describe('options 样式层不回退到历史分层', () => {
  it('不再出现被合并掉的两代 accent', () => {
    expect(optionsHtml).not.toContain('#1677ff');
    expect(optionsHtml).not.toContain('#252a31');
  });

  it('不再出现死 token --serif 与四层 :root 叠加', () => {
    expect(optionsHtml).not.toContain('--serif');
    expect(optionsHtml.match(/:root\s*\{/g)?.length ?? 0).toBe(0);
  });
});
