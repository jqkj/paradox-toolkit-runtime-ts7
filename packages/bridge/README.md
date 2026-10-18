# Toolkit 运行时加速 + TS7 开发检查适配

这是第三方适配预览版 `0.5.5-runtime.1`，基于上游 Toolkit 0.5.5、LSP 0.3.8。
源项目：[JDeffner/paradox-modding-toolkit](https://github.com/JDeffner/paradox-modding-toolkit)，
基线提交 `4a3e210a74d40af91907f52753dd118f8fe8c3ea`。原作者署名与 GPL-3.0-or-later 保留。

## 两项改进

1. **使用 Toolkit 查询游戏/模组时**：目录排除减少无关索引；会话内 token 预筛减少引用扫描读取量；文件监听保证修改、新建、删除后索引更新。
2. **开发 Toolkit 本身时**：TS7 可选类型检查。TS5 仍保留给既有 lint 与兼容检查。运行时查询提速来自前述索引改动，不来自 TS7。

## 从源码构建

使用 Node 24.19.0 或满足根目录 engines 的更新版本，以及 `pnpm@11.25.0`：

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run typecheck:ts7
pnpm --filter px-runtime-bridge run build
pnpm --filter px-runtime-bridge test
```

生成目录：`packages/bridge/dist/paradox-toolkit-0.5.5-runtime.1/`。
其中的 LSP 每次直接从本仓库源码编译；不会下载 npm 的旧 LSP 来替换修复版。
运行件已打包依赖，需要本机 Node 24；无需在运行件目录安装 npm 依赖。
源码 ZIP 解压后也可执行上述命令，不要求安装 Git。发行源码包附带 `runtime-source.json` 记录提交；
没有该元数据的下载仍能构建，但 `sourceCommit` 显示为 null。ZIP 构建的 `sourceDirty` 为 null，表示无法判断本地改动。

## MCP 客户端

在客户端的 stdio MCP 配置中，command 填 Node 可执行文件，args 填生成目录中
`mcp-server.cjs` 的绝对路径。通过环境变量配置你自己的路径：

| 环境变量 | 用途 |
| --- | --- |
| `PX_GAME_PATH` | 游戏的 game 目录；可留空，仅分析模组 |
| `PX_MOD_PATH` | 一个模组源码根目录 |
| `PX_LOGS_PATH` | 自己生成的 script_docs/logs；可留空 |
| `PX_STORAGE_DIR` | 缓存目录；默认用户主目录下 `.cache/px-lsp/pi-codex` |
| `PX_LOC_LANGUAGE` | 默认 `simp_chinese`，也可用 `english` |
| `PX_INDEX_EXCLUDE_DIRECTORIES` | 顶层目录名的 JSON 数组，如 `["docs","test","backup"]`；默认 `[]` |

运行后先调用 `px_status`，确认 `runtimeBuild` 为 `runtime-ts7-0.5.5-runtime.1`。
再调用 `px_wait_for_index` 等待索引；空项目使用 `minimumDefinitions: 0`。
工具 `px_configure` 可设置多模组 `workspaceMods`、父模组 `parentPaths`、排除目录等。
不要排除实际存放游戏脚本的目录。路径不持久写回配置，重连后仍以环境变量为准。

客户端若仍显示旧 runtimeBuild，需要重新启动该 MCP 连接。替换磁盘文件不等于旧进程已重载。
修改源文件后无需重连，桥接层会监听磁盘变化；显式传入的未保存文本不会被磁盘覆盖。

## PI-Desktop

将整个生成目录作为本地插件导入（保留 manifest.json、main.js、views 和 vendor）。
在插件设置填写 gamePath/logsPath；模组目录取当前 PI 工作区。
插件 ID 保留 `local.paradox-toolkit`，升级前备份原目录并停止旧插件，避免同时加载两个副本。
PI 入口已构建，实际 PI 界面导入与完整 GUI 交互尚未验证。

## GitHub 流程

`Runtime adaptation` 工作流对分支推送和 PR 在 Windows/Linux 上运行检查、构建、MCP 测试，上传可下载的运行件和 SHA256。
默认只生成 Actions 构建产物。需要发布时，从指定分支手动运行该工作流并勾选 `publish`。
两平台验证通过后，它才会为该次提交创建 `runtime-v0.5.5-runtime.1` 标签及 GitHub 预发布版。
同名标签/Release 已存在时失败，避免覆盖旧版。再发布需更新 bridge 版本、manifest 与发布说明，MCP 版本自动取 bridge 版本。
手动工作流按钮需工作流先进入仓库默认分支；可将当前开发分支设为默认分支。

上游商城、npm 和网站发布工作流仅在上游仓库运行。本适配流程不需要它们的发布密钥。
新维护者先在自己的仓库跑通 Actions；本地验证不能替代 GitHub 执行记录。

## 性能和验证边界

详见源码中 `docs/release/runtime-0.5.5-runtime.1.md`。
第一次引用查询仍需建立预筛表，可能更慢；后续不同符号查询受益，重复同名查询另有既有缓存。
没有持久化预筛表，每次重启重新建立。不承诺所有功能或所有项目都提速十倍。
源码包包含上游依法随项目分发的数据与许可声明，不包含维护者的模组、游戏安装目录、日志或私人缓存。
