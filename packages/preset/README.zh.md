---
description: "本组通过普通 Cordis 声明定义 Agent 能力，并管理会话选择和运行时代际。Host 共享 Agent loop；各 Agent 使用自己选定代际的工具、提示词和技能。"
kind: "package-group"
---

# packages/preset

[English](README.md) | 中文

## 概述

本组通过普通 Cordis 声明定义 Agent 能力，并管理会话选择和运行时代际。Host 共享 Agent loop；各 Agent 使用自己选定代际的工具、提示词和技能。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发笔记](#dev-note)

<a id="packages"></a>
## 包

| Package | Role | ctx key |
|---|---|---|
| [agent-preset-registry](agent-preset-registry/README.zh.md) | 选择、代际保留和 profile 编辑 | `ctx.agentPresets` |
| [agent-preset](agent-preset/README.zh.md) | 声明式子插件和元数据 | — |
| [persona](persona/README.zh.md) | 可组装的 Agent 人设 | — |
| [coding-preset](coding-preset/README.zh.md) | 从随发行版交付的 PTC 补丁独立派生 Coding preset | — |

<a id="related-documentation"></a>
## 相关文档

- [Scope 子系统](../../docs/subsystems/scope.zh.md)——preset 包共用的注册隔离机制。
- [Cordis](../../docs/cordis-primer.zh.md)
- [Agent preset](../../.agents/notes/implemented/architecture/2026-09-18-declarative-agent-presets.zh.md)

<a id="dev-note"></a>
## 开发笔记

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
