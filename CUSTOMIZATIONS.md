# 自定义功能维护清单

## 摘要

本参考文档记录相对官方保留的自定义功能、接口依赖、退出条件和已知限制，作为上游同步的事实依据。功能使用说明由对应 README 拥有；同步操作见 [custom-sync-upstream](.agents/skills/custom-sync-upstream/SKILL.md)，开发与打包示例见 [自定义命令](CUSTOM_COMMANDS.md)。

## 目录

- [官方基线与分支](#官方基线与分支)
- [自定义功能](#自定义功能)
- [已知限制](#已知限制)

## 官方基线与分支

- 官方仓库：`https://github.com/deepseek-ai/deepseek-harness.git`；跟踪分支：`master`。已验证基线是 `0.2.1-rc.2` 发布合并（PR #6408），精确引用为 `refs/customizations/upstream-base`；该基线不代表官方最新版本。
- 自定义分支：`develop`。历史结构为“官方历史 → 官方基线 → 按功能组织的自定义提交”。
- `origin` 指向个人 Fork，本地 `master` 跟踪 `origin/master`。远端 `master` 是官方镜像分支，不包含自定义提交；此布局不依赖 `upstream` remote。
- 本地 Git 配置：`pull.ff=only`、`push.default=simple`、`remote.pushDefault=origin`。这些配置不随克隆传递。

## 自定义功能

### Git 操作规范

- **差异与目的**：要求明确授权暂存或提交，提交信息采用 Conventional Commits、中文标题和中文为主的正文，提交仅包含授权范围，禁止擅自改写或推送历史。规则由 [根目录指令](AGENTS.md#git-提交) 拥有。
- **依赖与关注**：官方仓库指令及 Git hooks；关注官方新增的权限、提交语言、历史整理和推送规则。
- **调整条件**：官方已有等价规则时合并重复内容；存在冲突时先确认，不用本地维护文档覆盖更高优先级规则。

### 本地开发与打包命令

- **差异与目的**：[自定义命令](CUSTOM_COMMANDS.md) 增加代理／无代理 Desktop 启动、继承环境清理、代理安装及 Apple Silicon 本地无发布签名 DMG 示例；没有另造 CLI 或打包器。
- **依赖与关注**：[根脚本](package.json)、[Desktop 开发与打包说明](apps/desktop/README.zh.md)、[登录 shell 环境合并](apps/desktop/src/login-shell-environment.ts)。关注脚本名称、环境变量、默认数据目录、代理合并、下载代理、签名和产物目录变化。
- **调整条件**：官方覆盖同等使用场景时改为链接官方说明；命令失效时先确认替代路径，不保留无效示例。

### 正式版应用与 Host 重启菜单

- **差异与目的**：正式版也显示官方原生“重启应用与 Host”入口；沿用原有免确认重启、Host 关闭及 Electron relaunch 流程，页面刷新仍仅在开发版显示。
- **入口与依赖**：[Desktop 主进程](apps/desktop/src/main.ts)、[菜单预期输出](apps/desktop/tests/expected/restart-menu/darwin-packaged-zh-CN.txt)、[启动测试](apps/desktop/tests/main-startup.spec.ts)。依赖菜单构建、退出确认、Host teardown 和 relaunch。
- **调整条件**：官方开放等价正式版入口时移除重复修改；官方变更退出或重启顺序时先确认，并同时复查显示器记录的 flush。

### 主窗口显示器记忆

- **差异与目的**：新启动时仅记忆显示器，在完整布局匹配时以默认大小居中；不恢复窗口几何、最大化或全屏状态。行为由 [Desktop 窗口说明](apps/desktop/README.zh.md#关闭窗口与退出) 拥有。
- **入口与依赖**：[显示器记录](apps/desktop/src/display-memory.ts)、[主进程](apps/desktop/src/main.ts)、[显示器测试](apps/desktop/tests/display-memory.spec.ts)。依赖 Electron screen／userData、默认窗口尺寸、原子写入及退出、重启、更新交接；设备本地记录不属于 Session 数据。
- **调整条件**：官方窗口恢复覆盖同等要求时先比较布局失配、数据隔离与关闭时写入保证，再决定复用或移除；不直接叠加两套窗口恢复机制。

### Codex 账户、模型目录与账户信息

- **差异与目的**：[账户插件](packages/llm/llm-codex-account/README.zh.md) 为 Web/Desktop 默认提供 Codex OAuth 控件、模型目录编辑，以及输入栏 DeepSeek 余额和 Codex 配额；不自动登录，不改变 Headless／SDK 默认组合。
- **入口与依赖**：[Host 授权桥接](packages/llm/llm-codex-account/src/host/bridge.ts)、[账户信息请求](packages/llm/llm-codex-account/src/host/provider-info.ts)、[Web 组合](packages/bundle/web-app/cordis.patch.yml)、[RPC 注册](packages/client/connection/src/rpc-host.ts)。复用官方 authorization、credentials、pi-ai、settings、Connection 和客户端 slots，不增加第二套令牌存储或推理流程。连接沿用 browser/API Peer 隔离；凭据沿用官方已保存记录优先于环境变量的规则。
- **上游关注**：OAuth 回调及刷新、凭据优先级、provider 配置和模型目录保存语义、RPC carrier 生命周期、settings／composer slots；另外关注 Codex 内部配额端点和 DeepSeek 余额响应变化。[网页搜索设置](packages/client/ui-settings-web-search/README.zh.md)默认与聊天、余额共用 DeepSeek 凭据引用，需保持凭据更新后的余额刷新；官方模型名称角标不替代账户信息或目录编辑。
- **调整条件**：官方提供同类控件时比较既有配置保留、退出登录范围和信息不可用的表现；覆盖的部分优先复用，剩余功能仍独立维护。通用 Models 页与账户页的目录编辑能力重叠，但账户页仍保留 OAuth、额度及原有目录入口；移除入口前确认可达性和迁移体验。配额请求失败不能显示为零。

### Codex WebSocket 错误分类

- **差异与目的**：对精确 `openai-codex` provider 的未分类、文本精确为 `WebSocket error` 或匹配 `WebSocket closed 1000/1006` 的错误补为 `TRANSPORT`，复用官方重试；不改变错误原文、取消、已有分类优先级、transport 或代理。
- **入口与依赖**：[pi-ai 流转换](packages/llm/llm-pi-ai/src/stream.ts)、[转换回归](packages/llm/llm-pi-ai/tests/convert.spec.ts)、[无密钥重试场景](snapshots/session/codex-websocket-retry/snapshot.yml)。依赖 pi-ai 错误文案、Codex 关闭语义及原生 retry policy。
- **调整条件**：官方已正确分类时删除本地特例；pi-ai 提供结构化 code／cause 或改变文案时先确认结构化替代。除精确的 `WebSocket error` 外，不为缺少关闭码的错误扩大匹配。

### 基于 PTC 的独立 Coding 模式

- **差异与目的**：[Coding 插件](packages/preset/coding-preset/README.zh.md) 在加载时派生发行版 PTC 声明，并追加[四级委派策略](packages/preset/coding-preset/policy.md)；保留 Standard、PTC 和默认选择。策略只提供提示词指导，不强制运行时模型选择。
- **入口与依赖**：[派生实现](packages/preset/coding-preset/src/index.ts)、[来源路径配置](packages/bundle/web-app/presets/coding.patch.yml)、[官方 PTC 声明](packages/bundle/web-app/presets/ptc.patch.yml)、[模式选择文案](packages/client/ui-agent-preset/src/client/locales.ts)。依赖 preset／persona schema、PTC mode、子代理模型选择和模型路由；继承官方 PTC 工具禁用声明及 Host runtime 对应的函数体／REPL 工具指引。PTC 执行状态由 Host runtime 配置决定，Coding 不自行启用内存持久模式；L0–L3 表示模型等级，不改变委派深度或 schedule 执行权限。
- **调整条件**：官方 PTC 声明、persona 或工具暴露改变时先检查继承结果；来源不兼容时明确失败，不回退旧副本。官方有等价 Coding／委派策略时先确认复用或移除；模型变更不静默替换。

### 会话批注与通用接入

- **差异与目的**：[批注插件](packages/client/conversation-annotations/README.zh.md) 支持已完成助手正文和表格的选区、评论、普通 queue／steer 提交、准备后恢复、历史摘要与精确来源跳转。Web/Desktop 默认启用；Headless 和子代理不提供入口。
- **插件入口**：[Host](packages/client/conversation-annotations/src/host.ts)、[Client 控制器](packages/client/conversation-annotations/src/client/controller.ts)。批注文字作为普通用户文本记录；结构化来源和提交尝试由插件 sidecar 拥有。RPC 仅接受共享 browserPeer，独立 API Peer 即使是 owner 也不开放批注端点。
- **支撑接口**：[composer contributions](packages/client/ui-conversation/src/client/contract/contributions.ts)、[提交编排](packages/client/ui-conversation/src/client/submission-contributions.ts)、[Chat 文本接口](packages/client/ui-chat/src/client/contract/text.ts)、[文本宿主](packages/client/ui-chat/src/client/text-host.ts)、[Markdown 文本表面](packages/client/ui-primitives/src/markdown/text-surfaces.ts)、[Session 接收](packages/api/session-controller/src/commands.ts)、[客户端历史加载](packages/api/session-controller/src/client/sessions/session.ts)。支撑冻结修订、持久接收证据、同请求身份重试、附加摘要和来源导航；接收流程保留 Remote 传入的 principal／时区来源。展示链沿用官方 UserContent／UserText 和图片 slots，不重建用户文本解析；`loadThrough` 不覆盖目标时明确失败。
- **上游关注**：文本渲染与定位、command chip／草稿恢复、contribution 生命周期、请求身份与 admission 回执、Session durability／历史加载、文件上传凭据和 GC、storage-domain、Connection 及消息 slots。命令块提交不消费普通消息的 contribution；普通提交在异步序列化前冻结贡献修订，完成后不覆盖期间产生的新草稿。批注和支撑接口作为一组维护；移除支撑前必须确认全部消费者。
- **调整条件**：官方新增批注或通用选区／提交接口时逐层比较并先确认。优先替换通用接入，再评估插件剩余能力；不能仅删除插件后认定核心差异也可删除。持久化保证由[提交所有权决策](.agents/notes/implemented/architecture/2026-10-14-annotation-submission-ownership.zh.md)解释。
- **保留限制**：sidecar 与 Session 不构成事务；结果不确定时保留原身份，不保证崩溃后恰好执行一次。prepare 前草稿不持久化；仅复制／导出 Session 不包含结构化 sidecar；文件重试依赖原字节仍可用，不增加附件保留策略，不迁移旧批注数据。沿用[官方 Search／Fetch API](packages/web/web-deepseek-api/README.zh.md)默认行为；用户启用新搜索 API 后，已提交批注作为普通用户文本，也可能被附带为原问题片段，不增加批注专用过滤。

### 仓库引用检查的锁文件数字处理

- **差异与目的**：[引用检查](scripts/verify-repository-references.ts)仅对 `uv.lock` 的数字 `size` 字段排除 Git 提交前缀匹配，避免 wheel 大小碰巧命中本地提交。普通文档、锁文件其他字段及同一行的其他提交标识仍受检查，组织 URL 检查保持启用。
- **依赖与退出条件**：依赖锁文件字段格式及本地提交候选集合；官方提供等价处理时移除重复修改，不豁免整个锁文件。

## 已知限制

- 真实 OAuth／令牌刷新／配额／余额、真实四级模型委派，以及 Desktop 重启、多显示器、热插拔与更新交接尚缺实机验收；单元测试不能替代这些验收。
- 客户端分层检查存在违规，聚焦功能测试不覆盖静态分层约束。
- [用户文本密钥掩码浏览器用例](apps/web/tests/user-text-secret-mask.e2e.ts)的揭示前后几何严格相等断言存在 1/64 像素差异。
