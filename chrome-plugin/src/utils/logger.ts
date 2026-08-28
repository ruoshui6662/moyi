export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const PREFIX = '[PersonalTranslator]';

/** 脱敏 URL：去除可能内嵌凭证的 userinfo、查询串与 hash，其余保留。 */
const redactUrl = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
    }
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
};

const serialize = (value: unknown): unknown => {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (/^(apiKey|accessToken|refreshToken|authorization|secret|password|clientSecret)$/i.test(key)) result[key] = '[REDACTED]';
      else if (/^(url|endpoint|baseUrl|href|location)$/i.test(key)) result[key] = redactUrl(item);
      else if (/^(text|content|translation|prompt|body)$/i.test(key)) result[key] = '[OMITTED]';
      else result[key] = serialize(item);
    }
    return result;
  }
  return value;
};

const write = (level: LogLevel, event: string, data?: unknown): void => {
  const output = data === undefined ? [PREFIX, event] : [PREFIX, event, serialize(data)];
  console[level](...output);
};

export const logger = {
  debug: (event: string, data?: unknown) => write('debug', event, data),
  info: (event: string, data?: unknown) => write('info', event, data),
  warn: (event: string, data?: unknown) => write('warn', event, data),
  error: (event: string, data?: unknown) => write('error', event, data),
};
