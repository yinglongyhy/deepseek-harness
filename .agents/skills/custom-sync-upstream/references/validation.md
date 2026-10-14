# 同步验证

按执行前预览中的影响范围选择验证项，并检查自定义维护清单中的已知限制；不要默认运行全仓套件。命令和路径须与本次目标版本核对，入口变化时查找其当前所有者，不跳过受影响验证。

以下是聚焦验证入口，不代表已通过全部平台和真实服务验收。测试从仓库根目录运行；本地连接测试应清除继承的 HTTP／HTTPS／ALL_PROXY 变量，避免 localhost 被代理。浏览器验证需要匹配的构建产物；只读回放使用 `DSH_SNAPSHOT=replay`，不为同步自动刷新预期输出。

| 范围 | 最小验证入口 |
|---|---|
| 发行版本 | `pnpm run release:verify --family dsh`；自定义包版本须与目标 DSH 发行族一致，此检查不代表 DMG 已成功打包 |
| 文档与指令 | `pnpm run test:docs`、`pnpm run doc-sync`、`git diff --check` |
| Desktop 菜单、显示器与关闭流程 | `pnpm exec vitest run apps/desktop/tests/display-memory.spec.ts apps/desktop/tests/main-startup.spec.ts apps/desktop/tests/welcome-startup.spec.ts` |
| 账户功能与 RPC 生命周期 | `pnpm exec vitest run packages/llm/llm-codex-account/tests packages/client/connection/tests/rpc-host-carrier.host.spec.ts` |
| WebSocket 分类 | `pnpm exec vitest run packages/llm/llm-pi-ai/tests/convert.spec.ts`；[Session 回放](../../../../snapshots/session/headless.snapshot.ts)选择 `codex-websocket-retry` |
| Coding 派生 | `pnpm exec vitest run packages/preset/coding-preset/tests/loader-composition.spec.ts`；[Web Session 回放](../../../../apps/web/tests/coding-preset.snapshot.ts)及[模式选择](../../../../apps/web/tests/agent-preset-selection.e2e.ts) |
| 批注、文本与提交恢复 | `pnpm exec vitest run packages/client/conversation-annotations/tests packages/client/ui-conversation/tests/contributions.client.spec.ts packages/client/ui-conversation/tests/service-orchestration.client.spec.ts packages/client/ui-chat/tests/text-host.client.spec.ts packages/client/ui-primitives/tests/markdown-text-surfaces.client.spec.tsx packages/api/session-controller/tests/commands-queue-attachment.host.spec.ts packages/api/session-controller/tests/commands-upload-file.host.spec.ts` |

浏览器补充入口：[账户设置](../../../../apps/web/tests/codex-account.e2e.ts)、[会话批注](../../../../apps/web/tests/conversation-annotations.e2e.ts)。正式验收还需要真实 OAuth／令牌刷新／配额／余额、真实四级模型委派，以及 Desktop 重启、多显示器、热插拔与更新交接；这些不由单元测试替代。

记录本次命令和结果，区分通过、失败及未执行；不要把执行日志、测试数量或排查经过写回事实清单。
