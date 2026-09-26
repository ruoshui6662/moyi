/**
 * 站点规则的跨入口桥（共享层里唯一的规则相关符号——一个事件名常量）。
 *
 * 为什么不是共享层直接读规则：规则模块（siteRules/ruleRepository/siteRulePreview）
 * 是插件独有的功能面，油猴 import 图不该背这 ~30KB（非压缩产物直接吃源码体积）。
 * 共享的 content/main 只负责**同步广播**事件，插件独有入口
 * `siteRules.content.ts` 在监听器里编译并注入会话规则集——
 * CustomEvent 派发是同步的，监听器返回后 translatePage 才继续，顺序有保证；
 * 油猴端没有监听器，事件空转，规则集保持 EMPTY（行为与规则上线前一致）。
 */

/** 共享层 → 插件独有入口：「按当前 host 编译并注入规则集」。 */
export const APPLY_SITE_RULES_EVENT = 'moyi:apply-site-rules';
