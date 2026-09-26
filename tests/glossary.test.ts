import { describe, expect, it } from 'vitest';
import {
  GLOSSARY_MAX_ENTRIES,
  GLOSSARY_MAX_HITS_PER_REQUEST,
  GLOSSARY_TEXT_MAX_CHARS,
  applyGlossaryReplacements,
  buildGlossaryPrompt,
  filterGlossaryHits,
  parseGlossaryText,
  sanitizeGlossary,
} from '../chrome-plugin/src/utils/glossary';
import { DEFAULT_CONFIG, saveConfig } from '../chrome-plugin/src/utils/config';
import { buildBatchMessages, buildMessages } from '../chrome-plugin/src/service/templates';

describe('sanitizeGlossary', () => {
  it('accepts valid entries and trims whitespace', () => {
    expect(sanitizeGlossary([{ term: ' Kubernetes ', translation: ' 容器编排系统 ' }])).toEqual([
      { term: 'Kubernetes', translation: '容器编排系统' },
    ]);
  });

  it('drops invalid shapes and entries with empty fields', () => {
    expect(sanitizeGlossary(undefined)).toEqual([]);
    expect(sanitizeGlossary('nope')).toEqual([]);
    expect(sanitizeGlossary([null, 42, {}, { term: '', translation: 'x' }, { term: 'x', translation: '' }])).toEqual([]);
  });

  it('dedupes case-insensitively by term keeping the first', () => {
    const entries = sanitizeGlossary([
      { term: 'Kubernetes', translation: '首个' },
      { term: 'kubernetes', translation: '后者' },
    ]);
    expect(entries).toEqual([{ term: 'Kubernetes', translation: '首个' }]);
  });

  it('caps entry count and per-field length', () => {
    const long = 'a'.repeat(200);
    const many = Array.from({ length: GLOSSARY_MAX_ENTRIES + 10 }, (_, i) => ({
      term: `t${i}`,
      translation: `译${i}`,
    }));
    const capped = sanitizeGlossary(many);
    expect(capped).toHaveLength(GLOSSARY_MAX_ENTRIES);
    const lengthCapped = sanitizeGlossary([{ term: long, translation: long }]);
    expect(lengthCapped[0]?.term).toHaveLength(GLOSSARY_TEXT_MAX_CHARS);
    expect(lengthCapped[0]?.translation).toHaveLength(GLOSSARY_TEXT_MAX_CHARS);
  });
});

describe('filterGlossaryHits', () => {
  const entries = [
    { term: 'Kubernetes', translation: '容器编排系统' },
    { term: '墨译', translation: 'MoYi' },
    { term: 'Rust', translation: 'Rust 语言' },
  ];

  it('matches case-insensitively across multiple texts', () => {
    const hits = filterGlossaryHits(entries, ['We run kubernetes in prod.', '墨译是好工具']);
    expect(hits).toEqual([entries[0], entries[1]]);
  });

  it('returns only hits in glossary order and caps the count', () => {
    expect(filterGlossaryHits(entries, ['nothing relevant'])).toEqual([]);
    expect(filterGlossaryHits(undefined, ['Kubernetes'])).toEqual([]);
    expect(filterGlossaryHits(entries, [])).toEqual([]);
    const many = Array.from({ length: GLOSSARY_MAX_HITS_PER_REQUEST + 5 }, (_, i) => ({
      term: `term${i}`,
      translation: `译${i}`,
    }));
    const texts = Array.from({ length: GLOSSARY_MAX_HITS_PER_REQUEST + 5 }, (_, i) => `body term${i}`);
    expect(filterGlossaryHits(many, texts)).toHaveLength(GLOSSARY_MAX_HITS_PER_REQUEST);
  });
});

describe('buildGlossaryPrompt', () => {
  it('returns empty string for an empty table', () => {
    expect(buildGlossaryPrompt([])).toBe('');
  });

  it('embeds term pairs and override semantics', () => {
    const prompt = buildGlossaryPrompt([
      { term: 'Kubernetes', translation: '容器编排系统' },
      { term: 'Rust', translation: 'Rust 语言' },
    ]);
    expect(prompt).toContain('"Kubernetes" => "容器编排系统"');
    expect(prompt).toContain('"Rust" => "Rust 语言"');
    expect(prompt).toContain('overriding every other rule');
    expect(prompt).toContain('exactly as specified');
  });
});

describe('applyGlossaryReplacements', () => {
  const entries = [
    { term: 'Kubernetes', translation: '容器编排系统' },
    { term: '墨译', translation: 'MoYi' },
    { term: 'C++', translation: 'C加加' },
    { term: 'cat', translation: '猫' },
  ];

  it('returns a copy unchanged when the table is empty', () => {
    const texts = ['a', 'b'];
    const out = applyGlossaryReplacements(texts, []);
    expect(out).toEqual(texts);
    expect(out).not.toBe(texts);
  });

  it('replaces latin terms at word boundaries, case-insensitively', () => {
    const [out] = applyGlossaryReplacements(['kubernetes powers the cluster.'], entries);
    expect(out).toBe('容器编排系统 powers the cluster.');
    // 词中命中不算：category / cats / C++11 不被 cat、C++ 波及
    const [guarded] = applyGlossaryReplacements(['category cats C++11'], entries);
    expect(guarded).toBe('category cats C++11');
  });

  it('replaces CJK terms as substrings', () => {
    const [out] = applyGlossaryReplacements(['用墨译读网页'], entries);
    expect(out).toBe('用MoYi读网页');
  });

  it('treats regex metacharacters in terms literally', () => {
    const [out] = applyGlossaryReplacements(['I love C++ and C++11 differs'], entries);
    expect(out).toBe('I love C加加 and C++11 differs');
  });

  it('applies entries in glossary order across all texts', () => {
    const out = applyGlossaryReplacements(['kubernetes 墨译', 'KUBERNETES'], entries);
    expect(out).toEqual(['容器编排系统 MoYi', '容器编排系统']);
  });
});

describe('glossary prompt integration', () => {
  const entries = [{ term: 'Kubernetes', translation: '容器编排系统' }];

  it('batch system prompt carries the glossary block only when provided', () => {
    const messages = buildBatchMessages(['hi'], '简体中文', '', { glossary: entries });
    expect(String(messages[0].content)).toContain('"Kubernetes" => "容器编排系统"');
    const plain = buildBatchMessages(['hi'], '简体中文', '');
    expect(String(plain[0].content)).not.toContain('Glossary');
  });

  it('single messages append glossary after the base system prompt', () => {
    const messages = buildMessages('hi', '简体中文', { glossary: entries });
    expect(String(messages[0].content)).toContain('Glossary (mandatory)');
  });
});

describe('parseGlossaryText', () => {
  it('parses every supported separator and trims both sides', () => {
    const parsed = parseGlossaryText([
      'Kubernetes → 容器编排系统',
      'Rust=>系统编程语言',
      'Go -> 编程语言',
      'React\t前端框架',
      'Docker | 容器引擎',
      'PyTorch，深度学习框架',
      'TensorFlow, 机器学习库',
      'CUDA；并行计算平台',
      'ONNX; 模型交换格式',
    ].join('\n'));
    expect(parsed).toEqual([
      { term: 'Kubernetes', translation: '容器编排系统' },
      { term: 'Rust', translation: '系统编程语言' },
      { term: 'Go', translation: '编程语言' },
      { term: 'React', translation: '前端框架' },
      { term: 'Docker', translation: '容器引擎' },
      { term: 'PyTorch', translation: '深度学习框架' },
      { term: 'TensorFlow', translation: '机器学习库' },
      { term: 'CUDA', translation: '并行计算平台' },
      { term: 'ONNX', translation: '模型交换格式' },
    ]);
  });

  it('splits on the earliest separator so译名内的逗号不吞词', () => {
    expect(parseGlossaryText('Kubernetes → 容器编排，俗称 K8s')).toEqual([
      { term: 'Kubernetes', translation: '容器编排，俗称 K8s' },
    ]);
  });

  it('skips comments, blank and separator-less or half-empty lines', () => {
    expect(parseGlossaryText('# 注释\n// 也是注释\n\n没有分隔符的一行\nKubernetes →\n→ 缺原词')).toEqual([]);
  });

  it('accepts pasted JSON from the export button', () => {
    expect(parseGlossaryText('[{"term":"Kubernetes","translation":"容器编排系统"}]')).toEqual([
      { term: 'Kubernetes', translation: '容器编排系统' },
    ]);
    // 以 [ 开头但非合法 JSON → 整体判空，不退化成逐行解析
    expect(parseGlossaryText('[坏掉的 JSON')).toEqual([]);
  });

  it('returns empty for blank input and dedupes case-insensitively', () => {
    expect(parseGlossaryText('   \n  \n')).toEqual([]);
    expect(parseGlossaryText('Kubernetes → 甲\nkubernetes → 乙')).toEqual([{ term: 'Kubernetes', translation: '甲' }]);
  });

  it('respects the storage caps (entries and per-field length)', () => {
    const many = Array.from({ length: GLOSSARY_MAX_ENTRIES + 20 }, (_, i) => `term${i} → 译${i}`).join('\n');
    expect(parseGlossaryText(many)).toHaveLength(GLOSSARY_MAX_ENTRIES);
    const [overlong] = parseGlossaryText(`${'a'.repeat(200)} → ${'b'.repeat(200)}`);
    expect(overlong?.term).toHaveLength(GLOSSARY_TEXT_MAX_CHARS);
    expect(overlong?.translation).toHaveLength(GLOSSARY_TEXT_MAX_CHARS);
  });
});

describe('config storage contract', () => {
  it('defaults to an empty glossary', () => {
    expect(DEFAULT_CONFIG.glossary).toEqual([]);
  });

  it('saveConfig sanitizes the glossary before persisting', async () => {
    const store = new Map<string, unknown>();
    const globalAny = globalThis as unknown as { chrome?: unknown };
    const previousChrome = globalAny.chrome;
    globalAny.chrome = {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: store.get(key) }),
          set: async (value: Record<string, unknown>) => {
            for (const [key, val] of Object.entries(value)) store.set(key, val);
          },
        },
      },
    };
    try {
      await saveConfig({ ...DEFAULT_CONFIG, glossary: [{ term: ' Kubernetes ', translation: '容器编排' }, 'bad' as unknown as { term: string; translation: string }] });
      expect(store.get('personal-translator-config')).toMatchObject({
        glossary: [{ term: 'Kubernetes', translation: '容器编排' }],
      });
    } finally {
      globalAny.chrome = previousChrome;
    }
  });
});
