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

## 安装（开发）

```bash
dsh plugin add --profile web link:/path/to/dsh-skill-recommender
```

随后重启宿主（工具与路由生效）、浏览器强刷（客户端面板生效）。配置键：patch 层的 `skill-recommender`。

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
