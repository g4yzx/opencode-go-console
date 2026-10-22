# opencode GO 控制台

[![tests](https://github.com/g4yzx/opencode-go-console/actions/workflows/test.yml/badge.svg)](https://github.com/g4yzx/opencode-go-console/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**简体中文** · [English](README.en.md)

- GitHub：<https://github.com/g4yzx/opencode-go-console>（[Releases](https://github.com/g4yzx/opencode-go-console/releases)）
- Gitee：<https://gitee.com/g4yzx/opencode-go-console>（[发行版](https://gitee.com/g4yzx/opencode-go-console/releases)）
- 协议 MIT（[LICENSE](LICENSE)）· 安全审计 [AUDIT.md](AUDIT.md) · 版本 v1.0.3

## 软件功能

WorkBuddy 的自定义模型表单只认「标准 OpenAI 接口」，而 opencode Go 的网关有几道自己的规矩：要一个特殊请求头、不同模型走四种不同协议、部分模型还限制地区。这个项目在你自己电脑上（只监听 `127.0.0.1`）起一个中转站，把这些差异都挡在本地。

| 能力 | 说明 |
|---|---|
| 鉴权 | WorkBuddy 不会发的 `x-opencode-session` 头，桥接按需生成并带上 |
| 协议 | WorkBuddy 说 OpenAI 的话，桥接翻译成 Anthropic / Responses / Gemini 再发出去，回来再翻回来 |
| 账号 | 额度用完自动换下一个号，已经输出一半的回答不会被重新发送 |
| 代理 | 只让需要翻墙的模型走代理，其余照常直连 |
| 用量 | 官网账单口径 + 本机统计口径，同屏对比 |
| 装模型 | 目录里勾选，写进 WorkBuddy 的 `models.json`，写前自动备份 |

## 快速上手

### 打开方式

| 方式 | 怎么做 | 适合谁 |
|---|---|---|
| 单文件 exe（推荐） | 双击 `OpenCodeGoConsole.exe`：首次解包 5–10 秒 → 自动开浏览器 → 缩进通知栏 | 电脑上没装 Node |
| bat 脚本 | 双击 `start-panel.bat`；不想看黑窗口用 `start-panel-silent.vbs` | 已装 Node 20+ |
| 命令行 | `node ui.js` | 调试源码 |

### 第一次用，三步

1. **填密钥**：「账号与用量」→ 添加账号，粘贴 opencode 的 key（`oc_sk_...`）。可以加多个，列表顺序就是优先级。
2. **挑模型**：「模型目录」→「刷新目录」→ 勾想要的 → 「写入 WorkBuddy」。要全量就点表头全选。
3. **启动桥接**：最上面那个桥接框点「启动桥接」，框变绿就通了。

然后回 WorkBuddy → 设置 → 模型：能看到名字带 `(opencode Go)` 的条目，地址是 `http://127.0.0.1:8788/v1`，点「测试连接」应当显示成功。

### 每个模块是干什么的

**桥接进程**
真正干活的中转站。绿框 = 在跑，红框 = 没跑，点「启动桥接 / 停止」就行。这里还能改端口，改完 `models.json` 里本项目的模型地址会自动跟着改，不用手动修。桥接一停，WorkBuddy 里所有 opencode 模型立刻连不上，其它模型不受影响。

**代理**
给「必须翻墙才能用」的模型准备的。打开开关、填代理地址（比如 `http://127.0.0.1:7897`），再去模型表最右边勾上要翻墙的那几个；没勾的一律直连，不会偷偷绕路。这里的「测试连接」不只测端口通不通，还会透过代理问一句「你从哪个国家出去」——端口通不等于出口在美国，这一步能直接看出代理规则有没有把 `opencode.ai` 放走。

**账号与用量**
一排钥匙。每个号可以单独查额度，三个窗口：5 小时、本周、本月，显示百分比和重置时间。号与号能调顺序、设当前。额度耗尽或 key 失效时桥接自动换下一个——只在还没开始输出的时候换，已经吐了一半的回答不会重来，免得重复计费。

**用量看板**
两本账上下对照。上半是官网控制台的数据（官方账单口径，含你在 opencode CLI 里的用量）；下半只算经过这个桥接的请求（本地口径）。两边对不上很正常：差额就是「没走桥接的部分」加上「旧记录没带 token 的部分」。每笔都按 models.dev 的单价估算金额，缓存命中按缓存价算，仅供参考，不是账单。

**模型目录**
一份菜单。列出网关现在有哪些模型、什么协议、上下文多大、单价多少。可以改上下文和输出上限（有些模型官方标得偏保守），也可以手动加目录里没有的模型。勾完点「写入 WorkBuddy」就装好，写之前自动备份；已经装过的行标「已装」，参数和目录对不上标「旧」，重新勾选写入就会更新。

**顶栏小开关**
右上「自动刷新」每 10 秒刷一次状态和看板，不重载页面；旁边四个圆点换主题；每个区块右上角的箭头能折叠，收起状态会被记住。

### 常见毛病，对照着看

| 现象 | 多半是 |
|---|---|
| WorkBuddy 里「测试连接」失败 | 桥接没启动（框是红的），或者模型 id 写错 |
| 403 / `unsupported_country_region_territory` | 这个模型要美区出口，勾上代理再测一次 |
| 401 | key 无效或没权限，重新贴一次 |
| 429 | 这个号的额度用完了，加个号或等重置 |
| 面板能开、模型调不通 | 点模型行末尾的「测」：它走的是和 WorkBuddy 完全相同的路径，报什么错一眼就知道 |
| 托盘图标找不到 | 被收进 `^` 溢出区了，拖出来一次就好 |

## 专业说明

<details>
<summary><b>展开：架构、协议映射、接口清单、参数策略、打包链路、测试</b></summary>

### 架构与数据流

```
WorkBuddy ──POST /v1/chat/completions──▶ 桥接 127.0.0.1:8788
                                          │ 1. 读 models-catalog.json 判定协议
                                          │ 2. chat → 目标协议转换（含 SSE 增量）
                                          │ 3. 选账号（轮转 / 直连或走代理）
                                          ▼
                                   opencode 网关 /inference/go/*
                                          │
                                          ▼ 响应再转回 chat.completion(.chunk)
面板 127.0.0.1:8790 ── 只做管理与观测：账号、目录、用量、桥接启停、写 models.json
```

桥接本身无 UI、无数据库；状态全部落在几个 JSON / JSONL 文件里，进程重启即恢复。

只列需要读懂的文件，`start-*.bat` / `*.vbs` 这类启动脚本不列：

| 文件 | 干什么 |
|---|---|
| `ui.js` | 控制台后端：监听 8790，提供静态页与全部 `/api/*` |
| `ui/index.html` | 单页前端，无框架，样式与脚本内嵌 |
| `src/bridge.js` | 桥接主进程：监听 8788，协议路由、账号轮转、代理分流、用量落盘 |
| `src/protocol-converter.js` | chat ⇄ Anthropic Messages |
| `src/responses-converter.js` | chat ⇄ OpenAI Responses |
| `src/google-converter.js` | chat ⇄ Gemini generateContent |
| `src/usage.js` | 四种协议的 usage 归一化与 SSE 尾部解析 |
| `src/official-usage.js` | 官网控制台用量（`/console/api/usage/*`） |
| `src/file-util.js` | 原子写、日志轮转、只读文件尾部 |
| `accounts.js` | 账号池：候选密钥、轮转、结果标记 |
| `catalog.py` · `install-models.py` · `usage.py` | 命令行：拉目录 / 写 `models.json` / 查额度 |
| `pack/launcher.c` · `pack/build.py` | 托盘启动器与打包脚本 |
| `test/` | `node --test` 单测，44 项 |

### 协议映射

`provider.npm`（来自 models.dev）决定用哪个转换器：

| npm | 协议 | 上游路径 | 转换模块 |
|---|---|---|---|
| `@ai-sdk/openai-compatible` | `chat` | `/inference/go/openai/v1/chat/completions` | 直通（只补头） |
| `@ai-sdk/openai` | `responses` | `/inference/go/openai/v1/responses` | `src/responses-converter.js` |
| `@ai-sdk/anthropic` | `anthropic` | `/inference/go/anthropic/v1/messages` | `src/protocol-converter.js` |
| `@ai-sdk/google` | `google` | `/inference/go/google/v1beta/models/{id}:generateContent` | `src/google-converter.js` |

请求侧把 `messages` 拆成各家结构（Responses 的 `instructions` + `input`、Anthropic 的 `system` + `messages`、Google 的 `contents` + `parts`），响应侧把上游事件合回 `chat.completion.chunk`，含 tool call 增量与 `thinking → reasoning_content`。未知模型返回 `protocol_not_bridgeable`，不会硬猜。

### 接口清单（2026-10-21 实测）

| 用途 | 端点 | 鉴权 | 需要 session 头 |
|---|---|---|---|
| 模型目录 | `GET https://opencode.ai/inference/go/v1/models` | 无 | ❌ |
| OpenAI chat 推理 | `POST .../inference/go/openai/v1/chat/completions` | Bearer | ✅ |
| OpenAI responses 推理 | `POST .../inference/go/openai/v1/responses` | Bearer | ✅ |
| Anthropic Messages | `POST .../inference/go/anthropic/v1/messages` | x-api-key | ✅ |
| Google generateContent | `POST .../inference/go/google/v1beta/models/{id}:generateContent` | Bearer | ✅ |
| 订阅额度 | `GET .../inference/go/v1/usage` | Bearer | ❌ |
| 官网用量 | `GET https://opencode.ai/console/api/usage/{summary,models,cost-by-day}?since=…` | Bearer | ❌ |
| 模型元数据 | `GET https://models.dev/api.json` → `["opencode-go"]` | 无 | ❌ |

- 旧的 `/zen/go/v1/*` 仍可用（兼容保留），新代码一律走 `/inference/go/*`
- 额度响应：`{usage:{rolling,weekly,monthly}}`，每项 `{status,percent,resetsAt}`
- 控制台金额单位是 `totalCostMicroCents`，除以 `1e8` 得美元；`range=24h` 只到 UTC 零点，所以请求里一律带显式 `since`

### 账号轮转语义

- 池子上限 20，明文存 `accounts.json`（0600，仅当前用户可读）；WorkBuddy 侧随便填个占位 key
- 触发切换：`401/403`（凭据失效）、`402/429`（额度耗尽）
- **只在尚未向客户端输出任何字节时切换**；已开始流式响应则原样透传，避免重复计费与半截回答
- `400/404` 等参数错误不切号，直接透传上游原文，避免掩盖真实问题
- 面板的「添加账号」与「查额度」是两条独立链路：查额度失败只记日志与 `lastError`，不回滚账号

### usage 归一化与计费

每条请求往 `usage-history.jsonl` 追加一行 `{at, model, protocol, account, switched, stream, usage}`，`usage` 统一为 `{prompt, completion, cached, cacheWrite}`：

| 协议 | 原始字段 | 处理 |
|---|---|---|
| chat | `prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens` | 流式注入 `stream_options.include_usage=true`，从尾部 usage 块取 |
| responses | `input_tokens` / `output_tokens` / `input_tokens_details.cached_tokens` | 从 `response.completed` 事件取 |
| anthropic | `input_tokens`（不含缓存）+ `cache_read_input_tokens` + `cache_creation_input_tokens` | 合计为总输入；流式合并 `message_start` 与 `message_delta` |
| google | `promptTokenCount` / `candidatesTokenCount` + `thoughtsTokenCount` / `cachedContentTokenCount` | 思考 token 计入输出 |

计费按 models.dev 的 `cost.input/output/cache_read/cache_write`，未命中的 token 按输入价、命中按缓存价、写入按写入价。日志 8 MB 轮转，诊断日志 1 MB 轮转，看板只读尾部 16 MB。

### 参数降级与两个硬门槛

- 上游报 `Unsupported parameter: 'xxx'` → 剥掉该字段重试一次，并按模型记住，后续不再携带（`top_p` 在 Google 协议里同时匹配 `topP`）
- 直连报 `unsupported_country_region_territory` → 该模型自动改走代理并记忆，**不读宿主 `HTTPS_PROXY`**（避免静默继承环境代理）
- Responses 协议的 `max_output_tokens` 下限是 16：WorkBuddy 的「测试连接」只申请 1 token，转换时统一抬到 16
- `reasoning_effort: minimal` 在 Responses 不合法，折成 `low`

思考等级按 models.dev 的 `reasoning_options` 解析成 `supportedEfforts` / `canDisableThinking`，请求侧再按协议落位：`chat` 原样透传、`responses` → `reasoning.effort`、`anthropic` → `thinking.budget_tokens`（2048/4096/8192/12288/15360）、`google` → `thinkingConfig.thinkingLevel`。

### 目录与 models.json

`models-catalog.json`（缓存 6 小时）由网关注目录与 models.dev 元数据合并而来，字段含 `protocol/context/output/images/costIn/costOut/reasoningEfforts`。写入 `~/.workbuddy/models.json` 的条目形如：

```json
{
  "id": "gpt-6-luna",
  "name": "GPT-6 Luna (opencode Go)",
  "url": "http://127.0.0.1:8788/v1",
  "supportsToolCall": true,
  "supportsImages": false,
  "supportsReasoning": true,
  "maxInputTokens": 1050000,
  "maxOutputTokens": 32768,
  "reasoning": { "defaultEffort": "medium", "supportedEfforts": ["low","medium","high"], "canDisableThinking": true }
}
```

手动覆盖与自建模型存 `custom-models.json`（`overrides` / `custom`），面板与 CLI 共用；目录自动值的输出上限按 65,536 截断，手工行放宽到 1,000,000。

### 面板 API

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/status` | 桥接、密钥、目录、代理、账号摘要 |
| GET | `/api/catalog` | 模型目录（`?refresh=1` 强刷） |
| GET | `/api/usage` | 订阅额度（可选 `?ref=` 指定账号） |
| GET | `/api/official/usage` | 官网用量（`?days=1\|7\|30\|90`） |
| POST | `/api/test-model` | 单模型探针，走与 WorkBuddy 相同路径 |
| POST | `/api/install` | 写入 WorkBuddy `models.json`（自动备份） |
| POST | `/api/models` | 改/增/删模型覆盖 |
| POST | `/api/accounts` | 账号增删改、排序、切当前 |
| POST | `/api/proxy` | 代理读写与出口探测 |
| POST | `/api/config` | 改桥接端口（联动改 `models.json`） |
| POST | `/api/bridge` | 启动 / 停止桥接 |
| POST | `/api/shutdown` | 停桥接并退出控制台（托盘用） |

非 GET 请求强制 `application/json` 且校验 `Origin`，跨站页面无法改代理或停服务。

### 打包与进程生命周期

`pack/launcher.c`（Win32，MinGW 编译）+ `pack/build.py`：应用代码与 `node.exe` 打成 OCA1 归档、zlib 压缩，作为 RCDATA 贴在 exe 里。

- 首次运行解到 `%LOCALAPPDATA%\OpenCodeGo`，版本号写 `app\.version`；版本没变就不再重解，数据文件不在 payload 里所以原地保留
- 读到 `portable.txt` 则改用 exe 同目录（绿色模式）
- 子进程入 Job 对象（`KILL_ON_JOB_CLOSE`）：启动器无论如何退出，node 与桥接都被清理
- 托盘「退出」先调 `/api/shutdown` 让桥接优雅停止，6 秒不退才 `TerminateProcess`
- 重复双击不会开第二个托盘，只把现有页面调出来

### 测试与审计

```bash
npm test                                   # 44 项，node --test，零依赖
node --check ui.js && node --check src/bridge.js
python pack\build.py --version x.y.z       # 出包，产物 dist\OpenCodeGoConsole.exe
```

CI 在 GitHub Actions 上跑 Node 20 / 22 双矩阵。安全审计（CSRF、孤儿进程、端口占用、原子写、日志轮转）见 [AUDIT.md](AUDIT.md)，含每条结论的验证命令。

</details>

## 参考的项目

| 项目 | 参考了什么 |
|---|---|
| [wuwu0605/workbuddy-opencode-go-bridge](https://github.com/wuwu0605/workbuddy-opencode-go-bridge)（MIT） | 桥接的起点：请求转发与协议路由的组织方式、账号池、流式转发的收尾处理 |
| [Duskriver/dsh-opencode-go](https://github.com/Duskriver/dsh-opencode-go)（MIT） | 网关迁移后的接口约定：以 models.dev 作模型元数据源、`/v1/usage` 查额度、控制台用量的统计口径 |
| [models.dev](https://models.dev/api.json) | 模型元数据：上下文与输出上限、单价、思考档位、`provider.npm` 与协议的对应关系 |

上游的 MIT 版权声明保留在 [LICENSE](LICENSE)。

## 许可证

[MIT](LICENSE) · 只在本机运行，不收集、不上传任何数据。
