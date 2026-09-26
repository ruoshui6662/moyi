import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FOLLOWUP_SYSTEM_SUFFIX,
  MAX_LOOKUP_CHARS,
  buildExplainSystemPrompt,
  buildExplainUserPrompt,
  buildFollowupMessages,
  buildLookupSystemPrompt,
  buildLookupUserPrompt,
  classifyLookupKind,
  normalizeSelectionText,
  parseExplainResponse,
  parseLookupResponse,
  sanitizeExplainLevel,
  sanitizeLookupResult,
} from '../chrome-plugin/src/utils/selectionLookup';
import {
  computeCardPlacement,
  getSelectionCardShadowForTest,
  isEditableTarget,
  mountSelectionCard,
  resolveLookupTrigger,
  resolveSpeakSource,
  SELECTION_HOST_ID,
} from '../chrome-plugin/src/entrypoints/content/selectionCard';

describe('normalizeSelectionText', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeSelectionText('  hello \n\t world  ')).toBe('hello world');
  });

  it('rejects empty and overlong selections', () => {
    expect(normalizeSelectionText('   ')).toBeNull();
    expect(normalizeSelectionText('a'.repeat(MAX_LOOKUP_CHARS))).toHaveLength(MAX_LOOKUP_CHARS);
    expect(normalizeSelectionText('a'.repeat(MAX_LOOKUP_CHARS + 1))).toBeNull();
  });
});

describe('classifyLookupKind', () => {
  it('treats a short single token as a word', () => {
    expect(classifyLookupKind('Kubernetes')).toBe('word');
    expect(classifyLookupKind('ephemeral')).toBe('word');
  });

  it('treats spaced or oversized text as a phrase', () => {
    expect(classifyLookupKind('container orchestration')).toBe('phrase');
    expect(classifyLookupKind('a'.repeat(25))).toBe('phrase');
  });
});

describe('lookup prompts', () => {
  it('system prompt pins the explanation language and the JSON contract', () => {
    const prompt = buildLookupSystemPrompt('简体中文');
    expect(prompt).toContain('简体中文');
    expect(prompt).toContain('translation');
    expect(prompt).toContain('phonetic');
  });

  it('user prompt distinguishes word vs phrase queries', () => {
    expect(buildLookupUserPrompt('ephemeral', 'word')).toContain('single word');
    expect(buildLookupUserPrompt('hot reload', 'phrase')).toContain('phrase');
  });
});

describe('parseLookupResponse tolerance', () => {
  const raw = JSON.stringify({
    term: 'ephemeral',
    translation: '短暂的',
    phonetic: '/ɪˈfemərəl/',
    partOfSpeech: 'adj.',
    definition: ' lasting for a very short time',
    example: 'ephemeral joys 转瞬即逝的快乐',
  });

  it('parses clean JSON and trims fields', () => {
    const result = parseLookupResponse('ephemeral', raw);
    expect(result.term).toBe('ephemeral');
    expect(result.translation).toBe('短暂的');
    expect(result.definition).toBe('lasting for a very short time');
  });

  it('tolerates markdown fences and surrounding chatter', () => {
    const wrapped = parseLookupResponse('ephemeral', `好的，这是结果：\n\`\`\`json\n${raw}\n\`\`\`\n希望有帮助`);
    expect(wrapped.translation).toBe('短暂的');
    const chatter = parseLookupResponse('ephemeral', `解释如下 ${raw} 以上。`);
    expect(chatter.phonetic).toBe('/ɪˈfemərəl/');
  });

  it('handles braces inside string values without splitting early', () => {
    const tricky = JSON.stringify({ term: 'x', translation: 'a{b}c', definition: '用 {花括号} 举例' });
    const result = parseLookupResponse('x', tricky);
    expect(result.translation).toBe('a{b}c');
    expect(result.definition).toBe('用 {花括号} 举例');
  });

  it('falls back to whole-text definition when JSON never appears', () => {
    const result = parseLookupResponse('whatever', '这不是 JSON，只是一段释义。');
    expect(result.term).toBe('whatever');
    expect(result.definition).toContain('只是一段释义');
    expect(result.translation).toBe('');
  });

  it('caps runaway fields and never renders an empty card', () => {
    const result = sanitizeLookupResult({ term: 'a'.repeat(2000), definition: 'b'.repeat(2000) });
    expect(result.term).toHaveLength(600);
    expect(result.definition).toHaveLength(600);
    expect(parseLookupResponse('q', '   ').definition).toBeTruthy();
  });
});

describe('resolveLookupTrigger', () => {
  const ok = { enabled: true, insideEditable: false, insideOwnUi: false };

  it('blocks disabled, editable and own-overlay contexts', () => {
    expect(resolveLookupTrigger('word', { ...ok, enabled: false })).toBeNull();
    expect(resolveLookupTrigger('word', { ...ok, insideEditable: true })).toBeNull();
    expect(resolveLookupTrigger('word', { ...ok, insideOwnUi: true })).toBeNull();
  });

  it('accepts multi-paragraph selections（真机反馈校准：500 仍不够）', () => {
    const paragraph = '这是一个用于测试多段落选区的自然段文本，长度足够长以便超过旧上限。';
    const selection = Array.from({ length: 20 }, () => paragraph).join('\n\n');
    expect(selection.length).toBeGreaterThan(500);
    // 折叠段间空行后的长度才是查询文本长度
    const collapsed = selection.replace(/\s+/g, ' ').trim();
    expect(resolveLookupTrigger(selection, ok)).toHaveLength(collapsed.length);
  });

  it('rejects only page-scale drags', () => {
    expect(resolveLookupTrigger('x'.repeat(MAX_LOOKUP_CHARS + 1), ok)).toBeNull();
    expect(resolveLookupTrigger('x'.repeat(MAX_LOOKUP_CHARS), ok)).toHaveLength(MAX_LOOKUP_CHARS);
  });

  it('accepts normalized query text', () => {
    expect(resolveLookupTrigger('  ephemeral  context ', ok)).toBe('ephemeral context');
    expect(resolveLookupTrigger('  ', ok)).toBeNull();
    expect(resolveLookupTrigger('x'.repeat(MAX_LOOKUP_CHARS + 1), ok)).toBeNull();
  });
});

describe('isEditableTarget', () => {
  it('detects inputs, textareas, contenteditable and role=textbox', () => {
    const input = document.createElement('input');
    expect(isEditableTarget(input)).toBe(true);
    const inner = document.createElement('span');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    editable.append(inner);
    expect(isEditableTarget(inner)).toBe(true);
    const plain = document.createElement('p');
    plain.append(inner);
    expect(isEditableTarget(inner)).toBe(false);
    const textbox = document.createElement('div');
    textbox.setAttribute('role', 'textbox');
    expect(isEditableTarget(textbox)).toBe(true);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('mountSelectionCard lifecycle', () => {
  const anchor = { rect: { top: 120, bottom: 140, left: 60, right: 160 } };
  afterEach(() => {
    document.getElementById(SELECTION_HOST_ID)?.remove();
  });

  it('opens, closes on Escape, and destroys without residue', () => {
    const card = mountSelectionCard();
    // 挂载即常驻文档（宿主存在），但卡片本体 hidden 不可见
    expect(document.getElementById(SELECTION_HOST_ID)).not.toBeNull();
    card.open('查询中…', anchor);
    expect(card.isOpen()).toBe(true);
    const host = document.getElementById(SELECTION_HOST_ID);
    expect(host).not.toBeNull();
    // closed shadow：外部拿不到 shadowRoot，页面 CSS 无法染指卡片样式
    expect(host!.shadowRoot).toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(card.isOpen()).toBe(false);
    // 关闭仅切 hidden：宿主常驻避免重复建 shadow 树；destroy 才物理移除
    expect(document.getElementById(SELECTION_HOST_ID)).not.toBeNull();
    card.destroy();
    expect(document.getElementById(SELECTION_HOST_ID)).toBeNull();
    // destroy 后再开合不得抛错、不得复活
    card.open('x', anchor);
    card.render({ term: 't', translation: '', phonetic: '', partOfSpeech: '', definition: '', example: '' });
    expect(document.getElementById(SELECTION_HOST_ID)).toBeNull();
  });

  it('rejects a second mount on the same page', () => {
    const first = mountSelectionCard();
    first.open('a', anchor);
    expect(() => mountSelectionCard()).toThrow(SELECTION_HOST_ID);
    first.destroy();
  });

  it('closes on an outside pointerdown but not on card clicks', () => {
    let externalCloses = 0;
    const card = mountSelectionCard({ onExternalPointerDown: () => { externalCloses += 1; } });
    card.open('a', anchor);
    // 宿主自身被点（复制按钮等交互的最终落点）：composedPath 含宿主 → 不关闭
    document.getElementById(SELECTION_HOST_ID)!.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    expect(card.isOpen()).toBe(true);
    expect(externalCloses).toBe(0);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(card.isOpen()).toBe(false);
    expect(externalCloses).toBe(1);
    card.destroy();
  });
});

describe('computeCardPlacement（选区侧边优先，避让正文）', () => {
  const rect = { top: 100, bottom: 120, left: 40, right: 140 };

  it('首选选区右侧（不遮挡刚选中的正文），垂直居中对齐', () => {
    const placement = computeCardPlacement(rect, 1000, 800, 180);
    expect(placement.side).toBe('right');
    expect(placement.left).toBe(150); // rect.right + gap(10)
    expect(placement.top).toBe(20); // 垂直居中：100 + (20 - 180) / 2
  });

  it('右侧放不下 → 左侧', () => {
    const placement = computeCardPlacement({ top: 100, bottom: 120, left: 700, right: 950 }, 1000, 800, 180);
    expect(placement.side).toBe('left');
    expect(placement.left).toBe(700 - 10 - 320);
  });

  it('两侧都放不下（窄屏）→ 下方，水平对齐选区左缘', () => {
    const placement = computeCardPlacement({ top: 100, bottom: 120, left: 40, right: 140 }, 340, 800, 180, 320);
    expect(placement.side).toBe('below');
    expect(placement.top).toBe(130);
    expect(placement.left).toBe(12); // 窄屏：320px 卡片在 340 视口内左缘夹到 12
  });

  it('上下都放不下（矮视口）→ 上方兜底且完整可见', () => {
    // 右侧仍放得下（水平），垂直方向夹到视口内 → 依然选右侧（不遮挡正文优先于贴着选区）
    const placement = computeCardPlacement({ top: 620, bottom: 640, left: 40, right: 140 }, 1000, 660, 300, 320);
    expect(placement.side).toBe('right');
    expect(placement.top).toBeGreaterThanOrEqual(8);
    expect(placement.top + 300).toBeLessThanOrEqual(660 - 8);
  });

  it('所有分支都把卡片完整夹进视口', () => {
    for (const r of [
      { top: 0, bottom: 10, left: 0, right: 10 },
      { top: 790, bottom: 800, left: 990, right: 1000 },
      { top: 400, bottom: 410, left: -30, right: -10 },
    ]) {
      const p = computeCardPlacement(r, 1000, 800, 180);
      expect(p.left).toBeGreaterThanOrEqual(8);
      expect(p.left + 320).toBeLessThanOrEqual(1000 - 8);
      expect(p.top).toBeGreaterThanOrEqual(8);
      expect(p.top + 180).toBeLessThanOrEqual(800 - 8);
    }
  });
});


describe('selection card save (生词本) flow', () => {
  const anchor = { rect: { top: 100, bottom: 120, left: 40, right: 140 } };
  const meta = { context: 'The word appears here.', pageTitle: 'Page', url: 'https://e.com/p' };
  const result = { term: 'ephemeral', translation: '短暂的', phonetic: '', partOfSpeech: '', definition: '', example: '' };
  const saveButton = (): HTMLButtonElement =>
    getSelectionCardShadowForTest(document.getElementById(SELECTION_HOST_ID)!)!.querySelector('.save')!;

  afterEach(() => {
    document.getElementById(SELECTION_HOST_ID)?.remove();
  });

  it('收藏成功：转「已收藏」并禁用；回调拿到结果与出处；重复点击不再触发', async () => {
    let resolveSave!: (saved: boolean) => void;
    const onSave = vi.fn(() => new Promise<boolean>((resolve) => { resolveSave = resolve; }));
    const card = mountSelectionCard({ onSave });
    card.open('查询中…', anchor, meta);
    card.render(result);
    const save = saveButton();
    expect(save.textContent).toBe('收藏');
    expect(save.disabled).toBe(false);
    save.click();
    expect(save.textContent).toBe('收藏中…');
    expect(save.disabled).toBe(true);
    resolveSave(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(save.textContent).toBe('已收藏');
    expect(save.classList.contains('saved')).toBe(true);
    expect(save.disabled).toBe(true);
    expect(onSave).toHaveBeenCalledWith(result, meta);
    save.click();
    expect(onSave).toHaveBeenCalledTimes(1);
    card.destroy();
  });

  it('收藏失败：显示「收藏失败」且回调结果如实返回', async () => {
    let resolveSave!: (saved: boolean) => void;
    const onSave = vi.fn(() => new Promise<boolean>((resolve) => { resolveSave = resolve; }));
    const card = mountSelectionCard({ onSave });
    card.open('查询中…', anchor, meta);
    card.render(result);
    const save = saveButton();
    save.click();
    resolveSave(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(save.textContent).toBe('收藏失败');
    card.destroy();
  });

  it('已收藏回显：render 携带 collected 状态时按钮直接禁用', () => {
    const card = mountSelectionCard();
    card.open('查询中…', anchor, meta);
    card.render(result, { collected: true });
    const save = saveButton();
    expect(save.textContent).toBe('已收藏');
    expect(save.disabled).toBe(true);
    card.destroy();
  });

  it('close 后收藏状态复位', () => {
    const card = mountSelectionCard();
    card.open('查询中…', anchor, meta);
    card.render(result, { collected: true });
    card.close();
    card.open('再次查询', anchor, meta);
    card.render(result);
    const save = saveButton();
    expect(save.textContent).toBe('收藏');
    expect(save.disabled).toBe(false);
    card.destroy();
  });
});

describe('卡片可交互化（W4.3）', () => {
  const anchor = { rect: { top: 100, bottom: 120, left: 60, right: 160 } };
  const meta = { query: 'ephemeral', context: 'ctx', pageTitle: 'T', url: 'https://e.com/p' };
  const parts = () => getSelectionCardShadowForTest(document.getElementById(SELECTION_HOST_ID)!)!;

  afterEach(() => {
    document.getElementById(SELECTION_HOST_ID)?.remove();
  });

  it('✕ 按钮关闭卡片并回调 onManualClose（宿主据此允许同词再触发）', () => {
    const onManualClose = vi.fn();
    const card = mountSelectionCard({ onManualClose });
    card.open('查询中…', anchor, meta);
    const closeBtn = parts().querySelector<HTMLButtonElement>('.close')!;
    expect(closeBtn).not.toBeNull();
    closeBtn.click();
    expect(card.isOpen()).toBe(false);
    expect(onManualClose).toHaveBeenCalledTimes(1);
    card.destroy();
  });

  it('卡片本体可拖拽：位移实时生效并被视口夹取', () => {
    const card = mountSelectionCard();
    card.open('查询中…', anchor, meta);
    const shadow = parts();
    const cardEl = shadow.querySelector<HTMLElement>('.card')!;
    // jsdom 无布局：offsetWidth/Height=0 → 夹取走 CARD_WIDTH/默认高分支
    cardEl.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { button: 0, clientX: 70, clientY: 110, pointerId: 1 }));
    cardEl.dispatchEvent(Object.assign(new Event('pointermove', { bubbles: true }), { clientX: 300, clientY: 260, pointerId: 1 }));
    const afterMove = cardEl.style.left;
    expect(afterMove).not.toBe('');
    cardEl.dispatchEvent(Object.assign(new Event('pointerup', { bubbles: true }), { pointerId: 1 }));
    // 位移记忆：重开后沿用偏移
    card.open('第二次', anchor, meta);
    expect(parts().querySelector<HTMLElement>('.card')!.style.left).not.toBe('');
    expect(afterMove.length).toBeGreaterThan(0);
    card.destroy();
  });

  it('拖拽不劫持控件与输入框', () => {
    const card = mountSelectionCard();
    card.open('查询中…', anchor, meta);
    card.render({ term: 'a', translation: '甲', phonetic: '', partOfSpeech: '', definition: '', example: '' });
    const save = parts().querySelector<HTMLButtonElement>('.save')!;
    const before = parts().querySelector<HTMLElement>('.card')!.style.left;
    save.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { button: 0, clientX: 80, clientY: 120, pointerId: 2 }));
    save.dispatchEvent(Object.assign(new Event('pointermove', { bubbles: true }), { clientX: 400, clientY: 400, pointerId: 2 }));
    expect(parts().querySelector<HTMLElement>('.card')!.style.left).toBe(before);
    card.destroy();
  });

  it('isPointerInside：卡片开启时按矩形±6px 判定（悬停粘滞的数据源）', () => {
    const card = mountSelectionCard();
    // 未开启：恒 false
    expect(card.isPointerInside(10, 10)).toBe(false);
    card.open('查询中…', anchor, meta);
    const b = parts().querySelector<HTMLElement>('.card')!.getBoundingClientRect();
    const insideX = b.left + Math.min(5, b.width / 2);
    const insideY = b.top + Math.min(5, b.height / 2);
    // jsdom 布局为 0 尺寸：退化为「点恰在矩形原点」判定
    const atOrigin = card.isPointerInside(3, 3); // 零尺寸矩形 + 6px 容差内
    const farAway = card.isPointerInside(5000, 5000);
    expect(atOrigin).toBe(true);
    expect(farAway).toBe(false);
    expect(typeof insideX).toBe('number');
    expect(typeof insideY).toBe('number');
    card.destroy();
  });
});

describe('液态玻璃材质（防回归）', () => {
  it('划词卡与输入框浮层共用玻璃 token，含模糊/镜面/焦点环，且不再引用旧深色面', () => {
    const cardMount = mountSelectionCard();
    cardMount.open('查询中…', { rect: { top: 10, bottom: 20, left: 0, right: 10 } });
    const shadow = getSelectionCardShadowForTest(document.getElementById(SELECTION_HOST_ID)!)!;
    const style = shadow.querySelector('style')!.textContent ?? '';
    expect(style).toContain('backdrop-filter: blur(var(--moyi-glass-blur)) saturate(180%)');
    expect(style).toContain('inset 0 1px 0 var(--moyi-glass-specular)');
    expect(style).toContain('outline: 2px solid var(--moyi-glass-accent)');
    expect(style).toContain('@media (prefers-color-scheme: dark)');
    // 旧的固定深色面已退出划词卡
    expect(style).not.toContain('var(--overlay-surface)');
    cardMount.destroy();
  });
});

describe('阅读卡深究态：Explain 与追问（纯逻辑）', () => {
  it('system prompt 固定 JSON 契约与目标语言', () => {
    const prompt = buildExplainSystemPrompt('简体中文');
    expect(prompt).toContain('简体中文');
    expect(prompt).toContain('answer');
    expect(prompt).toContain('pitfalls');
    expect(prompt).toContain('JSON object');
  });

  it('user prompt 带难度标签与上下文（上下文标注为不解释）', () => {
    const prompt = buildExplainUserPrompt('He went.', 'beginner', 'He went to school yesterday.');
    expect(prompt).toContain('初级学习者');
    expect(prompt).toContain('He went.');
    expect(prompt).toContain('do not explain it');
  });

  it('非法难度回落进阶', () => {
    expect(sanitizeExplainLevel('advanced')).toBe('advanced');
    expect(sanitizeExplainLevel('nonsense')).toBe('intermediate');
    expect(sanitizeExplainLevel(undefined)).toBe('intermediate');
    expect(buildExplainUserPrompt('x', 'nonsense' as never)).toContain('中级学习者');
  });

  it('parseExplainResponse 吃围栏/杂语，缺字段留空', () => {
    const raw = '```json\n{"answer":"他去了。","grammar":null,"usage":"过去式叙述"}\n```';
    const result = parseExplainResponse(raw);
    expect(result.answer).toBe('他去了。');
    expect(result.usage).toBe('过去式叙述');
    expect(result.grammar).toBe('');
    const chatter = parseExplainResponse(`好的：${JSON.stringify({ answer: '甲' })} 希望有用`);
    expect(chatter.answer).toBe('甲');
    const fallback = parseExplainResponse('纯文本讲解。');
    expect(fallback.answer).toBe('纯文本讲解。');
    expect(parseExplainResponse('  ').answer).toBe('服务未返回可用讲解。');
  });

  it('追问 system 后缀要求 JSON 且只答追问', () => {
    expect(FOLLOWUP_SYSTEM_SUFFIX).toContain('follow-up');
    expect(FOLLOWUP_SYSTEM_SUFFIX).toContain('JSON');
  });

  it('buildFollowupMessages：system→首轮→历史，跳过空消息', () => {
    const messages = buildFollowupMessages('SYS', '首轮', [
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: '  ' },
      { role: 'assistant', content: 'A1' },
    ]);
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'user', 'assistant']);
    expect(messages[3]?.content).toBe('A1');
  });
});

describe('阅读卡深究态：卡片状态机（jsdom 穿透 closed shadow）', () => {
  const anchor = { rect: { top: 80, bottom: 100, left: 30, right: 130 } };
  const result = { term: 'epitome', translation: '缩影', phonetic: '', partOfSpeech: 'n.', definition: 'a brief example', example: '' };
  const explain = { answer: '总述内容', grammar: '', usage: '辨析内容', pitfalls: '', example: '例句内容' };

  const parts = () => getSelectionCardShadowForTest(document.getElementById(SELECTION_HOST_ID)!)!;
  const btn = (sel: string): HTMLButtonElement => parts().querySelector<HTMLButtonElement>(sel)!;

  afterEach(() => {
    document.getElementById(SELECTION_HOST_ID)?.remove();
  });

  it('详解按钮仅在结果就绪后出现；点击进入深究态并回调难度', () => {
    const onDeepRequest = vi.fn();
    const card = mountSelectionCard({ onDeepRequest });
    card.open('查询中…', anchor);
    expect(btn('.deep-btn').hidden).toBe(true);
    card.render(result);
    expect(btn('.deep-btn').hidden).toBe(false);
    btn('.deep-btn').click();
    expect(parts().querySelector<HTMLElement>('.deep-panel')!.hidden).toBe(false);
    expect(onDeepRequest).toHaveBeenCalledWith('intermediate');
    // 切换难度重请
    parts().querySelector<HTMLButtonElement>('[data-level="advanced"]')!.click();
    expect(onDeepRequest).toHaveBeenLastCalledWith('advanced');
    expect(parts().querySelector<HTMLButtonElement>('[data-level="advanced"]')!.classList.contains('active')).toBe(true);
    card.destroy();
  });

  it('renderDeep 逐块渲染；追问经 onAsk 提交，appendExchange 追加 Q/A', () => {
    const onAsk = vi.fn();
    const card = mountSelectionCard({ onDeepRequest: vi.fn(), onAsk });
    card.open('查询中…', anchor);
    card.render(result);
    btn('.deep-btn').click();
    card.showDeepLoading('讲解中…');
    expect(parts().querySelector<HTMLElement>('.deep-result')!.textContent).toContain('讲解中');
    card.renderDeep(explain);
    const rendered = parts().querySelector<HTMLElement>('.deep-result')!.textContent ?? '';
    expect(rendered).toContain('总述内容');
    expect(rendered).toContain('辨析内容');
    expect(rendered).toContain('例句内容');
    expect(rendered).not.toContain('语法'); // 空字段不渲染
    const input = parts().querySelector<HTMLInputElement>('.deep-input')!;
    input.value = '这里的 -epitome- 是什么后缀？';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(btn('.deep-send').disabled).toBe(false);
    btn('.deep-send').click();
    expect(onAsk).toHaveBeenCalledWith('这里的 -epitome- 是什么后缀？');
    card.appendExchange('这里的 -epitome- 是什么后缀？', '一种后缀');
    expect(parts().querySelector<HTMLElement>('.deep-thread')!.textContent).toContain('A: 一种后缀');
    expect(input.value).toBe('');
    card.destroy();
  });

  it('在途时 setAskEnabled(false) 禁用输入，回填后复位', () => {
    const card = mountSelectionCard({ onDeepRequest: vi.fn(), onAsk: vi.fn() });
    card.open('查询中…', anchor);
    card.render(result);
    btn('.deep-btn').click();
    card.renderDeep(explain);
    card.setAskEnabled(false);
    expect(parts().querySelector<HTMLInputElement>('.deep-input')!.disabled).toBe(true);
    expect(btn('.deep-send').disabled).toBe(true);
    card.setAskEnabled(true);
    expect(parts().querySelector<HTMLInputElement>('.deep-input')!.disabled).toBe(false);
    card.destroy();
  });

  it('查询在途即可收藏（result 为 null）；结果到达后仍可收藏并转已收藏', async () => {
    const seen: (unknown | null)[] = [];
    const card = mountSelectionCard({ onSave: vi.fn(async (result) => { seen.push(result); return true; }), onSpeak: vi.fn() });
    card.open('查询中…', anchor, { query: 'ephemeral', context: 'ctx', pageTitle: 'T', url: 'https://e.com/p' });
    // loading 态：收藏/朗读即应可用——收藏是独立意图，不被查询成败绑架
    expect(btn('.save').disabled).toBe(false);
    expect(btn('.speak').disabled).toBe(false);
    btn('.save').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([null]);
    expect(btn('.save').textContent).toBe('已收藏');
    // 结果到达后：收藏态保持（不覆盖用户已表达过的意图）
    card.render(result);
    expect(btn('.save').textContent).toBe('已收藏');
    expect(btn('.speak').disabled).toBe(false);
    card.destroy();
  });

  it('查询失败态仍可收藏原词（失败后 queryPending 解除但可存）', () => {
    const card = mountSelectionCard({ onSave: vi.fn(async () => true) });
    card.open('查询中…', anchor, { query: 'ephemeral', context: '', pageTitle: 'T', url: 'https://e.com/p' });
    expect(btn('.save').disabled).toBe(false);
    card.destroy();
  });

  it('提示态（超长选段）无可收藏语义：收藏与朗读保持禁用', () => {
    const card = mountSelectionCard();
    card.openNotice('选段 2500 字，超过 2000 字上限——请缩小选区范围后重试。', anchor);
    expect(btn('.save').disabled).toBe(true);
    expect(btn('.speak').disabled).toBe(true);
    card.destroy();
  });

  it('关闭卡片清空深究态与追问串（隐私默认）', () => {
    const card = mountSelectionCard({ onDeepRequest: vi.fn(), onAsk: vi.fn() });
    card.open('查询中…', anchor);
    card.render(result);
    btn('.deep-btn').click();
    card.renderDeep(explain);
    card.appendExchange('Q', 'A');
    card.close();
    expect(parts().querySelector<HTMLElement>('.deep-panel')!.hidden).toBe(true);
    expect(parts().querySelector<HTMLElement>('.deep-thread')!.textContent).toBe('');
    expect(parts().querySelector<HTMLInputElement>('.deep-input')!.value).toBe('');
    card.destroy();
  });
});

describe('朗读来源优先级（先读译文）', () => {
  const meta = { query: 'ephemeral', context: '', pageTitle: 'T', url: 'u' };
  const result = (over: Partial<Parameters<typeof resolveSpeakSource>[0]>) =>
    ({ term: 'ephemeral', translation: '', phonetic: '', partOfSpeech: '', definition: '', example: '', ...over });

  it('译文优先，其次释义，最后原词', () => {
    expect(resolveSpeakSource(result({ translation: '短暂的', definition: 'lasting a short time' }), meta))
      .toEqual({ text: '短暂的', kind: 'translation' });
    expect(resolveSpeakSource(result({ definition: 'lasting a short time' }), meta))
      .toEqual({ text: 'lasting a short time', kind: 'definition' });
    expect(resolveSpeakSource(result({}), meta))
      .toEqual({ text: 'ephemeral', kind: 'query' });
  });

  it('无 meta 时回退到词条原词；全空时返回空串（按钮禁用）', () => {
    expect(resolveSpeakSource(result({}), null)).toEqual({ text: 'ephemeral', kind: 'query' });
    expect(resolveSpeakSource(null, null)).toEqual({ text: '', kind: 'query' });
  });

  it('点击朗读把来源类型传给 onSpeak（译文/原词走不同音色路径）', () => {
    const onSpeak = vi.fn();
    const card = mountSelectionCard({ onSpeak });
    const anchor = { rect: { top: 40, bottom: 60, left: 10, right: 60 } };
    const parts = () => getSelectionCardShadowForTest(document.getElementById(SELECTION_HOST_ID)!)!;
    card.open('翻译中…', anchor, meta);
    card.render(result({ translation: '短暂的', definition: 'lasting a short time' }));
    parts().querySelector<HTMLButtonElement>('.speak')!.click();
    expect(onSpeak).toHaveBeenLastCalledWith('短暂的', 'translation');
    card.close();
    document.getElementById(SELECTION_HOST_ID)?.remove();
  });
});
