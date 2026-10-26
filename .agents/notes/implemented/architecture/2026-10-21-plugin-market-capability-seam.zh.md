# Agent Note: 插件市场作为能力 seam

Status: implemented

[English](2026-10-21-plugin-market-capability-seam.md) | 中文

## 问题

仓库里没有任何东西能发现或安装 DSH 插件。想要插件的用户必须自己找到它的 npm 名称、编辑 profile 的 `package.json`，并手写一行 loader 记录 —— 三个步骤没有共享实现、没有面向模型的路径，也没有设置页可调用的东西。两个受众（经由工具的 agent、经由 Remote 的 Web GUI）同样没有共同的操作集，因此先做其中任何一个都会各自发明一套搜索与安装。

## 决定

插件市场是一个具备全部三个角色的能力 seam，放在新的 `packages/market/` 组里：

| 包 | 角色 | `ctx` 键 |
|---|---|---|
| `market` | Service Definition（`MarketService`，具名导出）、该 seam 的配置约定，以及 Remote 网关（默认导出） | `ctx.market` |
| `market-npm` | 针对 npm 注册表的 Service Provider | 注册 `ctx.market` |
| `tool-market` | Consumer：`market_search` 与 `plugin_install` | 注册到 `ctx.tools` |

`search(request, signal?)` 返回不超过配置的条目上限；`install(request, signal?)` 把一个包安装进一个已配置的 profile。两者都接受中止信号，工具从 `exec.signal` 转发它，而 Remote 方法省略它 —— 线协议不携带取消。

### 为什么 Remote 网关位于 Definition 包

`MarketGateway` 注册 Cordis 服务键 `marketGateway` 并绑定到线协议命名空间 `market`，因此发布出来的方法是 `market/search` 与 `market/install`，且不会与 `ctx.market` 服务键冲突。它没有状态也没有策略：每次调用都转发给已挂载的提供方，因此浏览器与工具共享同一实现，将来任何注册表提供方都能同时服务两者。把它放在 Definition 包里意味着线协议约定与 seam 类型是同一份产物，正如 `dsh-host-plugin-inventory` 把网关放在其投影旁边。

### 可发现性：官方作用域，或 `dsh` manifest 字段

当一个包的名称以 `@deepseek-ai/dsh-` 开头，或它已发布的 `package.json` 携带真值 `dsh` 字段时，它就是 DSH 插件；[作用域规则](../feature/2026-10-21-plugin-market-discovery-by-scope.md)记录了名称规则为何与字段并列。搜索向注册表索引请求候选，然后抓取每个候选的 manifest，因为索引描述的是包，只有 manifest 携带条目所报告的版本与描述。注册表在该版本不提供的候选，或不满足任一规则的候选会被静默丢弃 —— 那是过滤器，不是错误。传输与服务器失败仍会抛出。

`dsh` 字段在本仓库的实测范围：225 个包中有 45 个声明它，且全部是 bundle（`dsh.bundle`）或浏览器插件（`dsh.client`）。Host 插件包 —— 工具、提供方、服务 Definition —— 都不声明它，改为按作用域被发现，因此没有任何已发布 manifest 需要改动。安装使用同一套接受判定，因此市场永远不能被用来按名称安装任意包。

### 安装只写 profile，激活方式是重启

安装镜像启动器已经在做的事，没有并行机制：

1. `resolveMarketConfig()` 用启动器自身的 `resolveProfileDir(profile, home)` 解析目标目录，因此市场只能寻址 `dsh --profile` 会加载的目录，并从 `PROFILE_PATCH_FILENAME` 推导 patch 路径。
2. `packageManager` 经由 `ctx.subprocess` 运行 `add <name>@<exact-version>`，以 profile 目录为 `cwd`，把调用方的信号附加到进程树，把 store 固定到 `<dshHome>/profiles/.pnpm-store`，并限制收集的流 —— 不会有状态落在 profile 或 harness home 之外。
3. profile 自己的 `cordis.patch.yml` 增加一行 insert 记录（`id: market-<slug>`、`name: <package>`）。那是启动器最后应用的层，而一条裸 `name` 记录会通过 profile 的 `node_modules` 解析 —— 正是 `healProfilesModuleFallback` 与 profile 由 pnpm 管理的 `node_modules` 已经提供的解析路径。该记录经由 `entryListSchema` 写出，因此 `!!js` 表达式可以往返。

运行中的进程无法挂载结果：Loader 在启动时解析记录，而之后安装的 npm 包不存在可用的实时挂载路径（动态 Cordis runner 挂载的是模型写的 vm 代码，不是 profile 记录）。因此每个结果都报告 `restartRequired: true`。

对已由顶层记录或现有 insert 指名的包，安装是幂等的；对从 group 记录内部挂载的包则不是。

### 安装工具自己询问审批 seam

`tools/pre-execute` 可以让部署策略按工具作答，但没有任何已组合的策略知道 `plugin_install` 会运行用户的包管理器；漏掉它的策略会静默安装。因此 `plugin_install` 在安装前询问 `ctx.get('approval')` 并默认失败 —— 没有通道、没有 agent、拒绝、取消，或 `unavailable`，都会以不安装结束调用。授权是一次性的，且只覆盖请求中的那个包。这与沙箱化的 bash 与 fs 工具为升级所走的工具内路径相同。

### 为什么审批提问不能放在线协议边界

Web 设置标签页经由 `market/install` 到达同一个提供方，而那个调用不会询问任何人。审批 seam 无法回答它，原因三条同时成立：

1. `ApprovalService.request()` 需要一个 `Agent`，并且当该 agent 的会话没有开放轮次时，它在追加任何事件之前就拒绝 —— `approval/asked` + `approval/decided` 审计对必须被日志的提交／回放边界包住，因为轮次之间的裸事件与崩溃残留无法区分，重载时会被丢弃。
2. 一次 Remote 调用只携带它的 `args` 与中止信号；线协议请求不指名任何 agent 或会话，因此没有可以把提问附上去的东西。
3. Web 审批通道（`api-proxy`）回答 `approval/request` 的方式，是在 `req.agent.session` 中找到该请求尚未裁决的 `approval/asked` 事件，并为那个会话推送一个 `approval/requested` mux 帧。既没有 agent 也没有该事件时，它转交下游，而服务的默认把结果变成 `unavailable`。

因此没有发布一个必然失败的提示，网关也没有加入旁路：门禁存在于有轮次的地方，标签页的安装则被记录为未加门禁。给它加门禁需要一个不依赖轮次的审批通道 —— 一个不指名 agent、不隶属会话、答复仍可审计且仍受 `approval` 策略约束的提问。

### 配置所有权

`dsh-market` 拥有 `MarketConfig`、`DEFAULT_*` 默认值与 `resolveMarketConfig()`，因为解析出的值（注册表 URL、profile 名称与目录、条目上限、请求截止时间、子进程宽限期、输出上限、包管理器）是该 seam 的消费方所依赖的事实，而不是某个提供方的私有设置。schema 本身位于提供方，这也正是配置目录要求插件在自己的包里声明配置类型的地方：`market-npm` 用 seam 的字段名与默认值写出 `static Config: z<Config>`，因此配置错误在插件加载时失败 —— 非绝对或含凭据的注册表 URL、超出 `1..50` 的条目上限、非正的毫秒或字节上限，或启动器会拒绝的 profile 名称，都会在首次调用前抛出。

## 考虑过的替代方案

**注册表侧的插件 manifest，而不是 `dsh` 字段。** 一份专门文档（名称、描述、插件类型）也能描述 Host 插件。它并不存在，而发明第二套 manifest 约定会让 DSH 插件的可发现性取决于一份没人发布的文件。

**仅以名称前缀匹配（`@deepseek-ai/dsh-*`）作为插件信号。** 它只能找到本仓库的包，无法表达第三方插件，并且会把每个该形状的作用域包都标记为插件。作为唯一信号被拒绝；作用域现在与 `dsh` 字段并列接受官方插件，如[发现记录](../feature/2026-10-21-plugin-market-discovery-by-scope.md)所记。

**为 Remote 网关单独建包。** 第四个包可以让部署在不含 Definition 的情况下发布设置 API，但没有当前消费方想要它；网关是 seam 的传输投影，不是独立能力。

**在结果中返回记录，让调用方自己写。** 那样安装虽然成功，但在有人编辑 YAML 之前一直未挂载 —— 那正是此功能要消除的步骤。

**把安装写入 profile 的 `package.json` bundles 列表。** `dsh.profile.bundles` 接受的是 bundle，而 bundle 必须声明 `dsh.bundle`；普通插件不是 bundle。

**实时挂载已安装的包。** 这很诱人，因为 Loader 确实会动态挂载条目，但从刚安装的 npm 包到实时记录没有路径：模块位于启动图之外，其服务从未被组合，而半挂载的插件比诚实报告需要重启更糟。

**在网关里询问审批，或借用某个存活 agent 的轮次。** 网关可以取到 `ctx.agents`，代某个恰好存活的根 agent 发问，那会让同一个按钮在有轮次运行时弹出提示、在会话空闲时失败，并把审计对写进一个无关的模型步骤。经由 `userQuestions` seam 的浏览器确认既不需要 agent 也不需要轮次，但不携带审批策略也没有审计对，因此它看起来像门禁而不是门禁。两者都会让线协议路径的安全性取决于时机而非约定。

## 后果

市场能找到作用域之下的包，或声明了 `dsh` 的包：bundle 与浏览器插件使用该字段，Host 插件按作用域被发现，而作用域之外的第三方包需要该字段才可被发现。安装会通过 YAML dump 重写用户的 `cordis.patch.yml`：`!!js` 可以往返，但手写的注释行不会保留。审批门禁覆盖面向模型的工具，而不覆盖 Web 标签页的线协议调用，因此浏览器安装的安全叙事弱于工具。该 seam 没有卸载、升级或已安装版本列表，因此模型看不到已经存在的内容，重复安装会被报告为全新安装。搜索取消能到达注册表请求，但不能穿过 Remote，其线协议方法不携带 signal。

这买到了什么：搜索与安装的一份实现服务三个表面、一条下次启动真正会挂载的 loader 记录，以及一条不会静默写到已解析 profile 之外的安装路径。

## 测试

`packages/market/market-npm/tests/install.spec.ts` 覆盖过滤器（桩注册表的候选分别声明字段、发布在官方作用域下、两条规则都不满足，或 manifest 返回 404）、条目上限、作用域名称编码、精确版本与名称语法的拒绝、非插件的拒绝、包管理器 argv/cwd/store、注册的记录、幂等性、带 stderr 尾部的失败路径，以及缺失的 profile。Definition 测试套件钉住配置解析与生成的 Remote 命名空间，工具套件钉住注册、默认失败的审批路径与各 presenter。每个包都带有自己的 invariant 伴随测试套件。

## 暂缓

真正的组合式 Loader 启动测试（安装进临时 profile、通过启动器启动该 profile，并断言插件的工具出现）需要现有套件都没有的 profile fixture；安装流程目前只有单元覆盖。卸载、升级与已安装状态报告是尚不存在的 seam。
