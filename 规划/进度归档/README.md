# 进度归档索引

本目录集中存放历次 ZCode 会话产生的实施计划（原位于 `.zcode/plans/`，`.zcode/` 已被 gitignore，
这些计划是项目开发脉络的真实记录，故迁出归档、纳入版本管理）。

三份长期维护的设计文档仍在上级目录 `规划/`，不重复收入本目录：

- `规划/浏览器翻译插件-第一性原理与自研路线.md`（立项调研，2026-08-22）
- `规划/油猴脚本-第一性原理迁移规划.md`（双发行版架构，2026-08-24）
- `规划/腾讯翻译接入-第一性原理设计.md`（MT 适配器家族，2026-08-26）

## 会话计划清单（按时间排序）

| 文件 | 日期 | 主题 | 状态 |
|---|---|---|---|
| `plan-sess_f2f1ce99-*.md` | 2026-08-22 | UI 全面重构：从「古风」到「macOS」 | ✅ 已完成（重构前快照见 `备份/ui-pre-refactor-20260827-v0.1.4/`） |
| `plan-sess_0d2a5bf7-*.md` | 2026-08-23 | 接入 DeepL 传统翻译后端 | ✅ 已完成（`service/deepl.ts` + 测试全绿） |
| `plan-sess_dc79dac8-*.md` | 2026-08-24 | Logo 资产接入（工具栏/popup/options/悬浮球） | ✅ 已完成（`scripts/gen-assets.mjs` + `floatLogo.ts`） |
| `plan-sess_8bfc9c36-*.md` | 2026-08-25 | YouTube 播放器内 Logo 控件 + 快捷面板 | ✅ 已完成（`subtitles/renderer.ts` 控制条按钮与面板） |
| `plan-sess_ae61372f-*.md` | 2026-08-26 | AI 断句方案（学习陪读蛙 read-frog） | ✅ 已完成（`subtitles/ai-segmenter.ts` + `segment-subtitles` 消息） |

> 迁移记录：2026-09-22 由 `.zcode/plans/` 迁入，文件内容未改动。
> 后续新的会话计划若仍生成在 `.zcode/plans/`，请定期同步到本目录。
