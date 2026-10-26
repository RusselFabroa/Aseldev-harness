# @deepseek-ai/dsh-market-npm

[English](README.md) | 中文

[`dsh-market`](../market/README.md) 的 npm 注册表 Service Provider。`NpmMarketService` 注册 `ctx.market`，并针对 `registryUrl`（默认 `https://registry.npmjs.org`）处的注册表实现两个 seam 操作。

**搜索。** 一次对 `/<...>/-/v1/search?text=<query>&size=<n>` 的请求返回索引候选；随后抓取每个候选已发布的 manifest，以确认它是 DSH 插件并读取权威的版本与描述。该过滤器是索引无法回答的唯一信号：当一个包发布在 `@deepseek-ai/dsh-` 之下，或它已发布的 `package.json` 带有真值的 `dsh` 字段（DSH bundle 发布的 `dsh.bundle` 段与浏览器插件发布的 `dsh.client` 段）时，它就是 DSH 插件。注册表在该版本上没有的候选，或不满足任一规则的候选，会被丢弃而不是作为错误报告。条目数量是调用方请求被 `maxResults` 夹取后的结果。

**安装。** 请求的包名与版本 pin 先按 npm 的名称语法和精确版本语法校验，该精确版本的 manifest 必须通过同一套发现过滤器，然后 `packageManager` 以 profile 目录为工作目录、经由 `ctx.subprocess`（绝不使用 `child_process`）运行 `add <name>@<version>`，其 store 位于 `<dshHome>/profiles/.pnpm-store`。随后 profile 的 `cordis.patch.yml` 增加一行 insert 记录（`id: market-<slug>`、`name: <package>`），下次启动时由 profile 层通过该 profile 自己的 `node_modules` 解析它 —— 也就是启动器对裸行已使用的模块解析路径。重复安装同一个包是幂等的：已存在命名该包或其 id 的记录会保留。

本包从不挂载它安装的东西。Loader 在启动时通过 Node 解析记录，而启动之后安装的包不存在可用的实时挂载路径，因此每个结果都报告 `restartRequired: true`。

## 发现机制

满足任一规则即可被发现：名称以官方插件作用域 `@deepseek-ai/dsh-` 开头，或已发布的 `package.json` 带有真值的 `dsh` 字段。因此官方插件不需要额外元数据；第三方插件通过声明该字段变得可被发现，因为注册表索引没有其他可读的标记。本仓库现有的 Host 插件（工具、提供方、服务 Definition）都没有声明 `dsh`：作用域规则就是它们的兼容答案，而它自己那些包的发现仍然基于名称。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `registryUrl` | `https://registry.npmjs.org` | 注册表基础 URL；绝对 `http`／`https`，无凭据 |
| `profile` | `web` | 安装所针对的 profile 名称 |
| `dshHome` | `$DSH_HOME` | 存放 `profiles/` 的 harness home |
| `maxResults` | `10` | 单次搜索返回的条目数；绝不超过 `50` |
| `requestTimeoutMs` | `20000` | 单次注册表请求的截止时间 |
| `subprocessGraceMs` | `10000` | 包管理器终止宽限期 |
| `maxOutputBytes` | `64000` | 每个包管理器输出流保留的字节数 |
| `packageManager` | `pnpm` | 包管理器可执行文件 |

提供方用 seam 的 `MarketConfig` 字段名与 `DEFAULT_*` 值声明自己的 `Config` schema（`static Config`，schemastery），因此 Loader 校验的是本包内的声明。配置错误在加载时失败：`resolveMarketConfig()` 校验 URL、条目上限、毫秒与字节上限，以及 profile 名称（通过启动器自身的 `resolveProfileDir()`，因此安装绝不会写入 `dsh --profile` 会拒绝的目录）。

## 模型体验

间接地，经由 [`dsh-tool-market`](../tool-market/README.md)：其 `market_search` 与 `plugin_install` 工具调用本提供方，空白查询、无效的版本 pin、非 DSH 插件的包，以及失败的包管理器运行，都会作为该工具调用的错误文本到达模型。

#### KV Cache 影响

无；本包不注册提示词、工具或系统提示词段，因此从不改变模型请求的 token。

## 已知限制与暂缓事项

- **没有 `dsh` 元数据的第三方包不可见。** 名称规则只覆盖官方 `@deepseek-ai/dsh-` 作用域，因此该作用域之外且不声明 `dsh` 字段的包从不出现在搜索结果中；在其已发布 manifest 中声明该字段只能由它的作者完成。
- **安装需要已初始化的 profile 与可用的包管理器。** 提供方从不创建 profile；它会以启动器的指引作为失败信息。
- **安装会重写 profile 的 patch 层。** 记录经由 loader 的 YAML 方言添加，因此 `!!js` 表达式可以往返，但 `cordis.patch.yml` 中手写的注释行不会在重写后保留。
- **只检查顶层与 insert 记录是否已注册。** 已从 group 记录内部挂载过的包会被再次安装。
- **没有卸载、升级或版本列表。** 该 seam 只暴露搜索与安装。
- **搜索取消能到达注册表请求，但不能穿过 Remote**，其线协议方法不携带 signal。
