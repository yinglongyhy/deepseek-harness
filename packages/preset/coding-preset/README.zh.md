---
description: "从随发行版交付的 PTC preset 独立派生 Coding preset，保留其插件和人设，并追加四级委派策略。配置 PTC 补丁路径，并了解加载时继承与失败行为。"
kind: "package-reference"
---

# @deepseek-ai/dsh-coding-preset

[English](README.md) | 中文

## 概述

选择独立的 Coding preset，可保留随发行版交付的 PTC 插件（包括 PTC mode）和人设文本，并追加四级委派策略。每次插件加载都会读取当前发行版的 PTC 补丁，因此非用户设置会继承其当前值；已有 Session 保留其采样配置。来源补丁路径为必填项，来源缺失或不兼容时加载失败，不会使用过时副本。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Web 组合通过 `coding.patch.yml` 提供来源补丁路径；本插件从发行版拥有的 PTC 补丁派生固定的 `coding` preset。

### 配置

```yaml
config:
  ptcPresetPath: /path/to/distribution/presets/ptc.patch.yml
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `ptcPresetPath` | 必填 | 当前发行版 PTC preset 补丁（`@deepseek-ai/dsh-web-app/presets/ptc.patch.yml`）的路径；Web 组合通过 `coding.patch.yml` 提供 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-coding-preset)是受支持字段及其声明的穷尽式真源。

### 选择与委派

此 preset 使用固定 id `coding` 和 roster 顺序 `1.5`。[四级委派策略](policy.md)按任务难度与风险选择模型和思考级别；不支持路由参数的入口可保留继承值或已有配置。策略仅提供提示词指导，不是运行时强制。显式委派模型选择仍要求用户在 Subagents 中启用模型选择，并允许 `openai-codex/gpt-6-luna` 和 `openai-codex/gpt-6.1-sol`；本 preset 不更改 Host 默认项或凭据。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

每次插件加载时，本包读取配置的发行版补丁，并从其唯一的 `ptc` 声明及 persona 派生 Coding 配置。本包保留 PTC 插件列表（包括 PTC mode）和人设文本，再原样追加 `policy.md` 中完整的四级委派策略。源补丁的变更在后续插件加载时生效，不会更新已加载的插件。来源补丁缺失或声明不兼容时加载失败；不会使用过时内置副本回退。Web 组合通过 `coding.patch.yml` 提供 `ptcPresetPath`。Coding 不依赖 Web 包；插件加载时从当前上游 PTC 声明派生，因此之后的 PTC 演进会在后续加载时继承。本包不修改 Standard 或 PTC，也不在运行时强制策略。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Preset 组](../README.zh.md)——preset 与 persona 包索引。
- [Agent preset](../agent-preset/README.zh.md)——声明式 preset 条目。
- [Persona](../persona/README.zh.md)——带作用域的人设段落。
- [Web 应用](../../bundle/web-app/README.zh.md)——随发行版交付的 Coding 组合与来源路径配置。
- [Scope 子系统](../../../docs/subsystems/scope.zh.md)——注册隔离。

-----

<a id="model-experience"></a>
## 模型体验

### Coding 委派策略

#### 模型看到什么

Coding 人设包含 PTC 人设文本，并原样追加来自本包根目录 `policy.md` 的完整四级委派策略。模型请求只暴露一个 `run_code` 工具，并包含底层工具的生成 SDK；只有程序打印或返回的中间结果会进入对话，图片除外，图片会直接传递。策略只指导模型行为；权限仍由底层工具执行，提示词不会强制委派或模型选择。

#### Token 影响

Coding 请求包含继承的 PTC 人设文本和追加的委派策略。本 preset 不声称会减少 token 用量。

#### KV Cache 影响

所选 PTC 人设和插件会在插件加载时继承。缓存行为取决于最终请求和提供方；不保证复用缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **委派设置仍由用户管理**——显式模型选择需要在 Subagents 中启用该功能并允许策略中的两条模型路由；本包不修改 Host 设置或凭据。
- **策略仅供指导**——仍可直接使用其他委派工具，因为提示词文本不是运行时强制。
- **必须兼容来源**——配置的发行版补丁必须包含唯一且兼容的 PTC 声明和 persona；缺失或不兼容时加载失败，不会使用过时副本回退。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
