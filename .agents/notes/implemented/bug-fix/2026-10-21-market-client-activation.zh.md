# Agent Note: Market 客户端激活与连接测试

Status: implemented

[English](2026-10-21-market-client-activation.md) | 中文

## 问题

过期的 API Remotes 浏览器 bundle 不包含 `remote.market`，导致 Market UI 一直等待并阻塞首页。重新构建后还会出现另一处注册缺陷：`market/install` 端点与命名空间服务中使用字符串名称的私有 `install` 辅助方法冲突。可选的注册表功能还需要让用户先在设置中检查可用性，再获取并显示结果。

## 决策

Client Gateway 通过 Symbol 键辅助方法注册投影方法。名为 `install` 的业务方法可以挂载、与其他方法共存并撤回，而不会替换该辅助方法；现有字段和方法冲突检查继续生效。

Market UI 激活只要求 slots 与 locale。操作回调通过 `ctx.get()` 读取可选的 `remote.market` 服务，并在不可用时拒绝调用。打开标签页不发送请求。**测试连接**通过 Host 提供方执行普通浏览查询，成功后显示返回的清单并启用搜索。失败只在设置中显示，且可以重试。

此时机决策取代了 [Market 标签页记录](../feature/2026-10-22-plugin-market-web-tab.md)中的首次查询时机；原记录继续负责标签页组合与安装展示。生成的 Remote 选择会编译到 API Remotes 浏览器 bundle 中，因此修改源码后必须重新构建该包，再刷新应用。

## 考虑过的替代方案

**继续要求 UI 注入 `remote.market`。** 缺少可选的 Market API 时，整个应用都无法打开设置，用户也就无法在其中测试连接。

**重命名已发布的安装端点。** 冲突属于客户端注册机制。重命名业务 API 只会保留内部命名限制，无法解决根因。

**增加独立健康检查端点。** 浏览查询已经检查生成的方法、传输、Host 网关、提供方与注册表，并返回用户希望显示的值。

## 后果

Market 服务不可用时在用户发起操作时失败，而不是在 UI 激活时失败。连接测试执行真实的注册表搜索，不安装插件。Gateway 测试覆盖 `install` 挂载与撤回，Market 测试覆盖服务缺失、延迟提供及显式首次查询；运行中的 Web 组合验证首页可加载，成功测试后可显示清单条目。
