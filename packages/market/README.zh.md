# market/ — 插件市场能力族

[English](README.md) | 中文

在包注册表中发现 DSH 插件，并把其中一个安装进已配置的 `dsh --profile` profile。该 seam 按三个能力角色拆分：一个同时投影设置界面所拨号的 Host Remote 的 Service Definition、一个注册表 Service Provider，以及面向模型的 Consumer。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`market/`](market/README.md) | 定义搜索／安装能力、其配置与 `market` Remote 网关 | `ctx.market`（定义方） |
| [`market-npm/`](market-npm/README.md) | 针对 npm 注册表提供搜索与安装 | 注册 `ctx.market` |
| [`tool-market/`](tool-market/README.md) | 把搜索与安装暴露给模型 | 注册到 `ctx.tools` |

安装只写入已解析的 profile 内部：包管理器以 profile 目录作为工作目录运行，该 profile 自己的 `cordis.patch.yml` 增加一行 insert 记录。运行中的进程从不挂载新安装的插件，因此结果报告 `restartRequired`。

一个注册表包在其名称以 `@deepseek-ai/dsh-` 开头，或它已发布的 `package.json` 声明了真值的 `dsh` 字段时可被发现：官方插件按作用域即可找到，第三方插件用该字段选择加入（[细节](market-npm/README.md#discovery)）。

`ctx.market` 服务与 `market/search`／`market/install` Remote 方法由 `pnpm run gen-cordis-catalog` 映射进 [docs/subsystems/extensions.md](../../docs/subsystems/extensions.md)。
