# AI 断句方案规划（学习陪读蛙 read-frog）

## 一、陪读蛙是怎么做的（源码已核实）

它的字幕管线是 **「AI 断句为主、规则兜底」**，与我们现在的方向正好互补：

```
词级碎片 [{"s":ms,"e":ms,"t":"word"}]
   ↓ ① 按播放位置取 look-ahead 窗口内的一个 chunk（懒处理控成本）
   ↓ ② 发给 LLM（system 提示词高度工程化）
   ↓ ③ 返回简化 VTT：「134200 --> 136160 Moses had died.」
   ↓ ④ 解析回时间轴碎片 → 再过一遍规则优化器轻整理
   ↘ AI 失败/无服务商 → 直接走规则优化器（即我们的 v1 路线）
```

其断句提示词的精髓（值得原样借鉴）：
- **完整句定义**："Each cue must be a COMPLETE standalone sentence"，并明确列举**不完整子句的特征**（只给出条件/时间/原因没说结果；以连接词结尾；单独念出来像没说完）
- **时间戳提取算法**写死在提示词里：句首词的 `s` → 句末词的 `e`，并附一组 WRONG/CORRECT 对照示例（相邻句共享边界时刻，防止模型把下一句起点错接到上一句终点）
- **无遗漏保证**：每条输入碎片必须恰好出现在一个 cue 里（防丢字幕）
- 让 AI 补标点、补大小写；只输出 VTT 不解释

## 二、我们能学（架构完全对口）

| read-frog | 我们的对应物 |
|---|---|
| 后台消息调 LLM | 已有 background 翻译通道，新增一个 `segment-subtitles` 处理器即可 |
| look-ahead 分块懒处理 | 我们调度器本就按预翻窗口工作；v1 采用全片一次性断句+字符分块（更简单，缓存后免费） |
| 规则优化器兜底 | 我们的 v3 规则断句器就是现成兜底 |
| sessionStorage 缓存 | unitCache 直接复用 |

## 三、实施方案

### 1. 新增 `utils/subtitles/ai-segmenter.ts`
- 移植其系统提示词（保留时间戳算法与 WRONG/CORRECT 示例，注明来源），目标语言无关、不翻译原文
- `parseSimplifiedVtt(text) → SubtitleCue[]`
- `aiSegmentCues(cues)`：JSON 序列化按 ~20k 字符分块 → 顺序调用后台 → 合并结果
- **健全性守卫**：输出词量覆盖率 <80%、时间乱序、空结果 → 视为失败抛错（触发规则兜底）

### 2. `background.ts` 新增消息处理器
- `segment-subtitles`：复用现有 OpenAI 兼容通道发一次非流式补全（temperature 0）；API key 仍只在 background 解析
- 当前服务商为 DeepL 时直接返回不支持（DeepL 无语言模型，自动落回规则路线）

### 3. 会话集成（youtube.content.ts / x.content.ts 共用逻辑抽到 ai-segmenter 的编排函数）
- 先用现行 v3 规则断句立即出字幕（体验不变）
- 后台异步请求 AI 断句 → 成功后把 AI 句子经显示规划（>30 词才切）重建单元、`scheduler.reset()` 换入、状态条短暂提示"断句已优化"
- 失败静默保留规则单元；结果写入 unitCache（同键覆盖，下次秒出）
- `subtitleConfig` 增加 `aiSegmentation` 开关（默认开；DeepL 用户自动跳过）

### 4. 测试
- `parseSimplifiedVtt` 解析（含多行文本、脏输入）
- 分块边界（20k 字符切分不丢碎片）
- 健全性守卫三例（覆盖率不足/乱序/空）
- 提示词构造快照（含 WRONG/CORRECT 示例不被回归掉）

## 四、验收标准
1. ASR 无标点视频：AI 断句后每个单元都是完整句（此前靠停顿猜测的长粘连句被正确拆开）
2. AI 调用失败时行为与现状完全一致（规则兜底），无报错打扰
3. 同视频第二次播放零额外 AI 调用（unitCache 命中）
4. 全部 279+ 测试通过