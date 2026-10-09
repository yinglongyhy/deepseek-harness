---
kind: upgrade-guide
description: "Codex 账号界面从单独激活的插件迁移到默认启用的 Web/Desktop 组合行。"
---

# Codex 账号控件现已内置

[English](guide.md) | 中文

## 变更

Web 与 Desktop 现在默认通过 `llm-codex-account` 行启用 Codex 账号控件。旧的 `dsh-openai-codex-oauth` 插件是单独激活项，不得与内置行同时启用。Headless 与 SDK 组合不会获得此界面。

## 迁移

1. 使用内置行前，在用户 profile 层禁用或移除旧的 `dsh-openai-codex-oauth` 激活项。不要自动删除或移动其设置或凭据；内置功能不会迁移它们。
2. 确认 Web/Desktop 组合包含行 `id: llm-codex-account` 和 `name: '@deepseek-ai/dsh-llm-codex-account'`。保持启用即可使用内置控件。若要关闭，请将该行设为 `disabled: true`；不要清除其设置或凭据。
3. 打开“设置 → Codex 登录”，确认登录和目录控件显示。登录仍由用户主动发起；本指南不验证凭据或真实 OAuth 行为。
