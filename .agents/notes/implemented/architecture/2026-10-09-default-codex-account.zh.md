# Agent Note: 默认 Codex 账户集成

Status: implemented

[English](2026-10-09-default-codex-account.md) | 中文

## Problem

现有 pi-ai 适配器和授权服务支持 Codex 凭据，但本地 GUI 需要专用登录控件、可编辑的模型设置和账户信息。将这些相关控件作为独立附加插件管理会分散功能，也使 Web/Desktop 默认交付更难维护。

## Decision

`llm-codex-account` 在一个非实验性 LLM 包中拥有 Host 处理器和 Client 展示，使用独立的 Host、Client 编译面。Web 默认加载该包，Desktop 复用同一组合；Headless 和 SDK 组合保持不变。该包不新增 provider 或凭据存储：已安装的 pi-ai 适配器拥有 OAuth 及其现有凭据键，见[凭据记录与授权流程](2026-08-13-credential-records-and-authorization-flows.zh.md)。

登录、路由配置和请求能力是独立事实。当前页面的新登录成功后可以添加缺失的 Codex 路由，但不会替换现有配置。保存目录是显式设置操作，也可以创建该配置。已存凭据和已报告配额不保证模型访问能力。退出登录只删除本地凭据记录。

令牌、刷新和上游账户请求留在 Host。Client 只接收白名单状态和账户字段。Connection 注册由消费插件拥有；插件声明 Connection 及其 WebServer 载体，使销毁和载体替换能够撤销或重新挂载路由。

## Alternatives considered

**实验性或按需交付。** 用户要求该功能成为默认本地 GUI 的一部分，而不是评估能力；实验性分类或可选 bundle 会与这一产品用途冲突。

**拆分登录、目录和账户信息包。** 这些控件一起维护和交付，不需要独立演进的公共服务；拆分实现会增加组合和管理工作，却没有其他消费者需要。

**第二套 OAuth 流程、provider 或凭据存储。** 现有授权和 pi-ai 服务已经拥有这些职责。重复实现会引入互相竞争的令牌文档和认证优先级。

## Consequences

默认交付增加专用设置区，但不会启动授权。禁用该包会保留设置和凭据；旧外部插件必须另行禁用，避免重复控件。回环 OAuth 回调要求 Host 和浏览器位于同一台机器。Codex 配额依赖不稳定的上游端点，因此失败时隐藏过期信息，而不是显示虚构的零值。

源码测试覆盖账户操作和生命周期归属；Loader 和构建后浏览器测试覆盖真实组合及用户可见输出。真实 OAuth、配额、余额和 Desktop 平台检查需要另外执行具备账户条件的或手工验证。
