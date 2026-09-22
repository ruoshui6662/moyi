## 接入 DeepL 传统翻译后端（内置服务商新增选项）

### 目标
在内置服务商中新增 DeepL：用户选择「免费版 / 专业版」接口地址、填写 API Key，切换后翻译走 DeepL 官方翻译 API（无需提示词、批量逐段直译、按序渲染）。不影响现有 OpenAI 兼容服务商。

### 设计（第一性原理）
- **服务商增加类型维度**：`ProviderMeta.kind?: 'openai' | 'deepl'`（缺省=openai，现有 5 家行为零变化）。
- **DeepL 网络调用放 background**：content script 的 fetch 受页面 CORS 限制，一律经消息通道在 background 请求。
- **复用既有通道**：`requestBatchTranslation`（`translate-batch` 消息）已存在但未被使用，DeepL 模式直接消费它，无需新建消息类型。
- **“无需 model”约束仅对 deepl 生效**：通过给 `isProviderConfigured(settings, id?)` 增加可选 id 参数特判，避免影响其它服务商的“三字段必填”契约。

### 改动清单

**1. `src/utils/providers.ts`**
- `ProviderMeta` 增加 `kind?: 'openai' | 'deepl'`。
- `BUILT_IN_PROVIDERS` 追加 `deepl`：label「DeepL」、默认 endpoint `https://api-free.deepl.com/v2`（免费版）、`kind:'deepl'`、品牌色/mark、`fallbackModels: []`。
- `isProviderConfigured(settings, id?)`：`id==='deepl'` 时只需 apiKey+endpoint，否则保持三字段；调用点（`getConfiguredProviderIds`、`activateConfiguredProvider`、options/popup）传入 id。
- `activateConfiguredProvider` 对 deepl 不要求 model（其余不变）。

**2. 新增 `src/service/deepl.ts`**
- `deeplTargetLang(code)`：简体中文→ZH、繁體中文→ZH-HANT、English→EN、日本語→JA、한국어→KO。
- `translateWithDeepl(texts[], {apiKey, endpoint})`：POST `${normalizeBaseUrl(endpoint)}/translate`，JSON body `{text, target_lang}`，Header `Authorization: DeepL-Auth-Key`；解析 `translations[].text` 按序返回 string[]；30s 超时；非 2xx/429 用 `TranslationServiceError` 规范化（与现有 throwHttpError 同风格）。
- `testDeeplConnection({apiKey, endpoint})`：最小文本 ping。

**3. `src/entrypoints/background.ts`（分发）**
- `translate-batch` / `translate`：按 `config.providerId` 的 kind 分流——deepl 走 `translateWithDeepl`，否则现有 OpenAI 函数。
- `test-connection`：消息新增 `kind` 字段（Options 传入**当前编辑服务商**的 kind，避免编辑未保存走错后端）；deepl→`testDeeplConnection`。
- `fetch-models`：对 deepl 明确报「该服务商不支持获取模型列表」。

**4. `src/entrypoints/content/trans.ts`**
- translatePage 记录 `sessionBackend`（config.providerId 的 kind）。
- runBatch 对 `sessionBackend==='deepl'` 分支：`requestBatchTranslation(texts, ...)` 一次取回全部译文，按序 `renderTranslation`（无流式渐进），缓存/页权/计数逻辑与现一致；generation 过期不渲染；openai 分支保持原样。

**5. Options（`index.html` + `main.ts`）**
- 面板字段按 kind 适配：deepl 时隐藏「模型名称」「关闭推理」；新增「接口套餐」select（免费版/专业版，仅 deepl 显示），切换回填 endpoint（`api-free.deepl.com/v2` / `api.deepl.com/v2`）。
- `saveProviderNow`：deepl 不要求 model、不写 model；`refreshProviderPanelState` 传 id 判断；`#test` 传 kind。
- 文案同步：页面与关于页“所有服务商均使用 OpenAI 兼容协议”→注明 DeepL 使用官方翻译 API。

**6. `src/entrypoints/popup/main.ts`**
- 下拉/菜单中 deepl 的服务名右侧显示「官方翻译」而非「未选择模型」；激活校验随 `activateConfiguredProvider` 自动放行（deepl 免 model）。

**7. 测试**
- 新增 `tests/deepl.test.ts`：语言码映射、批量翻译成功（fetch mock）、401/429 错误规范化、空文本。
- `tests/providers.test.ts`：更新「isProviderConfigured 三字段」用例为 openai 语义；新增 deepl 只需两字段、deepl meta/kind 断言。
- 回归：全量 155+ 测试、compile、build。

### 验证
- `npm run compile` / `npm test` / `npm run build` 全绿。
- 浏览器：Options 内置列表出现 DeepL 项；选中后显示免费/专业套餐、隐藏模型与推理开关；端点回填正确；切回 OpenAI 服务商原字段恢复。Popup 下拉含 DeepL（配置后）。
- 真实翻译调用依赖用户 DeepL Key，静态预览无法完成；由 deepl.test.ts 的 fetch mock 覆盖请求/响应格式。

### 不做（本次边界）
- 微软/Google 翻译（架构已可扩展，后续按同接口补）。
- DeepL 的术语表/表单域等高级参数（仅基础文本翻译）。