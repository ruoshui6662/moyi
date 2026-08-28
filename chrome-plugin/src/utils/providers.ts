export interface ProviderSettings {
  apiKey: string;
  endpoint?: string;
  model?: string;
  /** 自定义服务商显示名称；缺省时回退为「自定义服务商」。 */
  name?: string;
  /** 腾讯翻译 SecretKey（TC3 双密钥的一半）；其他服务商不使用。 */
  apiSecret?: string;
  /** 腾讯翻译地域（Region）；其他服务商不使用。 */
  region?: string;
}

export interface ProviderMeta {
  id: string;
  label: string;
  endpoint: string;
  color: string;
  mark: string;
  svgPath?: string;
  svgPathFillRule?: 'evenodd';
  /** 完整 SVG logo（自绘底色与多元素，如官方字标）；优先于 svgPath。 */
  logoSvg?: string;
  fallbackModels: readonly string[];
  /** 后端类型：缺省为 openai（OpenAI 兼容协议）；mt 走传统 MT API（DeepL / 腾讯翻译，无需模型与提示词）。 */
  kind?: 'openai' | 'mt';
}

export const CUSTOM_PROVIDER_ID = 'custom';

/** 自定义服务商名称的最大长度，防止超长名称撑破列表与下拉。 */
export const CUSTOM_PROVIDER_NAME_MAX_LENGTH = 24;

/** 自定义服务商 id 前缀：生成形如 custom-<ts36>-<rand36> 的唯一标识。 */
export const CUSTOM_PROVIDER_ID_PREFIX = 'custom-';

const CUSTOM_META: ProviderMeta = {
  id: CUSTOM_PROVIDER_ID,
  label: '自定义服务商',
  endpoint: '',
  color: '#8e8e93',
  mark: '自',
  fallbackModels: [],
};

export const BUILT_IN_PROVIDERS: readonly ProviderMeta[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1',
    color: '#10a37f',
    mark: 'AI',
    svgPath: 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z',
    fallbackModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'o4-mini'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    endpoint: 'https://api.deepseek.com',
    color: '#4d6bfe',
    mark: 'D',
    svgPath: 'M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45',
    fallbackModels: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'kimi',
    label: 'Kimi',
    endpoint: 'https://api.moonshot.cn/v1',
    color: '#16161a',
    mark: 'K',
    svgPath: 'M21.765.351C22.998.351 24 1.353 24 2.586S22.998 4.82 21.765 4.82h-1.974c-.15 0-.26-.12-.26-.26V2.586A2.237 2.237 0 0 1 21.765.35M9.41 13.388l8.447-8.377c.16-.16.07-.471-.14-.471h-4.55s-.1.02-.14.06l-9.099 9.029c-.14.14-.35.02-.35-.21V4.81c0-.15-.1-.27-.221-.27H.22c-.12 0-.22.12-.22.27v18.57c0 .15.1.27.22.27h3.137c.12 0 .22-.12.22-.27v-3.79c0-.08.03-.16.08-.21l2.826-2.796c.07-.07.16-.08.241-.03l7.546 5.551a8.9 8.9 0 0 0 4.018 1.493c.12.01.23-.11.23-.27V19.76c0-.14-.08-.25-.19-.26a5.8 5.8 0 0 1-2.355-.942l-6.533-4.73c-.14-.09-.15-.32-.03-.441',
    fallbackModels: ['kimi-latest', 'moonshot-v1-8k', 'moonshot-v1-32k'],
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    endpoint: 'https://api.minimaxi.com/v1',
    color: '#f23f5d',
    mark: 'M',
    svgPath: 'M11.43 3.92a.86.86 0 1 0-1.718 0v14.236a1.999 1.999 0 0 1-3.997 0V9.022a.86.86 0 1 0-1.718 0v3.87a1.999 1.999 0 0 1-3.997 0V11.49a.57.57 0 0 1 1.139 0v1.404a.86.86 0 0 0 1.719 0V9.022a1.999 1.999 0 0 1 3.997 0v9.134a.86.86 0 0 0 1.719 0V3.92a1.998 1.998 0 1 1 3.996 0v11.788a.57.57 0 1 1-1.139 0zm10.572 3.105a2 2 0 0 0-1.999 1.997v7.63a.86.86 0 0 1-1.718 0V3.923a1.999 1.999 0 0 0-3.997 0v16.16a.86.86 0 0 1-1.719 0V18.08a.57.57 0 1 0-1.138 0v2a1.998 1.998 0 0 0 3.996 0V3.92a.86.86 0 0 1 1.719 0v12.73a1.999 1.999 0 0 0 3.996 0V9.023a.86.86 0 1 1 1.72 0v6.686a.57.57 0 0 0 1.138 0V9.022a2 2 0 0 0-1.998-1.997',
    fallbackModels: ['MiniMax-Text-01', 'abab6.5s-chat'],
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    color: '#3859ff',
    mark: 'G',
    svgPath: 'M11.991 23.503a.24.24 0 0 0-.244.248a.24.24 0 0 0 .244.249a.24.24 0 0 0 .245-.249a.24.24 0 0 0-.22-.247zM9.671 5.365a1.697 1.697 0 0 1 1.099 2.132l-.071.172l-.016.04l-.018.054c-.07.16-.104.32-.104.498c-.035.71.47 1.279 1.186 1.314h.366c1.309.053 2.338 1.173 2.286 2.523c-.052 1.332-1.152 2.38-2.478 2.327h-.174c-.715.018-1.274.64-1.239 1.368c0 .124.018.23.053.337c.209.373.54.658.96.8c.75.23 1.517-.125 1.9-.782l.018-.035c.402-.64 1.17-.96 1.92-.711c.854.284 1.378 1.226 1.099 2.167a1.66 1.66 0 0 1-2.077 1.102a1.7 1.7 0 0 1-.907-.711l-.017-.035c-.2-.323-.463-.58-.851-.711l-.056-.018a1.646 1.646 0 0 0-1.954.746a1.66 1.66 0 0 1-1.065.764a1.677 1.677 0 0 1-1.989-1.279c-.209-.906.332-1.83 1.257-2.043a1.5 1.5 0 0 1 .296-.035h.018c.68-.071 1.151-.622 1.116-1.333a1.3 1.3 0 0 0-.227-.693a2.5 2.5 0 0 1-.366-1.403a2.4 2.4 0 0 1 .366-1.208c.14-.195.21-.444.227-.693c.018-.71-.506-1.261-1.186-1.332l-.07-.018a1.4 1.4 0 0 1-.299-.07l-.05-.019a1.7 1.7 0 0 1-1.047-2.114a1.68 1.68 0 0 1 2.094-1.101m-5.575 10.11c.26-.264.639-.367.994-.27s.633.379.728.74c.095.362-.007.748-.267 1.013c-.402.41-1.053.41-1.455 0a1.06 1.06 0 0 1 0-1.482zm14.845-.294c.359-.09.738.024.992.297c.254.274.344.665.237 1.025s-.396.634-.756.718c-.551.128-1.1-.22-1.23-.781a1.05 1.05 0 0 1 .757-1.26zm-.064-4.39c.314.32.49.753.49 1.206s-.176.886-.49 1.206c-.315.32-.74.5-1.185.5c-.444 0-.87-.18-1.184-.5a1.727 1.727 0 0 1 0-2.412a1.654 1.654 0 0 1 2.369 0m-11.243.163c.364.484.447 1.128.218 1.691a1.665 1.665 0 0 1-2.188.923c-.855-.36-1.26-1.358-.907-2.228a1.68 1.68 0 0 1 1.33-1.038a1.66 1.66 0 0 1 1.547.652m11.545-4.221c.368 0 .708.2.892.524s.184.724 0 1.048a1.03 1.03 0 0 1-.892.524a1.04 1.04 0 0 1-1.03-1.048a1.04 1.04 0 0 1 1.03-1.048m-14.358 0c.368 0 .707.2.891.524s.184.724 0 1.048a1.03 1.03 0 0 1-.891.524a1.04 1.04 0 0 1-1.03-1.048c0-.579.461-1.048 1.03-1.048m10.031-1.475c.925 0 1.675.764 1.675 1.706s-.75 1.705-1.675 1.705s-1.674-.763-1.674-1.705s.75-1.706 1.674-1.706m-2.626-.684c.362-.082.653-.356.761-.718a1.06 1.06 0 0 0-.238-1.028a1.02 1.02 0 0 0-.996-.294c-.547.14-.881.7-.752 1.257c.13.558.675.907 1.225.783m0 16.876c.359-.087.644-.36.75-.72a1.06 1.06 0 0 0-.237-1.019a1.02 1.02 0 0 0-.985-.301a1.04 1.04 0 0 0-.762.717c-.108.361-.017.754.239 1.028c.245.263.606.377.953.305zM17.19 3.5a.63.63 0 0 0 .628-.64a.63.63 0 0 0-.628-.64a.63.63 0 0 0-.628.64c0 .355.28.64.628.64m-10.38 0a.63.63 0 0 0 .628-.64c0-.355-.28-.64-.628-.64a.63.63 0 0 0-.628.64c0 .355.279.64.628.64m-5.182 7.852a.63.63 0 0 0-.628.64c0 .354.28.639.628.639a.63.63 0 0 0 .627-.606l.001-.034a.62.62 0 0 0-.628-.64zm5.182 9.13a.63.63 0 0 0-.628.64c0 .355.279.64.628.64a.63.63 0 0 0 .628-.64c0-.355-.28-.64-.628-.64m10.38.018a.63.63 0 0 0-.628.64c0 .355.28.64.628.64a.63.63 0 0 0 .628-.64a.63.63 0 0 0-.628-.64m5.182-9.148a.63.63 0 0 0-.628.64c0 .354.279.639.628.639a.63.63 0 0 0 .628-.64c0-.355-.28-.64-.628-.64zm-.384-4.992a.24.24 0 0 0 .244-.249a.24.24 0 0 0-.244-.249a.24.24 0 0 0-.244.249c0 .142.122.249.244.249M11.991.497a.24.24 0 0 0 .245-.248A.24.24 0 0 0 11.99 0a.24.24 0 0 0-.244.249c0 .133.108.236.223.247zM2.011 6.36a.24.24 0 0 0 .245-.249a.24.24 0 0 0-.244-.249a.24.24 0 0 0-.244.249a.24.24 0 0 0 .244.249zm0 11.263a.24.24 0 0 0-.243.248a.24.24 0 0 0 .244.249a.24.24 0 0 0 .244-.249a.25.25 0 0 0-.244-.248zm19.995-.018a.24.24 0 0 0-.245.248a.24.24 0 0 0 .245.25a.24.24 0 0 0 .244-.25a.25.25 0 0 0-.244-.248',
    svgPathFillRule: 'evenodd',
    fallbackModels: ['glm-4-flash', 'glm-4-air', 'glm-4-plus'],
  },
  {
    id: 'deepl',
    label: 'DeepL',
    endpoint: 'https://api-free.deepl.com/v2',
    color: '#0d3a8a',
    mark: 'DL',
    logoSvg: '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><path d="M24 4 41.3 14v20L24 44 6.7 34V14Z" fill="#0d3a8a"/><g fill="#ffffff"><circle cx="14.5" cy="18.6" r="3"/><circle cx="16" cy="29.4" r="3"/><circle cx="30" cy="24.5" r="3.4"/></g><path d="M17.4 19.6 27.3 23.9M18.9 28.4 28 25.1" stroke="#ffffff" stroke-width="1.9" stroke-linecap="round" fill="none"/></svg>',
    fallbackModels: [],
    kind: 'mt',
  },
  {
    id: 'google',
    label: '谷歌翻译',
    endpoint: 'https://translate-pa.googleapis.com/v1/translateHtml',
    color: '#4285f4',
    mark: '谷',
    // 谷歌官方四色 G 标识（Wikimedia Commons 官方矢量：蓝 #4285F4 / 绿 #34A853 / 黄 #FBBC05 / 红 #EA4335）
    logoSvg: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>',
    fallbackModels: [],
    kind: 'mt',
  },
  {
    id: 'microsoft',
    label: '微软翻译',
    endpoint: 'https://edge.microsoft.com/translate/translatetext',
    color: '#0078d4',
    mark: '微',
    // 微软官方四色方块标识（官方几何与品牌色，见 simple-icons microsoft）
    logoSvg: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="11.408" height="11.408" fill="#F25022"/><rect x="12.594" y="0" width="11.406" height="11.408" fill="#7FBA00"/><rect x="0" y="12.594" width="11.408" height="11.406" fill="#00A4EF"/><rect x="12.594" y="12.594" width="11.406" height="11.406" fill="#FFB900"/></svg>',
    fallbackModels: [],
    kind: 'mt',
  },
  {
    id: 'tencent',
    label: '腾讯翻译',
    endpoint: 'https://tmt.tencentcloudapi.com',
    color: '#0052d9',
    mark: '腾',
    // 腾讯 QQ 官方图标（simple-icons 单色路径，以服务商品牌色渲染）
    svgPath: 'M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673',
    fallbackModels: [],
    kind: 'mt',
  },
];

/** 内置服务商 id 集合。自定义服务商 id 动态生成，见 getCustomProviderIds。 */
export const ALL_PROVIDER_IDS: readonly string[] = BUILT_IN_PROVIDERS.map((provider) => provider.id);

export const getProviderMeta = (id: string): ProviderMeta =>
  BUILT_IN_PROVIDERS.find((provider) => provider.id === id) ?? CUSTOM_META;

export const isBuiltInProvider = (id: string): boolean =>
  BUILT_IN_PROVIDERS.some((provider) => provider.id === id);

/** 是否是自定义服务商 id（非内置 id）。 */
export const isCustomProviderId = (id: string): boolean => !isBuiltInProvider(id);

/** 配置表中现存的自定义服务商 id 列表（按存储顺序）。 */
export const getCustomProviderIds = (providers: Record<string, ProviderSettings> | undefined): string[] => {
  if (!providers) return [];
  return Object.keys(providers).filter((id) => isCustomProviderId(id));
};

/** 全部注册 id：内置 + 配置表中的自定义服务商。 */
export const getRegisteredProviderIds = (providers: Record<string, ProviderSettings> | undefined): string[] => [
  ...ALL_PROVIDER_IDS,
  ...getCustomProviderIds(providers),
];

/** 生成新的唯一自定义服务商 id。 */
export const createCustomProviderId = (): string => {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${CUSTOM_PROVIDER_ID_PREFIX}${timestamp}-${random}`;
};

/** 读取某服务商的显示名称：自定义服务商允许用户命名，缺省回退默认文案。 */
export const getProviderDisplayName = (
  providers: Record<string, ProviderSettings> | undefined,
  id: string,
): string => {
  if (isCustomProviderId(id)) {
    const customName = providers?.[id]?.name?.trim();
    if (customName) return customName;
  }
  return getProviderMeta(id).label;
};

/** 自定义服务商的显示标记：取用户命名首字符，缺省用「自」。 */
export const getProviderMark = (
  providers: Record<string, ProviderSettings> | undefined,
  id: string,
): string => {
  if (isCustomProviderId(id)) {
    const customName = providers?.[id]?.name?.trim();
    if (customName) return customName[0];
  }
  return getProviderMeta(id).mark;
};

export const sanitizeProviderId = (value: unknown, providers?: Record<string, ProviderSettings>): string => {
  if (typeof value !== 'string') return 'openai';
  if (isBuiltInProvider(value)) return value;
  if (providers && Object.prototype.hasOwnProperty.call(providers, value)) return value;
  return 'openai';
};

/** 自定义服务商名称允许的字符：字母/数字/CJK、空白与常见标点；剥离可注入 HTML/CSS 的字符。 */
const CUSTOM_PROVIDER_NAME_SAFE_CHARS = /[^\p{L}\p{N}\s._\-/()[\]&+#@%]/gu;

const sanitizeCustomProviderName = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(CUSTOM_PROVIDER_NAME_SAFE_CHARS, '').slice(0, CUSTOM_PROVIDER_NAME_MAX_LENGTH);
};

const sanitizeProviderSettings = (value: unknown): ProviderSettings | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const settings: ProviderSettings = {
    apiKey: typeof record.apiKey === 'string' ? record.apiKey : '',
  };
  if (typeof record.endpoint === 'string' && record.endpoint.trim()) settings.endpoint = record.endpoint.trim();
  if (typeof record.model === 'string' && record.model.trim()) settings.model = record.model.trim();
  const name = sanitizeCustomProviderName(record.name);
  if (name) settings.name = name;
  if (typeof record.apiSecret === 'string' && record.apiSecret.trim()) settings.apiSecret = record.apiSecret.trim();
  // Region 仅接受腾讯云地域风格的短标识（ap-guangzhou 等），防任意长串注入
  if (typeof record.region === 'string') {
    const region = record.region.trim();
    if (/^[a-z][a-z0-9-]{1,31}$/i.test(region)) settings.region = region;
  }
  return settings;
};

export const sanitizeProviders = (value: unknown): Record<string, ProviderSettings> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, ProviderSettings> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const settings = sanitizeProviderSettings(raw);
    if (settings) result[id] = settings;
  }
  return result;
};

export interface ProviderRuntime {
  apiKey: string;
  apiSecret: string;
  endpoint: string;
  model: string;
  region: string;
}

/** 腾讯翻译默认地域；文档未强制指定时使用 ap-guangzhou。 */
export const TENCENT_DEFAULT_REGION = 'ap-guangzhou';

/**
 * 解析某服务商的生效配置：已存凭据覆盖默认地址；自定义服务商无默认地址。
 */
export const resolveProviderSettings = (
  config: { providers?: Record<string, ProviderSettings>; endpoint?: string; apiKey?: string; model?: string },
  id: string,
): ProviderRuntime => {
  const meta = getProviderMeta(id);
  const stored = config.providers?.[id];
  return {
    apiKey: stored?.apiKey ?? '',
    apiSecret: stored?.apiSecret ?? '',
    endpoint: stored?.endpoint ?? (isBuiltInProvider(id) ? meta.endpoint : ''),
    model: stored?.model ?? '',
    region: stored?.region ?? (id === 'tencent' ? TENCENT_DEFAULT_REGION : ''),
  };
};

/** DeepL 等传统 MT 后端：无模型、无提示词、按字符计费。 */
export const isMtProviderId = (id: string): boolean => getProviderMeta(id).kind === 'mt';

/** 免密钥的传统 MT 后端（微软翻译走 Edge 端点、谷歌翻译走 translate-pa 端点，均无用户凭据）。 */
export const NO_KEY_MT_PROVIDER_IDS: readonly string[] = ['microsoft', 'google'];
export const isNoKeyMtProviderId = (id: string): boolean => NO_KEY_MT_PROVIDER_IDS.includes(id);

/** DeepL 专属判定（套餐选择等 UI 细节），腾讯翻译虽同为 MT 但走独立字段。 */
export const isDeeplProviderId = (id: string): boolean => id === 'deepl';

export const isProviderConfigured = (
  settings: Pick<ProviderRuntime, 'apiKey' | 'apiSecret' | 'endpoint' | 'model'>,
  id?: string,
): boolean => {
  if (id && isMtProviderId(id)) {
    // 微软/谷歌翻译走免密钥端点，天然可用，不要求任何凭据
    if (isNoKeyMtProviderId(id)) return true;
    if (id === 'tencent') {
      return Boolean(settings.apiKey.trim() && settings.apiSecret?.trim() && settings.endpoint.trim());
    }
    return Boolean(settings.apiKey.trim() && settings.endpoint.trim());
  }
  return Boolean(settings.apiKey.trim() && settings.endpoint.trim() && settings.model.trim());
};

export interface ProviderActivationConfig {
  providerId: string;
  apiKey: string;
  endpoint: string;
  model: string;
  providers?: Record<string, ProviderSettings>;
}

export const getConfiguredProviderIds = (
  config: Pick<ProviderActivationConfig, 'providers'>,
): string[] =>
  getRegisteredProviderIds(config.providers).filter((id) =>
    isProviderConfigured(resolveProviderSettings(config, id), id),
  );

export const activateConfiguredProvider = <T extends ProviderActivationConfig>(
  config: T,
  id: string,
): T => {
  const registered = (id: string): boolean =>
    isBuiltInProvider(id) ||
    Boolean(config.providers && Object.prototype.hasOwnProperty.call(config.providers, id));

  if (!registered(id)) {
    throw new Error('未知的翻译服务。');
  }

  const runtime = resolveProviderSettings(config, id);
  if (!isProviderConfigured(runtime, id)) {
    throw new Error('该翻译服务尚未完整配置。');
  }

  return {
    ...config,
    providerId: id,
    apiKey: runtime.apiKey,
    endpoint: runtime.endpoint,
    model: runtime.model,
  };
};

/**
 * 容错解析 /models 响应：兼容 {data:[{id}]}、{models:[{id}]}、根级 [{id}] 或 [string] 等变体。
 */
export const parseModelsPayload = (payload: unknown): string[] => {
  const toIds = (list: unknown): string[] =>
    Array.isArray(list)
      ? list
          .map((item) => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object') {
              const record = item as Record<string, unknown>;
              if (typeof record.id === 'string') return record.id;
              if (typeof record.model === 'string') return record.model;
              if (typeof record.name === 'string') return record.name;
            }
            return '';
          })
          .filter((id) => id.trim().length > 0)
          .map((id) => id.trim())
      : [];

  if (Array.isArray(payload)) return toIds(payload);
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const fromData = toIds(record.data);
    if (fromData.length > 0) return fromData;
    const fromModels = toIds(record.models);
    if (fromModels.length > 0) return fromModels;
  }
  return [];
};
