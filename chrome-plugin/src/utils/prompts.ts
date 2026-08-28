export type TranslationPromptStyle = 'general' | 'academic' | 'liberal';

export interface PromptStyleMeta {
  id: TranslationPromptStyle;
  label: string;
  description: string;
}

export const PROMPT_STYLES: readonly PromptStyleMeta[] = [
  { id: 'general', label: '通用', description: '自然流畅，像原生写作' },
  { id: 'academic', label: '学术', description: '术语精确、句式严谨，适合论文与文档' },
  { id: 'liberal', label: '意译', description: '不拘泥字面，优先传达语气与可读性' },
];

const STYLE_GUIDANCE: Record<TranslationPromptStyle, string> = {
  general:
    'Aim for natural, fluent wording that reads like text originally written in the target language. '
    + 'Use idiomatic expressions where appropriate and avoid stiff, word-for-word translation.',
  academic:
    'Use precise terminology and rigorous sentence structure suitable for academic papers and technical documents. '
    + 'Keep established technical terms consistent throughout the translation, and follow the conventions of the relevant field.',
  liberal:
    'Prioritize meaning, tone, and readability over word-for-word fidelity. '
    + 'Freely restructure sentences when it improves flow, and adapt expressions to feel natural to readers of the target language while preserving the original intent.',
};

export const sanitizePromptStyle = (value: unknown): TranslationPromptStyle =>
  typeof value === 'string' && PROMPT_STYLES.some((style) => style.id === value)
    ? (value as TranslationPromptStyle)
    : 'general';

/**
 * 风格引导语：自定义提示词只替换「怎么译」的风格段；
 * 输出格式契约（段落标签规则）由 templates.ts 固有保证，不受用户输入影响。
 */
export const buildStyleGuidance = (
  style: unknown,
  useCustomPrompt: boolean | undefined,
  customPrompt: string | undefined,
): string => {
  const custom = typeof customPrompt === 'string' ? customPrompt.trim() : '';
  if (useCustomPrompt && custom) {
    return `Follow these additional translation style requirements from the user: ${custom}`;
  }
  return STYLE_GUIDANCE[sanitizePromptStyle(style)];
};
