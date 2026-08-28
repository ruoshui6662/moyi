import { buildStyleGuidance } from '../utils/prompts';

export const SYSTEM_PROMPT = [
  'You are a professional translator.',
  'Output only the translation, without explanations or introductory text.',
  'Preserve paragraph structure and meaningful formatting.',
  'Keep proper nouns, code, URLs, file names, and identifiers unchanged.',
].join(' ');

export const buildMessages = (
  input: string,
  targetLanguage: string,
  promptOptions?: { promptStyle?: unknown; useCustomPrompt?: boolean; customPrompt?: string },
) => {
  const systemPrompt = promptOptions
    ? `${SYSTEM_PROMPT} ${buildStyleGuidance(promptOptions.promptStyle, promptOptions.useCustomPrompt, promptOptions.customPrompt)}`
    : SYSTEM_PROMPT;
  return [
    { role: 'system' as const, content: systemPrompt },
    {
      role: 'user' as const,
      content: `Translate the following text into ${targetLanguage}. If it is already in the target language, return it unchanged.\n\n${input}`,
    },
  ];
};

const FORMAT_CONTRACT = [
  'In the output, wrap each translated paragraph in the SAME numbered tag, preserving the exact order.',
  'Output format: <paragraph_1>translation</paragraph_1><paragraph_2>translation</paragraph_2>...',
  'Output only the translations with their tags, with no explanations, labels, numbering outside tags, or introductory text.',
];

export const buildBatchSystemPrompt = (
  targetLanguage: string,
  promptOptions?: { promptStyle?: unknown; useCustomPrompt?: boolean; customPrompt?: string },
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
  lines.push(...FORMAT_CONTRACT);
  return lines.join(' ');
};

export const buildBatchMessages = (
  paragraphs: string[],
  targetLanguage: string,
  context: string,
  promptOptions?: { promptStyle?: unknown; useCustomPrompt?: boolean; customPrompt?: string },
) => [
  { role: 'system' as const, content: buildBatchSystemPrompt(targetLanguage, promptOptions) },
  {
    role: 'user' as const,
    content: `${context ? context + '\n\n' : ''}Translate these ${paragraphs.length} paragraphs, each wrapped in a numbered tag:\n${paragraphs.map((p, i) => `<paragraph_${i + 1}>${p}</paragraph_${i + 1}>`).join('\n')}`,
  },
];
