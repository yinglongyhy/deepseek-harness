---
kind: upgrade-guide
description: "Session 提示失败可能报告不确定的接收结果，而非明确拒绝。"
---

# 保留接收结果不确定的提示尝试

[English](guide.md) | 中文

## 变更

`SessionController.prompt` 确认的是持久化接收，而非模型执行完成。接收开始后的失败、Session 持久化屏障失败或不可用，以及屏障等待期间接收操作所属对象失效，可能返回 `session/prompt-uncertain`，而非明确拒绝。将所有错误都视为可安全使用新请求 ID 重发的自定义 RPC 客户端，可能导致提示重复。

在同一 Session 中重复使用请求 ID 会查询原始接收结果；它不允许替换文本或附件，也不验证重放载荷与原载荷相等。普通 Client 提交 API 会冻结每次尝试并拒绝修改。Session 事件格式和现有日志无需迁移。

## 迁移

1. 在 `SessionController.prompt` 的自定义调用方中，发送前保存原始请求 ID、模式、文本、图片和附件顺序。仅为新的逻辑提交分配新 ID。
2. 将 `session/prompt-uncertain` 和传输中断视为结果未决，而非拒绝。对账原始结果，或使用相同 ID 重试冻结的尝试。不要自动清空未发送内容或生成新 ID。文件重试可能需要为相同已保留字节重新获取授权的传输凭据；尚未接收的尝试不能重用过期凭据。
3. Web 输入框集成应使用 [conversation 包](../../../../packages/client/ui-conversation/README.zh.md)中记录的 contribution 准备与结算接口以及 `retrySubmission`。底层 `conversation.send(text)` 不收集输入框 contribution。
4. 确认提示响应被中断后会保留未决尝试，重试不会创建第二次自有接收，且只有持久化接收成功才清除匹配的提交修订。自定义 Host 组合必须提供成功的 Session 持久化，不能仅包含内存中的 Agent。
