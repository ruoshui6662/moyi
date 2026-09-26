# 站点规则仓库格式

墨译的「站点规则」允许为特定站点定制**哪些内容进入翻译**。官方仓库示例与社区自建仓库均使用本文档描述的 JSON 格式，在设置页「站点规则 → 规则仓库」填入 HTTPS 地址即可订阅。

## 顶层结构

接受两种形态（等价）：

```json
[{ "name": "…", "hostPattern": "…", "includeSelectors": [] }]
```

```json
{ "rules": [{ "name": "…", "hostPattern": "…" }] }
```

约束：文件 ≤ 2 MB；单次最多入库 50 条；`id` 与 `source` 由插件本地生成——**仓库里的 `id`/`source` 一律被忽略**（防止伪造个人规则层级）。

## 字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 规则名（≤40 字），设置页列表展示 |
| `hostPattern` | string | 是 | 站点匹配：`example.com` 精确 / `*.example.com` 含子域与 apex / `.example.com` 同通配 / `*` 全部站点 |
| `includeSelectors` | string[] | 否 | CSS 选择器（每条 ≤8 个、≤200 字符）；与「强捞」配合把被剪枝器漏掉的正文拉回来 |
| `excludeSelectors` | string[] | 否 | 命中元素及其子树不翻译（如推荐位、评论区） |
| `forceInclude` | boolean | 否 | `true` 时 `includeSelectors` 命中的元素绕过剪枝器（`.notranslate` 误标正文、`hidden` 包裹正文等） |
| `enabled` | boolean | 否 | 缺省视为 `true` |

## 优先级

个人规则（设置页手写）**压**订阅规则：个人 include 追加、个人 exclude 无条件优先；`forceInclude` 任一层开启即生效。空规则集时翻译行为与规则上线前完全一致。

## 完整示例

```json
{
  "rules": [
    {
      "name": "某文档站：捞回误标 notranslate 的正文",
      "hostPattern": "docs.example.com",
      "includeSelectors": [".markdown-body p", ".markdown-body li"],
      "excludeSelectors": [".toc", ".breadcrumb"],
      "forceInclude": true
    },
    {
      "name": "全站：关掉导航栏",
      "hostPattern": "*.example.org",
      "excludeSelectors": ["nav", "header[role=banner]"]
    }
  ]
}
```

## 行为约定

- **拉取在扩展后台完成**并缓存 24 小时（设置页「立即更新订阅」可随时手动刷新）；翻译时只读缓存，不打网络；拉取失败保留旧缓存，不阻断翻译。
- **强捞的边界**：`forceInclude` 只保证「取到文本」，不保证「翻得对」；它绝不捞回扩展自己的译文节点（`[data-personal-translator-owned]`）与输入域（`input`/`textarea`/`select`）。
- **试运行**：在目标网页控制台执行
  ```js
  document.dispatchEvent(new CustomEvent('moyi:preview-site-rules'))
  ```
  命中元素会高亮 5 秒（include 实线、exclude 虚线），控制台回报命中数量。

## 维护建议

- 一条规则只管一个站点的一种症状；命名写清「症状 + 修法」便于他人复用。
- 选择器尽量具体（`.class > p` 而非裸 `p`），过宽的 include 会让无关区块进入翻译。
- 提交前用上面的试运行命令自查命中数量级——命中上千通常意味着选择器写宽了。
