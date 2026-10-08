# dsh-context-compressor

**简体中文** · [English](README.en.md)

一款 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 外置插件，为会话加上**可配置的上下文触发条件**：你可以二选一——设一个**绝对 token 上限**，或者设一个**占模型上下文窗口的比例**；一旦会话达到该条件，Harness 就会自动压缩对话。

插件自带一个独立的设置页，因此触发条件是用户在界面上设置的偏好，而不需要去改配置文件。

---

## 为什么需要它

DeepSeek Harness 本身就会压缩上下文，但它的策略是**写死的相对值**：`@deepseek-ai/dsh-compaction-basic` 在「当前路由模型所声明上下文窗口」的 80% 处触发，并保留 16% 的原文尾部。这是合理的默认值，也是大多数会话需要的。

它缺的是**让你决定那条线画在哪里**。本插件提供两种画法，二选一：

- **绝对上限（absolute）。** 「一个会话绝不越过 N 个 token」。适用于：
  - **成本与延迟上限。** 1M 的窗口不等于 1M 的预算。
  - **混合路由。** 同一个会话可能被路由到窗口差异巨大的模型上；绝对上限不会随路由移动那条线。
  - **第三方与自建端点。** 它们声明的 `contextWindow` 常常只是估计值，真实上限更低。
- **窗口比例（ratio）。** 「到窗口的 X% 就压缩」。这正是内置策略在做的事，只是把那个写死的 80% 变成你可以改的数字——想更早压缩（省成本）或更晚压缩（少损失上下文）都行。

两种模式**互斥**：只有选中的那个会被计算，设置页也只显示属于它的那个字段。另一个的值会保留在配置里，切回去即恢复。

把总开关关掉，DSH 的行为与安装前完全一致。

---

## 安装

本插件以普通的外置 profile 插件方式安装——不需要向应用程序里打任何补丁。

```sh
# 从本地目录安装：先装本包自己的依赖。因为 link: 是软链接，
# pnpm 不会往链接目标里安装依赖
pnpm install
dsh plugin --profile desktop add link:/绝对路径/dsh-context-compressor

# 从 GitHub Release 安装：releases/latest 始终指向最新版
dsh plugin --profile desktop add https://github.com/AllShadowAnan/dsh-context-compressor/releases/latest/download/dsh-context-compressor.tgz

# 钉住某个版本（示例）
dsh plugin --profile desktop add https://github.com/AllShadowAnan/dsh-context-compressor/releases/download/v1.0.1/dsh-context-compressor-1.0.1.tgz
```

`dsh plugin` 会把参数原样转发给 `pnpm`，工作目录就是 profile 目录。由于本包同时声明了 `dsh.bundle.patch` 与 `dsh.client.platform: "web"`，同一条命令还会把 `dsh-context-compressor` 追加进 `dsh.profile.bundles`——这正是让该包成为一个 profile 组合层的关键。

本插件唯一的运行时依赖是 `@deepseek-ai/schemastery`——它提供设置页所要投影的 `Config` schema。从 Release 的 tarball 安装会自动装上；用 `link:` 安装则需要先执行上面的 `pnpm install`。

安装后：

- **活动 profile（桌面应用）** 会在 profile 清单变化时自行重新组合——宿主端立刻生效。请**刷新浏览器页面**，让新的浏览器端 bundle 被注入文档；这一半无法热应用。
- **启动型 profile** 需要重启。
- **修改插件自身的源码之后，必须重启应用。** 宿主端是启动时加载的 Node 模块，浏览器端 bundle 的字节同样在启动时读取并缓存；重装或改动 profile 清单都不会让一个已加载的模块重新求值。只刷新页面是不够的。

确认宿主端已加载：

```sh
curl http://127.0.0.1:19387/dsh-context-compressor/status
# {"ok":true,"data":{"enabled":true,"mode":"absolute","contextLimit":0,"contextRatioPercent":80,"retainTokens":16000,"maxRounds":3,...}}
```

### 安装排错

**从 Release URL 安装时 `pnpm` 报 `fetch failed`。** 部分 Windows 环境下 Node 自带的 CA 列表验证不了 GitHub 的证书链——可能是 TLS 拦截，或某个根证书只装在 Windows 信任库里、没进 Node 的列表。此时浏览器和 `Invoke-WebRequest` 都正常，所以看起来像网络问题，其实是信任问题。让那一条命令改用系统信任库即可：

```sh
NODE_OPTIONS=--use-system-ca dsh plugin --profile desktop add <tarball-url>
```

```powershell
$env:NODE_OPTIONS = "--use-system-ca"; dsh plugin --profile desktop add <tarball-url>
```

任何 `github.com` 的 `pnpm add` 都同理，不是本插件特有的问题。

### 卸载

```sh
dsh plugin --profile desktop remove dsh-context-compressor
```

如果 `$DSH_HOME/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 里仍残留该名字，一并删掉。

---

## 设置页

**设置 → 上下文压缩**

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| **启用触发条件** | 开 | 总开关。关闭后仅由 DSH 内置的相对阈值策略触发压缩。 |
| **触发方式** | 绝对上限 | 二选一：`绝对上限` 或 `按窗口比例`。只有选中的那个会生效，下方只显示属于它的字段。 |
| **上下文上限（token）** | `0` | 选「绝对上限」时生效。单个会话估算上下文 token 的上限；`0` 表示不设上限。 |
| **触发比例（占窗口 %）** | `80` | 选「按窗口比例」时生效。取值 5–95。80 即内置策略的默认值。 |
| **保留最近（token）** | `16000` | 保持原文的尾部长度。比它更早的历史可能被压缩为一条摘要。 |
| **单步最多压缩次数** | `3` | 同一步内最多压缩多少次，超过则本步放弃。 |

每个字段都可以「恢复默认」，被覆盖的字段会带角标。保存是暂存式的：只有点 **保存** 才会写入，离开页面会丢弃未提交的修改——与所有官方设置页遵循同一套契约。

表单下方是宿主端提供的**实时读数**：当前触发方式、生效的上限（比例模式下会显示它换算成的实际 token 数，窗口未知时显示 `—`）、最近测量的会话（估算 token、该模型的窗口、该会话的触发阈值、已压缩次数）、最近一次压缩的压缩前/后 token 数，以及最近的问题。若「保留尾部」不小于生效上限，读数会直接给出提示——那种配置下压缩已经没有可摘要的空间了。

---

## 达到触发条件时会发生什么

在每一个步边界（`agent/pre-step`），针对即将迈出这一步的 agent：

1. **先解出阈值。** 绝对模式下就是配置的 token 数；比例模式下是「当前路由模型所声明的窗口 × 比例」，向下取整。比例模式在会话尚未记录 `request/context`（窗口未知）时**什么都不做**——那时也没有值得压缩的内容。总开关关闭、或绝对上限为 `0` 时同样直接返回。
2. **测量。** `ctx.tokenMeter.measure(session)` 对当前 surface 计价——算的是「请求镜像」，不是原始流水账。
3. **未达阈值？** 什么都不做。这是最常见的情况。
4. **先剪枝。** 超预算的工具结果会被截短（`toolResultPruner`）——这是内置引擎也会优先尝试的、确定性的廉价手段。如果仅此就降到阈值以下，**不会写入任何摘要**。
5. **再摘要。** 比 `retainTokens` 尾部更早的全部历史，通过公开的 `compaction.compactRegion(start, end, agent)` 替换为一条摘要。切点会一直向前回退，直到没有任何 assistant 工具调用失去配对结果，因此绝不会切断「工具调用/工具结果」对。
6. **重复**，最多 `maxRounds` 次；一旦降到阈值以下，或某一轮没有取得进展，就停止。

所有失败都被就地兜住。无法执行的压缩——引擎的持久锁被占用、没有安全的切点、摘要器报错——会被记录、显示在读数里，然后本步继续。触发条件是**一种优化，永远不是让某一步失败的理由**。

### 它是怎么拿到压缩引擎的

如果你要写类似的插件，这一段值得一读，因为最直觉的做法并不成立。

压缩栈被挂载在**每个 agent preset 的隔离 cordis 组**里，而 web bundle 会把同名的 profile 根层行**禁用**掉（`@deepseek-ai/dsh-web-app` 的 `cordis.patch.yml` 关闭了 `compaction-basic`、`command-compact`、`tool-result-pruner`）。因此：

- profile 根层插件**无法** `inject: ['compaction']`——宿主平面上根本没有这个服务。
- `agent.ctx.get('compaction')` **同样不行**。`agent.ctx` 是*根层* `agent-loop` 行的作用域，它的 isolate key 是根符号，而被禁用的那一行并没有往那里发布任何东西。
- `agent.ctx.compaction`（属性访问）会抛 `cannot get property "compaction" without inject`。

挂载各 preset 的注册表是唯一能看进自己隔离域的句柄，它为此专门发布了 `serviceFor(agent, name)`——`@deepseek-ai/dsh-api-session-controller` 就是以同样方式解析 `skills` 的。本插件按 agent、按调用逐次解析：

```js
ctx.get('agentPresets')?.serviceFor(agent, 'compaction')   // preset 隔离域
  ?? ctx.get('compaction') ?? agent.ctx.get('compaction')  // 宿主平面（headless 等）
```

token meter 是印证这条规则的那个例外：它有意**留在**宿主平面上（它的投影表是进程级的），所以从插件自身的 context 就能解析到。

本插件还依赖另外两条契约：

- **`agent/pre-step` 是带作用域过滤的 waterfall**，注册在任意 context 上的「未打标签」监听器会对每个 agent 放行。这正是根层插件想要的缝，同时也是唯一安全的时机——引擎的区域压缩要求**存在打开的 turn**，而 `agent/pre-step` 正运行在 turn 之内。
- **volatile 配置才是设置页能实时生效的原因。** 每个字段都声明为 `.volatile()`，因此设置写入会就地提交到运行中的引用上（`cordis-plugin-loader` 的 `_commitVolatile`），而不是重新挂载插件。所以插件在每个决策点读取 `config.contextLimit.get()`，从不缓存取值。

---

## 配置

这六个字段也可以从组合层预置——插件的 `cordis.patch.yml`，或 profile 的补丁：

```yaml
- insert:
    - id: context-compressor
      name: dsh-context-compressor
      config:
        enabled: true
        mode: absolute        # 或 ratio
        contextLimit: 120000  # mode=absolute 时生效
        contextRatioPercent: 80  # mode=ratio 时生效
        retainTokens: 20000
        maxRounds: 3
```

`mode` 在 schema 里是 `union([const('absolute'), const('ratio')])`，而不是裸字符串——写错的值会在加载时被拒绝，而不是悄悄把插件变成空操作。`contextRatioPercent` 被限制在 5–95。

`id` 是设置页所编辑的**设置命名空间**，不是包名。如果你要改名，请保持三处一致（`lib/index.js` 的 `SETTINGS_NS`、`lib/client.js` 的 `SETTINGS_NS`、以及补丁行的 `id`）。

---

## 包结构

```
package.json          name / exports["./client"] / dsh.bundle.patch / dsh.client.platform
cordis.patch.yml      profile 组合层：挂载宿主行并预置默认值
lib/index.js          宿主端：上限策略、pre-step 钩子、状态路由
lib/client.js         浏览器端：设置页（手写 bundle，无需构建）
locale/{en,zh}.json   插件清单里的标题与描述
icon.svg              插件图标
test/                 47 个测试：策略、harness 设置一致性、浏览器 bundle
```

**没有构建步骤。** 宿主端是普通 ESM。浏览器端直接按 DSH 客户端模块加载器期望的形态书写——`window.__ModuleLoader__.load({ id, factory })`——并且只 `require` 平台种子模块（`react`、`@deepseek-ai/dsh-client-ui-primitives`），因此无需打包。

---

## 测试

```sh
node --test test/host.test.mjs test/settings-projection.test.mjs test/client.test.mjs
```

三个测试文件，共 47 个测试：

- **`host.test.mjs`** —— 用替身验证策略：schema 契约、平衡切点选择、保留尾部、system 头部、先剪枝路径、preset 隔离域解析、失败兜底、状态路由。
- **`settings-projection.test.mjs`** —— 把**harness 自己的** `volatileForm` / `projectForm` / `isVolatilePath`（从已安装的应用中导入）跑在本插件的 `Config` 上；schema 写错会在这里失败，而不是变成一个没有任何控件的设置页。把 `DSH_REFERENCE_ASAR` 指向解包出来的应用即可运行，否则该套件自动跳过。
- **`client.test.mjs`** —— 用真实的模块加载器环境执行真实的浏览器 bundle，再用**真实 React** 渲染页面，并断言每个 `t()` 键在中英两份字典里都能解析。

---

## 已知限制

- **token 数是估算值。** 在拿到提供方用量之前，计量器用固定密度启发式对请求镜像计价；请把触发阈值当作预算线，而不是精确的分词计数。
- **单个超大单元无法被修复。** 如果某一条保留消息或某个请求信封本身就超过阈值，surface 压缩没有安全的切点可用，会话会停在阈值之上。读数会显示这种情况。
- **阈值在步边界处执行**，因此某一步可能在下次测量落地前先越线。
- **比例模式依赖模型声明自己的窗口。** 会话还没有记录 `request/context` 时窗口未知，此时插件保持惰性；声明值不准的端点会得到一个不准的阈值——这也正是「绝对上限」模式存在的理由。
- **它需要一个挂载了压缩栈的组合。** 桌面端与 web 端都满足；一个从不挂载压缩栈的最小 profile 没有东西可供本插件驱动，此时它会保持惰性而不是报错。
- **浏览器端在安装后需要刷新页面。** 只有宿主端能热应用；而修改插件源码后两者都需要重启应用。

## 许可证

MIT。
