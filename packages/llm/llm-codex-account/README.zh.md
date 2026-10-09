---
description: "登录本机 Codex 账号、管理模型目录，并查看官方 DeepSeek 余额或 Codex 额度。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-codex-account

[English](README.md) | 中文

## 概述

为 `openai-codex` 路由登录 ChatGPT、编辑其模型目录，并在输入栏查看官方 DeepSeek API key 余额或 Codex 额度。登录复用已安装的 pi-ai 授权实现和凭据存储；不会自动启动登录。本机浏览器回调要求 Host 与浏览器位于同一台电脑。账号和额度指示器不能证明模型请求一定成功。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

Web/Desktop 组合默认包含此插件；此独立包不是 profile bundle，也没有 `dsh plugin add` 安装路径。

### 何时选择

当本机 Web 或 Desktop Host 需要 Codex OAuth 控件、模型目录编辑或账号信息时使用此包。通过 `llm-codex-account` 行挂载；不用于 headless 或 SDK 组合。它复用现有 pi-ai 授权和 provider，而不添加第二套 OAuth 或模型请求流程。

### 最小配置

已交付的 Web 与 Desktop profile 默认启用此行。自定义组合可以这样挂载：

```yaml
- id: llm-codex-account
  name: '@deepseek-ai/dsh-llm-codex-account'
```

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `providerInfoRefreshIntervalMs` | `60000` | 账号信息缓存与输入栏刷新间隔，单位毫秒（`10000`–`86400000`）。 |
| `providerInfoRequestTimeoutMs` | `10000` | 账号信息请求的最长时间，单位毫秒（`1`–`120000`）。 |
| `pollIntervalMs` | `1000` | 登录期间浏览器轮询间隔，单位毫秒（`250`–`30000`）。 |
| `loginDeadlineMs` | `300000` | 单次登录尝试的最长时间，单位毫秒（`1`–`86400000`）。 |
| `attemptLeaseMs` | `60000` | Host 在无轮询后释放尝试前等待的时间；至少为轮询间隔的四倍，最多 `86400000` 毫秒。 |
| `attemptRetentionMs` | `300000` | Host 保留已完成尝试供轮询查询的时间；至少一个轮询间隔，最多 `86400000` 毫秒。 |

Host 在加载时校验这些字段；租约或保留时长低于对应轮询要求时会加载失败。本表依据 Host `Config` schema。

### 登录并选择路由

打开“设置 → Codex 登录”即可登录、取消进行中的尝试、重新打开授权页或退出登录。页面加载时不会登录。此页面上的新登录成功后，仅当 `providers.openai-codex` 不存在时才添加 `{}`；不会替换任何既有 provider 配置，包括 API key 覆盖。若自动启用路由失败，页面会提供重试；底层 Host 也支持显式启用路由操作。既有 `apiKeyEnv` 配置仍遵循官方适配器的鉴权优先级。

退出登录不会撤销服务端已有授权。退出只删除本机 Codex 凭据记录，不删除路由配置。若要禁用此内置功能，请将 `llm-codex-account` 行设为 `disabled: true`；如果之后可能重新启用，请保留其设置和凭据。

### 编辑模型目录

设置页列出已发现的模型，并支持添加、编辑和删除目录条目。编辑内容在保存前只是草稿。保存仅修改 `models`；其他 provider、`apiKeyEnv`、`modelOverrides` 和模型行隐藏字段均会保留。继承默认目录与显式空目录不同：“恢复默认”会取消设置 `models`，空列表则会在选择器中隐藏模型。目录元数据不代表账号具有使用权限。

### 查看账号信息

当 provider 为 `deepseek-official` 时，输入栏显示官方 DeepSeek API key 余额；当 provider 为 `openai-codex` 时，显示 Codex OAuth 的 5 小时和每周额度。查询缺失、不受支持或失败时隐藏指示器，不会把失败显示为零。有效的零余额或零额度仍会显示。Codex 额度依据上游窗口时长识别，不假定 primary 与 secondary 窗口固定对应某一周期。

Host 执行带凭据的网络请求，只返回允许字段中的余额、额度与时间信息，并进行清理。上游错误与响应文本不会向外传递。提供方信息是有时限的探测，不会预留额度。

<a id="understand-the-implementation"></a>
## 理解实现

此包包含 Host 和 Client 两个编译面。Host 负责登录尝试、回调端口可用性探测、提供方信息请求和最小化的路由启用操作。Client 通过现有 slots 提供设置控件、目录编辑器与输入栏指示器。两个编译面均使用已有 authorization、credentials、pi-ai provider、settings 和 Connection 服务，不会另行实现令牌刷新或推理流程。

<a id="further-exploration"></a>
## 进一步探索

- [LLM 提供方适配器](../README.zh.md)——包组导航与 provider 选择。
- [pi-ai provider 路由](../llm-pi-ai/README.zh.md)——provider 配置和凭据优先级。
- [LLM 流式子系统](../../../docs/subsystems/llm-streaming.zh.md)——模型请求与适配器行为。

<a id="model-experience"></a>
## 模型体验

### `openai-codex` 账号状态和模型目录

#### 模型看到什么

此包不会向 `openai-codex` 请求添加模型可见文本。账号状态和目录供客户端与模型选择器使用，不会插入模型输入。

#### Token effect

此包不增加输入 token。实际用量取决于所选模型与请求。

#### KV Cache effect

此包不添加模型输入前缀，也不改变 KV cache 行为。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- OAuth 要求浏览器与 Host 在同一台电脑上运行，以便官方流程接收 `localhost:1455` 回调。`PI_OAUTH_CALLBACK_HOST` 必须指向回环地址；端口探测只是瞬时检查，并不占用端口，登录仍受最长时限约束。
- Codex `/wham/usage` 是上游内部接口，可能发生变化。它不是权限检查或额度预留。账号记录存在本身不能证明凭据有效。
- 账号指示器不支持自定义 Codex `baseURL`、`api` 或 `apiKeyEnv` 路由，也不支持 DeepSeek 账号 token 鉴权或非官方 DeepSeek API 地址。
- 替换旧的外部 `dsh-openai-codex-oauth` 插件时，必须先在用户 profile 层禁用或移除其激活项，再启用内置行。内置功能不会迁移或删除旧插件、其设置或凭据。
- 真实 OAuth 验证需要手动使用启用了账号的环境检查；自动化测试不会使用真实账号登录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>实现与验证备注——点击展开</summary>

Host 仅接受本机回环回调配置，并使用已安装的 pi-ai OAuth 实现。回调端口探测后会立即释放端口，因此 OAuth 监听器启动前其他进程仍可能占用该端口。提供方信息响应会限制大小，并在通过 Connection 传递前缩减为文档规定字段。维护时应将 settings（`SettingsConflictError`）、credentials（`credentialRef`）、pi-ai（`recordKeyFor`）、deepseek-api-key 配置辅助函数和 launch-environment（`launchEnvironmentOf`）的运行时导入归类为 peer import；不要添加 safe-export allowlist。

</details>
