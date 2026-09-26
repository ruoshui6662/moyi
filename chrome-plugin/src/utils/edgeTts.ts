/**
 * Edge 云端语音（可选音源，W6.1）。
 *
 * 定位与边界（先说清，避免误解）：
 * - 这是**非公开协议**（社区通行实现），依赖微软随时可能变化；与微软服务条款亦存在
 *   张力。因此：**默认关闭**、设置里显式选择才启用、任何失败都软降级到系统 TTS，
 *   绝不让「云端音源」成为朗读的唯一通路。
 * - 运行位置：WebSocket 必须在 **background**（扩展上下文）发起——内容脚本的
 *   网络连接受页面 CSP/CORS 管辖（与翻译请求同理）。
 * - 本模块不直接开连接，只提供**可注入 WebSocket 工厂**的协议实现：
 *   单测用假 socket 跑完整握手与二进制分片收集，无需联网。
 */

/** 社区通行的可信客户端令牌（非公开协议的一部分）。 */
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const ORIGIN = 'chrome-extension://moyi-edge-tts';
const SYNTH_BASE = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';

export const EDGE_TTS_ENDPOINT = `${SYNTH_BASE}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;

/** 音色列表接口（同样非公开）：返回 { ShortName, Gender, ... }[]。 */
export const EDGE_TTS_VOICES_ENDPOINT =
  `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;

export interface EdgeVoice {
  ShortName: string;
  Gender?: string;
  Locale?: string;
  FriendlyName?: string;
}

/** 语速倍率（0.5–2）→ SSML prosody 百分比：+12% / -35%。 */
export const prosodyRate = (rate: number): string => {
  const clamped = Math.min(2, Math.max(0.5, Number.isFinite(rate) ? rate : 1));
  const percent = Math.round((clamped - 1) * 100);
  return `${percent >= 0 ? '+' : ''}${percent}%`;
};

const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** SSML 正文：音色的 ShortName 同时决定 xml:lang 前缀（如 zh-CN-XiaoxiaoNeural → zh-CN）。 */
export const buildEdgeSsml = (text: string, voice: string, rate = 1): string => {
  const lang = voice.split('-').slice(0, 2).join('-') || 'en-US';
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang.toLowerCase()}">`
    + `<voice name="${escapeXml(voice)}"><prosody rate="${prosodyRate(rate)}">${escapeXml(text)}</prosody></voice>`
    + '</speak>';
};

const rfc1123Date = (): string => new Date().toUTCString();

/** 握手第一帧：声明输出格式（48kHz 单声道 MP3）。 */
export const buildConfigFrame = (): string =>
  'X-Timestamp:' + rfc1123Date() + '\r\n'
  + 'Content-Type:application/json; charset=utf-8\r\n'
  + 'Path:speech.config\r\n\r\n'
  + JSON.stringify({
    context: {
      synthesis: {
        audio: {
          metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
          outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        },
      },
    },
  });

/** 握手第二帧：SSML 请求（X-RequestId 用时间戳即可，此处不参与鉴权）。 */
export const buildSsmlFrame = (ssml: string, requestId: string): string =>
  'X-RequestId:' + requestId + '\r\n'
  + 'Content-Type:application/ssml+xml\r\n'
  + 'X-Timestamp:' + rfc1123Date() + 'Z\r\n'
  + 'Path:ssml\r\n\r\n'
  + ssml;

/** 合并二进制音频分片。 */
export const concatBytes = (chunks: readonly Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

/** 音频转 base64（background → content 只能走可序列化消息）。 */
export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const step = 0x8000; // 分块避免 apply 爆栈
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
};

export const base64ToBytes = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};

/** 最小 WebSocket 形态（真实与测试共用）。 */
export interface EdgeSocket {
  send(data: string): void;
  close(): void;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onclose: ((event?: unknown) => void) | null;
}

export interface SynthesizeOptions {
  text: string;
  voice: string;
  rate?: number;
  timeoutMs?: number;
  /** 可注入的 WebSocket 工厂（测试用假实现；生产留空走全局 WebSocket）。 */
  createSocket?: (url: string) => EdgeSocket;
}

/**
 * 合成一段文本：握手 → 发 SSML → 收集二进制音频 → 返回合并后的 MP3。
 * 服务端以 `Path:response` 文本帧表示结束；全程有超时兜底。
 */
export const synthesizeEdgeSpeech = (options: SynthesizeOptions): Promise<Uint8Array> => {
  const { text, voice, rate = 1, timeoutMs = 20_000 } = options;
  const trimmed = text.trim();
  if (!trimmed) return Promise.reject(new Error('没有可朗读的内容。'));
  const factory = options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as EdgeSocket);
  return new Promise<Uint8Array>((resolve, reject) => {
    let socket: EdgeSocket;
    try {
      socket = factory(EDGE_TTS_ENDPOINT);
    } catch (error) {
      reject(error instanceof Error ? error : new Error('无法建立云端语音连接。'));
      return;
    }
    const chunks: Uint8Array[] = [];
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // 已关闭
      }
      if (error) reject(error);
      else {
        const audio = concatBytes(chunks);
        if (audio.byteLength === 0) reject(new Error('云端语音未返回音频。'));
        else resolve(audio);
      }
    };
    const timer = globalThis.setTimeout(() => finish(new Error('云端语音超时（20 秒），已回退系统语音。')), timeoutMs);
    socket.onopen = () => {
      socket.send(buildConfigFrame());
      socket.send(buildSsmlFrame(buildEdgeSsml(trimmed, voice, rate), String(Date.now())));
    };
    socket.onmessage = (event) => {
      const data = event.data;
      if (typeof data === 'string') {
        if (data.includes('Path:response')) finish();
        return;
      }
      if (data instanceof ArrayBuffer) {
        chunks.push(new Uint8Array(data));
        return;
      }
      if (ArrayBuffer.isView(data)) {
        chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      }
    };
    socket.onerror = () => finish(new Error('云端语音连接失败，已回退系统语音。'));
    socket.onclose = () => finish();
  });
};

/** 各语言默认音色（设置里没选、或所选音色与朗读语言不符时兜底）。 */
const DEFAULT_EDGE_VOICE_BY_LANG: Record<string, string> = {
  'zh-cn': 'zh-CN-XiaoxiaoNeural',
  'zh-tw': 'zh-TW-HsiaoChenNeural',
  'en-us': 'en-US-AvaNeural',
  'en-gb': 'en-GB-SoniaNeural',
  'ja-jp': 'ja-JP-NanamiNeural',
  'ko-kr': 'ko-KR-SunHiNeural',
  'fr-fr': 'fr-FR-DeniseNeural',
  'de-de': 'de-DE-KatjaNeural',
  'es-es': 'es-ES-ElviraNeural',
  'ru-ru': 'ru-RU-SvetlanaNeural',
  'pt-br': 'pt-BR-FranciscaNeural',
  'it-it': 'it-IT-ElsaNeural',
};

/** 按语言码（zh-CN / en-US）取默认音色；未知语言返回通用英文音色。 */
export const defaultEdgeVoiceForLang = (lang: string | undefined): string => {
  const key = (lang ?? '').toLowerCase();
  return DEFAULT_EDGE_VOICE_BY_LANG[key] ?? 'en-US-AvaNeural';
};

/** 用户所选音色与朗读语言不一致时（朗读译文却用着另一种语言的音色）→ 换默认音色。 */
export const resolveEdgeVoice = (configured: string, lang: string | undefined): string => {
  if (lang) {
    const prefix = lang.toLowerCase();
    const matches = configured.toLowerCase().startsWith(prefix);
    if (!matches) return defaultEdgeVoiceForLang(prefix);
  }
  return configured;
};

/** 播放音频字节（Blob URL + <audio>）：自动释放 URL；播放被浏览器策略拒绝时抛错，宿主降级系统语音。 */
export const playAudioBytes = (bytes: Uint8Array, audioCtor: typeof Audio = Audio): Promise<void> => {
  // 复制到确定的 ArrayBuffer：TS 5.7+ 的 Uint8Array<ArrayBufferLike> 与 BlobPart 联合类型不兼容
  const mp3 = new Uint8Array(bytes.byteLength);
  mp3.set(bytes);
  const url = URL.createObjectURL(new Blob([mp3.buffer], { type: 'audio/mpeg' }));
  const audio = new audioCtor(url);
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      URL.revokeObjectURL(url);
      audio.onended = null;
      audio.onerror = null;
    };
    audio.onended = () => { cleanup(); resolve(); };
    audio.onerror = () => { cleanup(); reject(new Error('音频播放失败。')); };
    audio.play().catch((error: unknown) => { cleanup(); reject(error instanceof Error ? error : new Error('音频播放被浏览器拒绝。')); });
  });
};
