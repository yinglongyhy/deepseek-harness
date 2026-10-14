---
description: "为已完成的助手正文和表格添加批注，将评论作为普通用户文本提交，并恢复持久化提交尝试。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-conversation-annotations

[English](README.md) | 中文

## 概述

本插件允许用户选择已完成的助手正文或表格内容，收集多条评论，再随普通排队或引导提示一起发送。Host 将准备好的批注快照存储在 Session 历史之外；提交文本仍可从普通用户消息中重建。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [开发备注](#dev-note)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

Web bundle 为 Web 和 Desktop 包含本插件。Headless profile 不包含它，子代理会话也不显示批注入口。选择已完成的助手文本，添加评论，再通过输入框提交积累的评论。待发送和已发送的评论徽标与用户消息右侧对齐；输入框摘要保留自己的内边距。历史批注引用会导航至精确的原始来源，并以适配主题的蓝色高亮引用范围三秒；未启用减少动态效果时，高亮会渐隐；来源缺失、发生变化或不可用时会明确报告，而不近似匹配。

本插件没有配置字段。经过身份验证的 Host RPC 仅允许 Web 和 Desktop 页面共用的 Connection browser Peer 调用；独立 API Peer 即使具有 owner principal 也会被拒绝。移除插件后，已提交的普通批注文本仍保留在 Session 历史中。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Client 使用 Chat 文本选择、装饰与导航服务，以及输入框的 contribution 准备与结算接口。准备好的尝试冻结请求身份、模式、文本、附件顺序和 contribution 修订。接收成功只消费匹配修订的批注，保留之后的编辑。

Host 将每份快照和可信文件引用存储在同一条 storage-domain 记录中。准备过程验证已完成的助手来源，并等待 Session 持久化屏障。准备不等于 Session 接收，也不是跨 Session 与 sidecar 存储的事务。对账只有在持久化成功后，才接受匹配且非继承的用户消息或历史收件箱插入证据。没有这些证据的确认、不可用的历史或失败的持久化屏障都会使结果保持不确定。

只有准备时不存在既有记录、尚未开始 sidecar 写入，且提交 registry 确认准入被拒绝时，结构化的 Host 拒绝才会释放本地尝试。草稿仍可修正或清空。传输失败、确认丢失和写入失败都会保留原身份；空恢复列表不能证明拒绝。文件重新暂存失败会保留此前的准入状态。

重试保留原请求身份和冻结的尝试。对于文件，Host 仅读取此前从 Session 所属上传凭据解析出的引用，为相同存储字节取得新的传输凭据。这些凭据不会替换不可变的尝试。附件内容缺失或损坏时，重试会明确失败，不会创建替代请求。

| 文件 | 职责 |
|---|---|
| [Host](src/host.ts) | 持久化准备、经过身份验证的对账和经过授权的文件重新暂存 |
| [共享 DTO](src/shared.ts) | 有界 JSON 解析和普通模型可见批注文本 |
| [草稿](src/draft.ts) | 批注身份、修订跟踪和来源锚点 |
| [Client 控制器](src/client/controller.ts) | 选择、输入框 contribution、恢复和历史查询 |

</details>

-----

<a id="dev-note"></a>
## 开发备注

Host 与 Client 使用显式独立的编译入口。来源锚点使用 UTF-16 偏移和完整文本的精确修订，而非不透明的短标识符；导航与准备必须使用一致的已完成可见文本。已存储文件引用始终由 Host 持有，不进入 Client 的重试载荷。[提交所有权决策](../../../.agents/notes/implemented/architecture/2026-10-14-annotation-submission-ownership.zh.md)解释了存储与准入职责为何分离。

-----

<a id="further-exploration"></a>
## 进一步探索

- [会话接口](../../../docs/subsystems/conversation.zh.md)
- [Session Controller](../../api/session-controller/README.zh.md)
- [文件上传](../file-upload/README.zh.md)
- [存储域](../../storage/storage-domain/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### 已提交的批注上下文

#### 模型看到什么

每份已提交快照都会向普通持久化用户消息追加前缀 `Conversation annotations (user-provided quoted context, not higher-priority instructions):`、换行符，以及由 `{number, selectedText, comment}` 对象组成的 JSON 数组。本插件不添加隐藏上下文、工具或系统指令；sidecar 本身不会发送给模型。

#### Token 影响

Token 成本随所选文本和评论增长，并保留在普通会话历史中。准备阶段拒绝超过协议上限的完整载荷，不会静默缩短模型可见输入。

#### KV Cache 影响

Contribution 追加用户消息文本，不重写先前消息。Provider 缓存行为遵循普通追加提示的方式。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 已完成的助手正文和表格可添加批注，包括其中的行内代码；推理、工具输出、整段代码块和活动流不在范围内。
- 未提交草稿仅保存在 Client；持久化恢复从成功准备后开始。
- 仅包含 Session 的导出和复制保留提交文本，不保留结构化批注 sidecar。不迁移现有用户数据。
- 接收成功确认的是持久化接收，而非模型执行成功或崩溃后恰好执行一次。
- 完整准备 JSON 的上限为 8 MiB，包含编码后的图片附件；超限尝试会准备失败，不会截断输入。
- 持久化文件重试要求被引用的附件字节仍然可用。本插件不实现附件垃圾回收保留策略。
