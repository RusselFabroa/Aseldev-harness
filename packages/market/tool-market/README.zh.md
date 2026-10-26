# @deepseek-ai/dsh-tool-market

[English](README.md) | 中文

基于 `ctx.market` 的面向模型插件市场工具：`market_search` 查找可安装的 DSH 插件，`plugin_install` 把其中一个安装进已配置的 profile。本包拥有 schema、DSL 无法表达的参数检查、结果格式化与渲染意图；注册表访问与包管理仍留在提供方。

`plugin_install` 是安全敏感操作 —— 它运行机器用户的包管理器，并改变下次启动挂载的内容 —— 因此它在安装前询问审批 seam（`ctx.get('approval')`）并默认失败：没有审批通道、没有可路由该问题的 agent、拒绝、取消，或 `unavailable` 答复，都会以说明性错误结束调用且不安装。授权是一次性的，且只覆盖请求中指名的那一个包。

| 工具 | 渲染意图 | 说明 |
|---|---|---|
| `market_search` | generic，`kind: 'read'` | 可并发的注册表读取；提供方的条目上限约束结果 |
| `plugin_install` | generic，`kind: 'execute'` | 由注册表的默认非安全分类串行化；先请求审批 |

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `searchTimeoutMs` | `30000` | 单次 `market_search` 调用的协作式预算 |
| `installTimeoutMs` | `300000` | 单次 `plugin_install` 调用的协作式预算 |

两者都挂载为 `ToolDefinition.timeoutMs`，由 [`dsh-tool-call-timeout-policy`](../../guard/timeout-policy/README.md) 强制执行。

## 模型体验

### `market_search`

#### 模型看到的内容

schema 编目于 [`market_search`](../../../docs/tool-catalog.md#market_search)。工具描述说明它在插件注册表中搜索可安装的 DSH 插件，并返回每个插件的名称、版本与描述；`query` 参数要求用描述插件用途的词，`limit` 说明部署会限制数量。结果文本为每个插件列出一行 `- name@version — description`，随后指示用 `plugin_install` 安装其中一个；空结果会说明没有匹配的可安装插件，并指明两条发现规则 —— `@deepseek-ai/dsh-` 作用域与 `dsh` manifest 字段。

#### Token 影响

可变：每个返回条目一行，受部署的 `maxResults`（默认 10）加上两句固定句子限制。

#### KV Cache 影响

仅追加；调用的结果跟在可复用的请求前缀之后。无条件的工具 schema 在调用之间保持稳定，因此注册本包不会在首次携带它的请求之后使可复用前缀失效。

### `plugin_install`

#### 模型看到的内容

schema 编目于 [`plugin_install`](../../../docs/tool-catalog.md#plugin_install)。工具描述说明安装会运行机器用户的包管理器、改变下次启动挂载的内容，并且需要用户批准。`package` 必须是 `market_search` 返回的确切名称；`version` 固定一个已发布的精确版本。结果文本给出已安装的包与版本、profile 目录，并且 —— 因为运行中的进程从不挂载新插件 —— 说明需要重启。被拒绝的调用会抛出原因：用户拒绝、审批被取消、不存在审批通道、该包不是已发布的 DSH 插件，或包管理器失败并附带其自身的 stderr 尾部。

#### Token 影响

固定：每次调用一句短句，安装失败时外加包管理器的 stderr 尾部（受提供方 `maxOutputBytes` 上限约束）。

#### KV Cache 影响

仅追加；调用的结果跟在可复用的请求前缀之后，且从不重写更早的消息。

## 已知限制与暂缓事项

- **没有卸载或升级工具。** 该 seam 只暴露搜索与安装。
- **模型看不到当前已安装的内容。** 搜索报告的是注册表而非 profile，因此对同一个包再次执行 `plugin_install` 会被报告为一次全新的安装。
- **授权按调用计。** 审批 seam 只提供 `allowed-once`，因此重复安装会反复询问。
- **审批门禁只覆盖本工具，不覆盖线协议。** 由 Web 设置标签页经 `market/install` 发起的安装不会询问任何人；该限制及其成因（seam 无法回答线协议发起的提问）由 [`dsh-market`](../market/README.md) 拥有。
- **`market_search` 没有结果视图。** 其完成卡片保留待处理的 generic 标题与原始结果内容，因为条目列表本身已是 UI 可原样呈现的纯文本。
