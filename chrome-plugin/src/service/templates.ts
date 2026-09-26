import { buildStyleGuidance } from '../utils/prompts';
import { buildGlossaryPrompt, type GlossaryEntry } from '../utils/glossary';

export const SYSTEM_PROMPT = [
  'You are a professional translator.',
  'Output only the translation, without explanations or introductory text.',
  'Preserve paragraph structure and meaningful formatting.',
  'Keep proper nouns, code, URLs, file names, and identifiers unchanged.',
].join(' ');

export const buildMessages = (
  input: string,
  targetLanguage: string,
  promptOptions?: { promptStyle?: unknown; useCustomPrompt?: boolean; customPrompt?: string; glossary?: readonly GlossaryEntry[] },
  context?: string,
) => {
  const glossary = promptOptions ? buildGlossaryPrompt(promptOptions.glossary ?? []) : '';
  const systemPrompt = promptOptions
    ? `${SYSTEM_PROMPT} ${buildStyleGuidance(promptOptions.promptStyle, promptOptions.useCustomPrompt, promptOptions.customPrompt)}${glossary ? ` ${glossary}` : ''}`
    : SYSTEM_PROMPT;
  return [
    { role: 'system' as const, content: systemPrompt },
    {
      role: 'user' as const,
      content: `${context ? `${context}\n\n` : ''}Translate the following text into ${targetLanguage}. If it is already in the target language, return it unchanged.\n\n${input}`,
    },
  ];
};

const FORMAT_CONTRACT = [
  'In the output, wrap each translated paragraph in the SAME numbered tag, preserving the exact order.',
  'Output format: <paragraph_1>translation</paragraph_1><paragraph_2>translation</paragraph_2>...',
  'Output only the translations with their tags, with no explanations, labels, numbering outside tags, or introductory text.',
];

/** 上文窗口：跨批注入的段落数与单段字符上限（3 × 800 ≈ 上限 2400 字符）。 */
export const PRECEDING_CONTEXT_ITEMS = 3;
export const PRECEDING_CONTEXT_ITEM_CHARS = 800;

/**
 * 跨批上文块：相邻批末尾几段原文，供模型保持术语与指代一致。
 * 用独立 <context_N> 标签，避免与输出契约的 <paragraph_N> 混淆；
 * 空数组返回空串（调用方据此跳过拼接——无上文时请求体与旧版逐字节一致）。
 */
export const buildPrecedingContextBlock = (preceding: readonly string[]): string => {
  const items = preceding
    .map((text) => text.trim())
    .filter(Boolean)
    .slice(-PRECEDING_CONTEXT_ITEMS)
    .map((text) => text.slice(0, PRECEDING_CONTEXT_ITEM_CHARS));
  if (items.length === 0) return '';
  return 'Preceding paragraphs from the same document, for terminology and pronoun coherence '
    + '(already translated; never translate or output them): '
    + items.map((text, i) => `<context_${i + 1}>${text}</context_${i + 1}>`).join(' ');
};

export const buildBatchSystemPrompt = (
  targetLanguage: string,
  promptOptions?: { promptStyle?: unknown; useCustomPrompt?: boolean; customPrompt?: string; glossary?: readonly GlossaryEntry[] },
): string => {
  const lines = [
    'You are a professional translator.',
    'You will receive multiple paragraphs of text, each enclosed in numbered tags like <paragraph_1>, <paragraph_2>, etc.',
    'Translate every paragraph into ' + targetLanguage + '.',
    'If a paragraph is already in the target language, return it unchanged.',
    'Keep proper nouns, code, URLs, file names, and identifiers unchanged.',
  ];
  if (promptOptions) {
    lines.push(buildStyleGuidance(promptOptions.promptStyle, promptOptions.useCustomPrompt, promptOptions.customPrompt));
  }
  const glossary = promptOptions ? buildGlossaryPrompt(promptOptions.glossary ?? []) : '';
  if (glossary) lines.push(glossary);
  lines.push(...FORMAT_CONTRACT);
  return lines.join(' ');
};

export const buildBatchMessages = (
  paragraphs: string[],
  targetLanguage: string,
  context: string,
  promptOptions?: { promptStyle?: unknown; useCustomPrompt?: boolean; customPrompt?: string; glossary?: readonly GlossaryEntry[] },
) => [
  { role: 'system' as const, content: buildBatchSystemPrompt(targetLanguage, promptOptions) },
  {
    role: 'user' as const,
    content: `${context ? context + '\n\n' : ''}Translate these ${paragraphs.length} paragraphs, each wrapped in a numbered tag:\n${paragraphs.map((p, i) => `<paragraph_${i + 1}>${p}</paragraph_${i + 1}>`).join('\n')}`,
  },
];
