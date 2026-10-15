# Agent Note: 大脑（Brain）知识库能力缝

Status: implemented

[English](2026-08-18-brain-knowledge-vault-seam.md) | 中文

## Problem

Web 界面原本无法呈现一个人已有的 Markdown 知识：侧边栏只能浏览工作区（Workspace）和会话（Session），也没有任何宿主能力可以把一个只读的笔记目录暴露给浏览器或模型。拥有 Obsidian 风格知识库的人希望这些知识出现在侧边栏（“Asel 的大脑”），并在后续阶段能让任意会话通过按需工具访问——同时又不让 harness 耦合 Obsidian 自身的格式，也不写回知识库。

把该功能并入 Workspace 域是错误的，原因有二：Workspace 拥有项目目录和按目录的会话记账，而知识库是单个只读目录、没有会话；同时面向模型的访问路径（工具）与 UI 的读取路径是两个不同的消费者。

## Decision

知识库是一等公民的只读能力缝，镜像 `ctx.fs` / `ctx.web`：

1. `@deepseek-ai/dsh-brain`（`packages/knowledge/brain`）是服务定义：`BrainStatus` / `BrainTreeNode` / `BrainSearchMatch` 词汇、`BrainError` 错误码，以及抽象的 `ctx.brain` 服务，含 `status`、`list`、`search`、`read`。所有地址都是库相对路径、以 `/` 分隔的字符串。
2. `@deepseek-ai/dsh-brain-local`（`packages/knowledge/brain-local`）是提供者：遍历配置的目录，提供文件夹/笔记树、进程内带边界的子串搜索和单笔记读取。它注册一个 `brain` 设置命名空间（path 以及 `maxResults` / `maxFileBytes` / `maxSnippetChars` 边界），叠加在组合条目之上，因此设置界面可以实时改指路径。
3. 线上是三个宿主 RPC——`brain.list`（`{ status, tree }`）、`brain.search`（`{ items }`）、`brain.read`（`{ path, title, content }`）——位于 `packages/host/apiproxy/src/api/brain.ts` + `brain.schema.ts`，并新增 `brain-*` 错误码。未配置知识库时 `brain.list` 以 `status.configured === false` 作为成功返回；只有 `read` 会失败（`brain-unconfigured` / `brain-not-found` / `brain-invalid-path` / `brain-io`）。
4. `@deepseek-ai/dsh-client-ui-brain`（`packages/client/ui-brain`）注册 `sidebar.brain` 槽位（由 `ui-sidebar` 声明，渲染在 `sidebar.workspaces` 之上）：区头 + 搜索框、可折叠的文件夹/笔记树，以及带返回按钮的内联 Markdown 阅读视图。知识库基线位于客户端对象层（`dsh-client-runtime` 中的 `BrainRuntime`），通过新的 `useBrain` 标准 hook 暴露，与 `useWorkspaces` 一致。
5. `ui-settings-plugins` 提供以 `brain` 命名空间为键的 `BrainCard`，因此知识库路径可在 设置 → 插件 下编辑。

知识库按设计只读：提供者没有任何方法修改目录，浏览器也从不接受任意宿主路径（只接受库相对路径，绝对路径或逃逸路径会被拒绝）。搜索是进程内子串扫描而非索引或向量——有边界，保证大知识库不会撑爆结果或扫描规模，日后可升级为 ripgrep/FTS。

## Alternatives considered

### 为什么不复用 Workspace 域？

知识库不是 Workspace：Workspace 携带会话记账、按目录的项目语义和目录选择流程。把知识目录当作 Workspace 会把它显示在错误的分区下，并给它本不存在的会话行。能力缝让两个域保持独立。

### 为什么不直接复用 `ctx.fs` + 现有 ripgrep 工具？

`ctx.fs` 是 agent 的沙箱文件系统能力，按会话限定且受权限门控；而知识库是宿主级、始终只读的资源，被 UI 和（后续）工具共享。专用的 `ctx.brain` 提供唯一的包含边界（仅库相对路径）和唯一的设置命名空间，而不是把库路径知识散落在各消费者之间。

### 为什么现在不用索引或向量？

初始消费者是个人知识库，小到带边界的子串扫描已经足够正确和简单。索引（SQLite FTS 或 ripgrep）或向量检索会在只读呈现尚不存在之前就引入持久缓存、同步问题和模型注入设计。`brain` 缝把搜索实现留在提供者之后，因此可以换掉实现而不动线上契约或 UI。

## Consequences

- 新增三个包、一个设置命名空间以及三个 `brain.*` RPC；该缝是库路径、包含和搜索边界唯一的拥有者。
- 侧边栏在 Workspace 浏览器之上新增一个有边界的区；侧边栏折叠为窄轨时，该区卸载（仅宽模式）。
- 尚无面向模型的工具：按需 `brain_search` / `brain_read` 消费者推迟到后续阶段，写回、wikilink/反链和图视图同样推迟。
