# 自定义命令

## 摘要

在仓库根目录使用 Bash 或 zsh 执行以下命令，可启动 Desktop 开发环境、打包本地 macOS DMG 及安装依赖；开发启动、本地 DMG 打包和依赖安装提供代理示例。示例代理地址为 `http://127.0.0.1:1080`，执行前请确认代理已运行，或替换为自己的地址。括号创建子 shell，环境变量修改不会影响外层 shell。开发前提见 [Desktop 开发说明](<apps/desktop/README.zh.md#开发>)。

## 目录

- [Desktop 开发启动（代理）](#desktop-开发启动代理)
- [Desktop 开发启动（无代理）](#desktop-开发启动无代理)
- [Desktop 本地 DMG 打包](#desktop-本地-dmg-打包)
- [安装依赖（代理）](#安装依赖代理)

## Desktop 开发启动（代理）

显式清除继承的 `DSH_HOME`、`DSH_DESKTOP_USER_DATA_DIR` 和 `DSH_DESKTOP_PRIMARY_RUNTIME_DIR`，使用开发启动器默认的数据目录和运行时；清除 `ELECTRON_RUN_AS_NODE`，避免 Electron 以 Node 模式启动。关闭自动打开 Renderer DevTools，并设置独立的调试端口。

```bash
(
  unset DSH_HOME DSH_DESKTOP_USER_DATA_DIR DSH_DESKTOP_PRIMARY_RUNTIME_DIR
  unset ELECTRON_RUN_AS_NODE
  unset ALL_PROXY all_proxy

  export HTTP_PROXY=http://127.0.0.1:1080
  export HTTPS_PROXY="$HTTP_PROXY"
  export http_proxy="$HTTP_PROXY"
  export https_proxy="$HTTP_PROXY"
  export NO_PROXY=localhost,127.0.0.1,::1
  export no_proxy="$NO_PROXY"
  export NODE_USE_ENV_PROXY=1
  export ELECTRON_GET_USE_PROXY=1

  export DSH_DESKTOP_OPEN_DEVTOOLS=0
  export DSH_DESKTOP_MAIN_INSPECT_PORT=19229
  export DSH_DESKTOP_RENDERER_DEBUG_PORT=19222
  export DSH_DESKTOP_HOST_INSPECT_PORT=19230

  pnpm run dev:desktop
)
```

已构建且源码未修改时，可将最后一条命令替换为 `pnpm run start:desktop`，跳过构建；缺失的运行时资源仍可能下载。成功启动后应看到开发 Desktop 窗口；启动器输出实际数据目录和调试端口。若调试端口被占用，请调整对应变量后重启。

Desktop 后端默认使用系统分配的端口，以上命令不设置 `DSH_DESKTOP_PORT`。后端和数据隔离规则见 [Desktop 文档](<apps/desktop/README.zh.md>)；macOS 开发启动会注册开发应用为 `dsh://` 默认处理程序，启动打包应用会重新注册打包版。

macOS/Linux Desktop 会读取登录 shell 环境，shell 启动文件导出的代理变量可能覆盖这里的 HTTP/HTTPS 代理配置。若实际代理与预期不同，请检查 shell 启动文件；具体合并规则见 [登录 shell 环境合并实现](<apps/desktop/src/login-shell-environment.ts#L89-L103>)。

## Desktop 开发启动（无代理）

清除当前命令组内的代理环境变量，不影响外层 shell；数据目录和调试设置与代理版本相同。

```bash
(
  unset DSH_HOME DSH_DESKTOP_USER_DATA_DIR DSH_DESKTOP_PRIMARY_RUNTIME_DIR
  unset ELECTRON_RUN_AS_NODE
  unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
  unset NO_PROXY no_proxy NODE_USE_ENV_PROXY ELECTRON_GET_USE_PROXY

  export DSH_DESKTOP_OPEN_DEVTOOLS=0
  export DSH_DESKTOP_MAIN_INSPECT_PORT=19229
  export DSH_DESKTOP_RENDERER_DEBUG_PORT=19222
  export DSH_DESKTOP_HOST_INSPECT_PORT=19230

  pnpm run dev:desktop
)
```

已构建且源码未修改时，可将最后一条命令替换为 `pnpm run start:desktop`。如果登录 shell 启动文件导出了代理变量，也需禁用这些导出；上述命令不会关闭操作系统或应用内单独配置的代理。

## Desktop 本地 DMG 打包

在 Apple Silicon（arm64）Mac 上安装依赖后，在仓库根目录执行以下完整命令，通过 HTTP 代理下载打包资源；无需 `.env.macos`、Apple 账号或发布证书。`1080` 必须是 HTTP 或 mixed 代理端口，不能是仅支持 SOCKS 的端口。

```bash
(
  unset ALL_PROXY all_proxy

  export DSH_DESKTOP_MACOS_DOWNLOAD_PROXY=http://127.0.0.1:1080
  export HTTP_PROXY="$DSH_DESKTOP_MACOS_DOWNLOAD_PROXY"
  export HTTPS_PROXY="$HTTP_PROXY"
  export http_proxy="$HTTP_PROXY"
  export https_proxy="$HTTP_PROXY"
  export NO_PROXY=localhost,127.0.0.1,::1
  export no_proxy="$NO_PROXY"
  export NODE_USE_ENV_PROXY=1
  export ELECTRON_GET_USE_PROXY=1

  pnpm run package:desktop:mac:arm64:unsigned
)
```

命令完成构建、运行时检查及 DMG 生成后，打印 `DMG:` 和产物的绝对路径；产物位于 `apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/deepseek-harness-<version>-mac-arm64-unsigned.dmg`。添加 `--check` 仅检查配置和工具，不构建；不要添加 `--dir`，否则只生成 `.app`，不会生成 DMG。

Electron 应用使用本地 ad-hoc 签名，DMG 不签名、不公证，且不配置自动更新。命令不会自动安装或启动；手动打开 DMG 并复制其中的应用即可。签名、配置隔离及 macOS 打开限制见 [本地 DMG 打包说明](<apps/desktop/README.zh.md#无发布签名的本地-macos-dmg>)。

## 安装依赖（代理）

按锁文件安装，不更新依赖版本。此操作可能执行依赖和仓库的安装后脚本；安装成功不等于已构建产品或已准备全部 Desktop 运行时资源。

```bash
(
  unset ALL_PROXY all_proxy

  export HTTP_PROXY=http://127.0.0.1:1080
  export HTTPS_PROXY="$HTTP_PROXY"
  export http_proxy="$HTTP_PROXY"
  export https_proxy="$HTTP_PROXY"
  export NO_PROXY=localhost,127.0.0.1,::1
  export no_proxy="$NO_PROXY"
  export NODE_USE_ENV_PROXY=1
  export ELECTRON_GET_USE_PROXY=1

  pnpm install --frozen-lockfile
)
```

安装命令应以零状态退出；锁文件与清单不匹配时先检查差异，不要为绕过错误而移除 `--frozen-lockfile`。Electron 二进制的准备要求见 [Desktop 文档](<apps/desktop/README.zh.md#开发>)。

## 开发备注

`dev:web` 和 `dev:desktop` 在启动前执行 `build:artifacts`，不包含测试与脚本的聚合类型检查。完成开发后应在最新产物上运行 `pnpm run build:check`，或运行完整的 `pnpm run build`。`--from-default-profile` 会替换已有自定义 profile（包括 patches 和依赖），不是日常启动参数。

本次迁移仅核对了源码、命令语法、局部链接和模拟 pnpm 的环境隔离。真实代理下载及 Desktop GUI 启动需由开发者按本文命令手动验证，尚未完成端到端验收。
