# @deepseek-ai/dsh-market

[English](README.md) | 中文

插件市场的能力 seam。`MarketService`（具名导出，`ctx.market`）声明搜索与安装；`MarketGateway`（默认导出）注册仅限 Remote 的 `marketGateway` 服务，绑定 `market` 线协议命名空间，为 Web GUI 设置页发布 `market/search` 与 `market/install`。每次调用都转发给已挂载的提供方，因此浏览器与面向模型的工具到达同一实现。

```ts
search(request: MarketSearchRequest, signal?: AbortSignal): Promise<MarketSearchResult>
install(request: MarketInstallRequest, signal?: AbortSignal): Promise<MarketInstallResult>
```

`MarketSearchRequest` 为 `{ query, limit? }`；`MarketSearchResult` 为 `{ entries }`，每个条目携带已发布的 `name`、`version`、`description` 与 `updatedAt`。`MarketInstallRequest` 为 `{ package, version? }`；`MarketInstallResult` 报告已安装的 `package` 与 `version`、它落地的绝对 `profileDir`，以及 `restartRequired`。payload 类型位于 `./types`，Typert 生成由 `./typert` 与 `./remote` 导出的 Host 与 Client Remote 产物。

本包同时拥有该 seam 的配置约定：`MarketConfig` 输入类型、`DEFAULT_*` 默认值、`ResolvedMarketConfig` 与 `resolveMarketConfig()`。每个提供方在自己的包里声明它被校验时使用的 Loader schema（配置目录要求如此），并用这些默认值与字段名构建它。`registryUrl`、`profile`、`dshHome`、`maxResults`、`requestTimeoutMs`、`subprocessGraceMs`、`maxOutputBytes` 与 `packageManager` 是随部署变化的字段；解析步骤校验注册表 URL（绝对、`http`／`https`、无凭据）、条目上限（`1`–`50`）、每个正的毫秒与字节上限，以及 profile 名称，然后解析绝对 `profileDir` 与 `patchPath`。profile 名称与目录来自启动器自身的 `resolveProfileDir()`，因此安装总是写入 `dsh --profile` 会加载的目录。任何违规都在插件加载时抛出。

## 模型体验

无，因为本包不注册提示词、工具、消息或提供方请求；面向模型的表面是 [`dsh-tool-market`](../tool-market/README.md)。

#### KV Cache 影响

无；本包从不组装模型输入。

## 已知限制与暂缓事项

- **安装只针对一个已配置的 profile** —— 运行时中不存在「当前 profile」这一事实，因此运行多个 profile 的部署必须配置市场所管理的那个。
- **Remote 由 Web 客户端组合挂载** —— 本包只发布线协议命名空间；为浏览器选择它属于客户端组合的决定。
- **由线协议发起的安装不会询问任何人** —— 网关把 `market/install` 直接转发给提供方，不发出审批请求，因为审批 seam 无法回答它：`ctx.approval.request()` 需要一个会话处于开放轮次中的 `Agent`（否则抛出 `outside an open turn`，因为 `approval/asked`／`approval/decided` 审计对必须被轮次包住），线协议请求两者都不携带，而 Web 审批通道靠把该提问与那个会话日志里的 `approval/asked` 事件配对来作答 —— 没有该事件时它以 `unavailable` 默认失败。只有 `plugin_install` 会询问，且是在 agent 轮次内部。设置标签页自行渲染的确认属于展示，不是这道门禁：直接的线协议调用会跳过它。给线协议调用加门禁需要一个不依赖轮次的审批通道，而它目前不存在；刻意没有发布一个必然失败的提示。
- **`restartRequired` 对已发布的提供方恒为 true** —— Loader 可以挂载它已经导入的模块，但启动后安装的 npm 包不存在可用的实时挂载路径。
