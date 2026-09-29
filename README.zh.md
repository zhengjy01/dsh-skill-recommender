# dsh-skill-recommender

面向 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 的 **skill 推荐器**。它浏览你本地 **Codex / Claude / DSH 三种会话记录**，生成一份紧凑的**用户画像**，摄取**开源 skill 目录**，并用**加权打分 + 可调匹配指数**排序推荐——指数越高，只返回关联度越高的 skill。

## 它能做什么

1. **读取会话**：DSH（`~/.dsh/sessions/**/session.jsonl.zstd`）、Codex（`~/.codex/*.jsonl`）、Claude（`~/.claude/projects/**/*.jsonl`）——纯本地读文件，无需任何 API/凭据。
2. **构建画像**：主题分布、高频工具、任务类型、常用项目目录、语言/模型来源。
3. **摄取目录**：本地 skill 目录（`~/.agents/skills`、`~/.dsh/skills`、Obsidian `2️⃣ AI/Skill`）+ 远程 awesome 聚合（`awesome-dsh-skills`、`awesome-dsh-plugin`、`awesome-deepseek-harness`、Claude skills 生态），另带一份内置种子目录兜底。
4. **打分排序**：加权模型 `score = Σ(w_i × sim_i) / Σ(w_i)`，维度=主题 / 工具 / 任务 / 邻近已装。全局**匹配指数**（0–100，默认 60）为门槛：仅 `score ≥ index` 的 skill 入选，再取 top-N。

## 与 `dsh-skill-studio` 的区别

`dsh-skill-studio` 是**从你自己的会话里提取**可复用 skill；本插件是**外推你的画像 → 推荐第三方开源 skill**。两者互补。

## 工具（agent 可用）

| 工具 | 用途 |
| --- | --- |
| `recommender_scan` | 扫描会话、建画像、产出一次初步推荐。 |
| `recommender_recommend` | 推荐开源 skill，可临时覆盖 `index`/`topN`/`weights`。 |
| `recommender_profile` | 查看当前画像（主题/工具/任务/项目）。 |
| `recommender_config` | 配置来源、目录、窗口、匹配指数、每维度权重、可选 LLM 富化。 |
| `recommender_status` | 查看插件状态（不回显密钥）。 |

## Web 设置面板

设置页新增「**Skill 推荐器**」卡片：扫描按钮、**匹配指数滑条**（0–100）、四个**每维度权重滑条**（主题/工具/任务/邻近）、目录源开关、以及带分数/分项/跳转链接的推荐卡。指数与权重保存到 `~/.dsh/dsh-skill-recommender/config.json`（0600）。

## 兼容性

要求 **DeepSeek Harness ≥ 0.1.5-rc.1**（已在包清单的 `dsh.engines.dsh` 中声明，DSH 插件市场据此显示兼容版本），并已在 **0.1.5-rc.1** 上实测通过。本构建包含 DSH 0.1.5 的适配：工具结果的严格校验契约（lossless-JSON 快照、`additionalProperties: false` 的 schema 校验、`output.render` 必须返回 `ContentBlock[]`），以及不依赖宿主 PATH 的可执行文件解析（launchd 托管的宿主 `PATH` 只有 `/usr/bin:/bin`）。 **本版起**在 `peerDependencies` 中显式声明兼容 **DSH 0.2.0-rc.2**（官方 DSH 包的版本范围已含 `^0.2.0-rc.2`），在 0.2.0-rc.2 上不会再出现兼容告警；功能与行为无变化。

## 安装

1. 把插件装进你的 profile：

   ```bash
   # 从 npm 安装
   dsh plugin --profile web add dsh-skill-recommender

   # 或从 GitHub 安装（仓库带 dsh-plugin topic）
   dsh plugin --profile web add github:zhengjy01/dsh-skill-recommender

   # 本地开发
   dsh plugin --profile web add link:/path/to/dsh-skill-recommender
   ```

   **预期结果**：命令打印解析到的包名，并写进该 profile 的 `dsh.profile.bundles`。

   > **截图位 1 —— 安装输出。** 怎么截：命令执行完立刻截终端最后约 10 行（包名 +
   > profile）。要不要打码：出现用户名 / 家目录就打码。文件名建议
   > `docs/images/dsh-skill-recommender-1-install.png`。

2. 重启宿主（工具与路由生效），再强刷浏览器页面（客户端面板生效）。配置键：patch
   层的 `skill-recommender`。

   **预期结果**：**设置** 页出现「**Skill 推荐器**」卡片。

   > **截图位 2 —— 设置卡片。** 怎么截：卡片首屏（扫描按钮 + 匹配指数滑条）。
   > 要不要打码：私密的目录名打码。文件名建议
   > `docs/images/dsh-skill-recommender-2-card.png`。

3. 点 **扫描**。

   **预期结果**：进度条推进，随后出现带分数、分项与可点击来源链接的推荐卡。

   > **截图位 3 —— 带分数的推荐结果。** 怎么截：结果列表，2–3 张卡即可。文件名建议
   > `docs/images/dsh-skill-recommender-3-results.png`。

4. 可选：把 **匹配指数** 滑条拉高后重新扫描。

   **预期结果**：推荐更少、关联度更高（指数 90 通常只剩很少几条）。

   > **截图位 4 —— 指数闸门生效。** 怎么截：拉高指数前后各一张列表。文件名建议
   > `docs/images/dsh-skill-recommender-4-index.png`。

### 补图清单

| # | 放在哪 | 展示什么 | 怎么截 | 建议文件名 |
| --- | --- | --- | --- | --- |
| 1 | 安装 | 安装命令输出（包名 + profile） | 第 1 步后立刻截终端最后约 10 行；家目录打码 | `docs/images/dsh-skill-recommender-1-install.png` |
| 2 | 安装 | 设置页的「Skill 推荐器」卡片 | 设置页，卡片标题 + 扫描按钮 | `docs/images/dsh-skill-recommender-2-card.png` |
| 3 | 使用 | 带分数的推荐卡 | 结果列表，2–3 张 | `docs/images/dsh-skill-recommender-3-results.png` |
| 4 | 使用 | 拉高匹配指数后列表变短 | 同一列表，拉高指数前后 | `docs/images/dsh-skill-recommender-4-index.png` |

补图后请重跑 `npm pack --dry-run` 与可移植性门禁（`npm run verify`）——README 属于
发布物。

## 构建

```bash
pnpm install
pnpm bundle      # 产出 lib/index.js (ESM) + lib/client.js (浏览器 bundle)
node tests/smoke.mjs
```

## 说明

- 默认权重 `{topic: 50, tool: 50, task: 35, near: 40}`；指数门槛默认 `60`。
- 远程目录 12s 超时并缓存；离线时回退到缓存 + 内置种子目录。
- 不保存/不回显任何密钥；可选 LLM 富化复用 OpenAI 兼容配置。

## License

MIT

## 安装 / Install

```sh
# from npm (published package)
dsh plugin --profile web add dsh-skill-recommender

# or local development
dsh plugin --profile web add link:/path/to/dsh-skill-recommender

# then restart dsh web to activate
```

