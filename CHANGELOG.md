# Changelog

> `dsh-skill-recommender` 的全部版本变更。本文件由 `scripts/release.mjs` 在发布时自动补写。
> 格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
> 说明：0.1.3 及更早的条目依据 git 历史与 npm 发布时间（2026-09-10 首发）回填。

## [Unreleased]

## [0.1.5] - 2026-09-29

### 兼容性

- 声明兼容 **DSH 0.2.0-rc.2**：`peerDependencies` 中官方 DSH 包的版本范围追加 `^0.2.0-rc.2`。功能与行为无变化，仅解除新版 DSH 下的兼容告警。


## [0.1.4] - 2026-09-27

### 修复 (Fixed)

- fix(session-scan): DSH 会话日志判据覆盖 v3/v4，裸 .jsonl 直读
- fix(build): 修复 44 处 tsc 类型错误并完成 0.1.5-rc.1 对齐
- fix(0.1.5): render must return ContentBlock[]; resolve zstd via extended PATH

### 其它 (Changed)

- chore(release): 新增 CHANGELOG（回填 0.1.0–0.1.3）并纳入发布物
- chore(verify): 接入可移植性验证与统一发布脚本
- chore(release): 0.1.3 — ship the tsc type fixes (44 errors → 0) + 0.1.5-rc.1 dep alignment
- chore(release): 0.1.2 — declare DSH 0.1.5 compatibility in peer range (drop retired dsh-client-runtime / dsh-client-ui-slots peers)
- chore(release): 0.1.1 — declare DSH compatibility (dsh.engines.dsh >=0.1.5-rc.1) + README compatibility section
- docs: document npm install command alongside local link install

### 兼容性 (Compatibility)

- DSH：`>=0.1.5-rc.1`
- Node：`^22.19.0 || >=24.0.0`
- DSH peer：^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.1 || ^0.1.5-rc.1

<!-- 日常提交的内容会累积到这里；发布时脚本会在本行下方插入新版本段落 -->

## [0.1.3] - 2026-09-11

### 修复 (Fixed)

- 修复 44 处 tsc 类型错误，完成 DSH 0.1.5-rc.1 依赖对齐（构建产物与 src 一致）。

## [0.1.2] - 2026-09-11

### 其它 (Changed)

- 在 peer 范围里声明 DSH 0.1.5 兼容，移除已退役的 `dsh-client-runtime` / `dsh-client-ui-slots` peer。

## [0.1.1] - 2026-09-11

### 其它 (Changed)

- 补 `dsh.engines.dsh = >=0.1.5-rc.1`，README 增加兼容性说明与 npm 安装命令。

## [0.1.0] - 2026-09-10

### 新增 (Added)

- 首个发布版本：读取本地 Codex / Claude / DSH 会话记录，构建「会话画像」（主题 / 工具 / 任务 / 邻近四维加权），并按全局「匹配指数」阈值推荐开源 skill；内置 GitHub 全网发现目录源。
- `src/child-env.ts`：扩展 PATH 解析 `zstd` 绝对路径，避免桌面端最小 PATH 下会话解压失败。
