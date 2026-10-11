# SignalCourt

[English](README.md) | [中文](README.zh-CN.md)

**面向加密市场新闻的证据优先审查工具。** SignalCourt 把一篇公开文章转化为声明账本，结合独立新闻与只读的 RYO 市场研究，让看多和看空 Agent 只能引用同一份已保存证据，再由确定性规则执行安全门槛，并把结果保存为可复盘凭证。

> 仅用于模拟练习。SignalCourt 不是投资建议，不连接钱包，也不能执行交易。

![SignalCourt 证据工作台](tests/e2e/analysis.spec.ts-snapshots/supported-workspace-desktop-darwin.png)

## 30 秒理解产品价值

一条新闻可能是真的，但仍然可能信息不完整、已经被市场消化，或者缺少当前市场条件的支持。很多 Agent 演示会用一段自信的文字掩盖这种不确定性。SignalCourt 把不确定性变成可检查的记录：

1. 从文章中提取最多三条核心声明。
2. 搜索独立报道，把每条声明标记为已验证、有争议或缺乏支持。
3. 收集带时间、可用性、警告和数据模式的 RYO 市场证据。
4. 要求 Bull 和 Bear Agent 只根据同一份不可修改证据包进行辩论。
5. 用确定性代码检查引用、数据新鲜度、风险输入和决策门槛。
6. 返回模拟 `LONG`、`SHORT` 或 `NO_TRADE`，然后在不联网的情况下复盘已保存凭证。

评委首先看到的是结论、失败门槛和来源，而不是一大段原始数据；完整产品逻辑可以在五分钟内理解。

## 当前状态

| 模块 | 状态 | 准确含义 |
| --- | --- | --- |
| Demo 完整流程 | 已在本地验证 | 确定性模拟 fixtures 无需 API key；单元、集成和 Playwright 测试覆盖完整流程。 |
| 证据充分与证据不足路径 | 已在本地验证 | 两条路径都通过浏览器、Fastify API、SQLite 持久化和 replay 接口进行全栈测试。 |
| 凭证复盘与完整性 | 已在本地验证 | `1.1` 版凭证会重新计算证据哈希和完整凭证哈希，再判断复盘是否一致。 |
| Live mode 接线 | 已准备 | 服务端适配器和失败关闭门槛已经实现，但实时运行需要全部凭证和经过审核的发布者注册表。 |
| RYO 已认证实时调用 | 本工作区尚未验证 | 已提供可选 smoke test；没有用户提供的凭证时不会运行，也不会声称已经验证。 |

Demo fixture 始终明确标记为 `simulated`。适配器已经写好、fixture 测试通过，不等于外部实时服务已经验证。

## 证据流与架构

```text
公开文章
   |
   +--> 声明提取 --> 独立新闻核验
   |
   +--> RYO 研究协调器 --> 四个只读市场工具
                              |
                              v
                       不可修改证据包
                         /          \
                     看多论点      看空论点
                         \          /
                        确定性 Judge
                              |
                   LONG / SHORT / NO_TRADE
                              |
                    SQLite 凭证 + 离线复盘
```

React/Vite 客户端负责证据工作台。Fastify 服务端负责输入验证、外部适配器、Agent 编排、决策门槛和凭证 API。SQLite 为本地项目保存只追加、不原地修改的凭证。所有外部服务凭证都只留在服务器端。

## 四个 RYO 工具为什么重要

| 工具 | 在决策中的作用 | 实时证据要求 |
| --- | --- | --- |
| `market_overview` | 提供整体市场状态，避免只看某个代币的单条标题。 | 市场数据可用，并带有新鲜的观测时间。 |
| `analyze_token` | 提供代币价格和技术背景，用于模拟风险方案。 | 正数价格与 ATR，以及 market、technicals 可用性。 |
| `deep_analysis` | 增加催化剂、风险和多因素一致性，而不是只依赖一个指标。 | primary、derivatives 可用，并返回结构化 catalysts 和 risks。 |
| `monitor_market_sentiment_shift` | 检查七天情绪变化是否支持或反驳新闻叙事。 | 情绪证据可用，并带有新鲜观测时间。 |

每条 RYO 结果都会保留规范化请求、`status`、`data_mode`、`as_of`、`availability`、`warnings` 和结构化数据。Live mode 只接受新鲜的 `live` RYO 证据；模拟或未知数据不能静默变成实时证据。

## 确定性门槛与 `NO_TRADE`

LLM 可以提取声明并撰写受证据约束的看多、看空论点，但不能批准自己的证据，也不能绕过代码门槛。以下情况会返回 `NO_TRADE`：

- 核心声明没有独立发布者支持；
- 搜索结果与输入文章重复，或属于同一个发布者身份；
- 必需 RYO 证据不可用、过期、在 live mode 中仍是模拟数据，或结构不符合契约；
- Bull 或 Bear 引用了证据包中不存在的 evidence ID；
- 模型不可用或输出不符合 schema；
- 价格、ATR 或所选风险等级无法生成有效的模拟风险方案；
- 证据哈希、声明引用或因果链完整性检查失败。

缺失数据保持缺失。系统不会为了强行给出仓位而编造价格、来源、时间或市场信号。

## 可复盘凭证与完整性模型

每次分析都会创建一份新凭证，包含声明、证据、Bull/Bear 论点、确定性结论、原因代码、因果链和仅用于练习的风险数值。每条证据都有内容哈希。凭证还记录：

- 整个证据包的 SHA-256 哈希；
- 覆盖语义决策记录的完整凭证 SHA-256 哈希。

Replay 会读取已保存凭证，重新验证 evidence ID 和哈希，重新计算确定性结论与原因，再比较完整性哈希。它不会重新调用 RYO、新闻搜索、原文章或模型。旧版 `1.0` 凭证仍可读取，但如果没有完整凭证哈希，就不能报告“完全一致”的复盘。

## 快速启动：确定性 Demo

环境要求：Node.js `22.12+`（或 `package.json` 声明的其他受支持版本）和 npm。

```bash
npm ci
npm run dev
```

打开 [http://localhost:5173](http://localhost:5173)，API 监听 `127.0.0.1:8787`。只要 live 配置缺失或不完整，服务器就会明确保持 Demo mode。默认 Demo 使用固定的“证据充分”场景，把凭证保存到 `./data/signalcourt.sqlite`，不会产生付费外部调用。

## Live mode 配置

1. 创建本地环境文件：

   ```bash
   cp .env.example .env
   ```

2. 填入全部实时服务凭证，并把示例发布者注册表替换为你已经审核的域名。
3. 运行 `npm run dev`，确认页面顶部显示 **Live mode**。

只有当 RYO、Tavily、OpenAI-compatible 模型和发布者注册表全部就绪时，SignalCourt 才进入 live mode。部分配置会回退到 demo mode，避免把模拟证据和实时证据混在一起。

| 环境变量 | Live 必需 | 用途 |
| --- | --- | --- |
| `PORT` | 否 | Fastify 端口，默认 `8787`。 |
| `DATABASE_PATH` | 否 | SQLite 凭证路径，默认 `./data/signalcourt.sqlite`。 |
| `RYO_MCP_URL` | 是 | 已认证 RYO MCP 地址。除非 RYO 明确要求，否则保留示例中的默认值。 |
| `RYO_MCP_KEY` | 是 | 仅服务端使用的 RYO 凭证。 |
| `TAVILY_API_KEY` | 是 | 仅服务端使用的独立新闻搜索凭证。 |
| `LLM_BASE_URL` | 是 | OpenAI-compatible 模型服务的 HTTPS 地址。 |
| `LLM_API_KEY` | 是 | 仅服务端使用的模型凭证。 |
| `LLM_MODEL` | 是 | 模型服务提供的准确模型 ID。 |
| `PUBLISHER_REGISTRY_JSON` | 是 | 可信可注册域名到发布者身份的 JSON 映射；至少两个域名，并对应两个不同 publisher ID。 |

发布者注册表是信任边界，不是装饰性 allowlist。应登记可能作为输入文章和独立搜索来源的基础域名。同一机构控制的网站应共享一个 publisher ID，防止同一个发布者被重复计算为两个独立来源。

## 命令与验证

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 同时运行 Vite 客户端和 Fastify API。 |
| `npm test` | 运行确定性单元/集成测试；live smoke 默认跳过。 |
| `npm run typecheck` | 检查客户端与服务端 TypeScript 类型。 |
| `npm run build` | 构建服务端和生产客户端。 |
| `npm run test:e2e` | 运行桌面/移动端全栈流程与视觉回归。 |
| `npm audit` | 审计生产和开发依赖。 |
| `npm run test:smoke:ryo` | 显式执行一次已认证 RYO catalog 查询和一次 `analyze_token` 调用。 |

确定性完整验证：

```bash
npm test
npm run typecheck
npm run build
npm run test:e2e
npm audit
git diff --check
```

RYO smoke test 需要真实凭证并消耗外部额度，因此必须显式运行：

```bash
# 先在 .env 中配置 RYO_MCP_URL 和 RYO_MCP_KEY。
npm run test:smoke:ryo
```

没有 `RUN_RYO_SMOKE=1` 时，测试文件会被收集但显示 skipped。启用后，如果缺少 RYO 环境变量，测试会给出明确错误；测试不会打印 key。

## 与比赛评分标准的对应关系

| 评分关注点 | SignalCourt 中可检查的证据 |
| --- | --- |
| 多来源组合 | 独立发布者新闻证据，加上四个不同 RYO 研究工具。 |
| 自主推理 | Verifier、Research Coordinator、Bull、Bear 和 Judge 都通过受限契约工作。 |
| 故障处理 | RYO 有界重试、显式 availability、schema 校验、新鲜度校验和确定性 `NO_TRADE`。 |
| 因果关系 | 声明账本和 causal chain 把结论连接到准确 evidence ID 与原因代码。 |
| 可重复性 | SQLite 只追加凭证可基于哈希后的已保存证据离线复盘。 |
| 界面质量 | 决策优先桌面工作台、语义化移动 tabs、键盘流程、可见焦点和非纯颜色状态。 |
| 负责任边界 | 不接钱包、不签名、不执行交易，也没有隐藏的 live fallback。 |

## 安全与负责任使用

- 外部文章、新闻结果和模型输出全部视为不可信输入。
- 公共 URL 抓取包含 SSRF 防护和响应大小限制。
- RYO、Tavily 与模型 key 只保存在服务端，绝不能提交到仓库。
- API 错误已经脱敏，请求体和外部响应都有大小限制。
- 项目没有钱包集成、私钥处理、交易签名或交易所下单能力。
- 所有仓位都是模拟练习，不是交易指令，也不是对市场结果的预测。

## 当前限制

- 普通 Demo 是确定性 fixture，不是实时市场数据。默认 UI 展示“证据充分”场景；“证据不足”fixture 由全栈 E2E 测试服务器覆盖。
- 已认证 RYO smoke test 需要用户自己的凭证和额度。只有在对应环境中成功运行后，才能说实时 RYO 已验证。
- 实时新闻质量取决于经过审核的发布者注册表，以及分析时外部搜索能找到的内容。
- 模型分数表示论点强度，不是经过校准的市场结果概率。
- SQLite 和单个本地服务器适合黑客松原型，不是多用户生产交易系统。
- SignalCourt 不做策略回测、资产组合管理、钱包连接或真实下单。

## 设计与实现文档

- [English design specification](docs/superpowers/specs/2026-10-05-signalcourt-design.md)
- [中文设计文档](docs/superpowers/specs/2026-10-05-signalcourt-design.zh-CN.md)
- [TDD 实现计划（中文）](docs/superpowers/plans/2026-10-08-signalcourt-mvp.md)
