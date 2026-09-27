# dsh-skill-recommender

A **skill recommender** for [DeepSeek Harness](https://github.com/deepseek-ai/dsh). It browses your **local session records across Codex, Claude and DSH**, builds a compact **user profile**, ingests an **open-source skill catalog**, and ranks skills with a **weighted score gated by a tunable match index** — the higher the index, the higher-relevance the recommendations only.

## What it does

1. **Reads sessions** from three agent sources — DSH (`~/.dsh/sessions/**/session.jsonl.zstd`), Codex (`~/.codex/*.jsonl`), Claude (`~/.claude/projects/**/*.jsonl`) — no API keys, purely local file reads.
2. **Builds a profile**: topic distribution, high-frequency tools, task types, common project directories, language/model source.
3. **Ingests a skill catalog**: local skill dirs (`~/.agents/skills`, `~/.dsh/skills`, your Obsidian `2️⃣ AI/Skill`) + remote awesome lists (`awesome-dsh-skills`, `awesome-dsh-plugin`, `awesome-deepseek-harness`, Claude skills ecosystem), plus a small bundled seed so it always returns something.
4. **Scores & ranks** with a weighted model: `score = Σ(w_i × sim_i) / Σ(w_i)`, where dimensions are topic / tool / task / proximity-to-installed. A global **match index** (0–100, default 60) is the gate: only skills with `score ≥ index` are returned, then top-N.

## Why it's different from `dsh-skill-studio`

`dsh-skill-studio` **extracts** reusable skills *from your own sessions*. This plugin **recommends third-party open-source skills** by extrapolating your profile. They complement each other.

## Tools (model-facing)

| Tool | Purpose |
| --- | --- |
| `recommender_scan` | Scan sessions, build the profile, produce an initial recommendation run. |
| `recommender_recommend` | Recommend open-source skills; optionally override `index` / `topN` / `weights` on the fly. |
| `recommender_profile` | Show the current user profile (topics, tools, tasks, projects). |
| `recommender_config` | Configure sources, catalogs, window, match index, per-dimension weights, optional LLM enrichment. |
| `recommender_status` | Show plugin status without leaking secrets. |

## Web settings panel

A **Skill 推荐器** card in the Web settings page: scan button, live **匹配指数 slider** (0–100), four **per-dimension weight sliders** (topic / tool / task / proximity), catalog toggles, and recommendation cards with scores, per-dimension breakdowns and a GitHub link. The index + weights are saved to `~/.dsh/dsh-skill-recommender/config.json` (mode `0600`).

## Compatibility

Requires **DeepSeek Harness ≥ 0.1.5-rc.1** (declared as `dsh.engines.dsh` in the package manifest, so the DSH plugin marketplace can report it) and is verified against **0.1.5-rc.1**. This build carries the DSH 0.1.5 adaptations: the strict tool-result contract (lossless-JSON snapshot, `additionalProperties: false` schema validation, and `output.render` returning `ContentBlock[]`) plus executable resolution that survives a launchd-started host whose `PATH` is only `/usr/bin:/bin`.

## Install

1. Add the plugin to your profile:

   ```bash
   # from npm
   dsh plugin --profile web add dsh-skill-recommender

   # or from GitHub (the repo carries the `dsh-plugin` topic)
   dsh plugin --profile web add github:zhengjy01/dsh-skill-recommender

   # local development
   dsh plugin --profile web add link:/path/to/dsh-skill-recommender
   ```

   Expected: the command prints the resolved package and records it in that
   profile's `dsh.profile.bundles`.

   > **Screenshot slot 1 — install output.** Capture the terminal right after the
   > command, last ~10 lines (package + profile). Redact your username / home
   > path. Save as `docs/images/dsh-skill-recommender-1-install.png`, then replace
   > this block with `![Install output](docs/images/dsh-skill-recommender-1-install.png)`.

2. Restart the host (tools + routes), then hard-refresh the browser page (client
   panel). Config key: `skill-recommender` in the bundle patch layer.

   Expected: **设置 (Settings)** shows the **Skill 推荐器** card.

   > **Screenshot slot 2 — the settings card.** Capture the card's first screen
   > (scan button + index slider). Redact any catalog names you consider private.
   > Save as `docs/images/dsh-skill-recommender-2-card.png`.

3. Press **扫描 / Scan**.

   Expected: the progress bar advances, then recommendation cards appear with a
   score, the per-dimension breakdown, and a clickable source link.

   > **Screenshot slot 3 — recommendations with scores.** Capture the result list
   > (2–3 cards are enough). Save as
   > `docs/images/dsh-skill-recommender-3-results.png`.

4. Optional: drag the **匹配指数 / index** slider up and re-scan.

   Expected: fewer, higher-relevance recommendations (index `90` typically
   returns very few).

   > **Screenshot slot 4 — the index gate works.** Capture the list before/after
   > raising the index. Save as
   > `docs/images/dsh-skill-recommender-4-index.png`.

## Build

```bash
pnpm install
pnpm bundle      # builds lib/index.js (ESM) + lib/client.js (browser bundle)
node tests/smoke.mjs
```

## Notes

- The default weight model is `{topic: 50, tool: 50, task: 35, near: 40}`; the index gate defaults to `60`.
- **Whole-web discovery**: the default `github-discovery` source queries the GitHub search API across the **entire platform** (agent/claude/codex skills, `SKILL.md`, `awesome skills` — 星标排序), so recommendations are not limited to one designated list. Results are cached (6h TTL); the unauthenticated search limit (10 req/min) is respected.
- **Skills vs plugins**: each catalog is tagged `skill` or `plugin`. By default only **skills** are recommended (`types: ['skill']`); tick **含插件** in the panel to also include DSH plugins. Both markdown lists and tables are parsed (DSH *skill* catalogs use tables).
- Remote catalogs are fetched with a 12s timeout and cached (6h TTL); offline runs fall back to the cache + bundled seed.
- **Background auto-scan**: set `autoScanMinutes` (default `60`, `0` = off) in the panel — the host refreshes the cached result in the background, and the panel shows the last result instantly on open. The cache is persisted to `~/.dsh/dsh-skill-recommender/last-result.json` (0600).
- No secrets are stored or echoed; LLM enrichment (optional) reuses OpenAI-compatible config, keys never returned.

## License

MIT

## Screenshots to add / 补图清单

| # | Where / 放在哪 | What it shows / 展示什么 | How to capture / 怎么截 | Suggested filename / 建议文件名 |
| --- | --- | --- | --- | --- |
| 1 | Install | The install command's output (package + profile) | Terminal right after step 1, last ~10 lines; redact home path | `docs/images/dsh-skill-recommender-1-install.png` |
| 2 | Install | The **Skill 推荐器** card in Settings | Settings page, card header + scan button | `docs/images/dsh-skill-recommender-2-card.png` |
| 3 | Usage | Recommendation cards with scores | Result list, 2–3 cards | `docs/images/dsh-skill-recommender-3-results.png` |
| 4 | Usage | Raising the index narrows the list | Same list before/after raising the index | `docs/images/dsh-skill-recommender-4-index.png` |

After adding the images, re-run `npm pack --dry-run` and the portability gate
(`npm run verify`) — the README is part of the published tarball.
补图后请重跑 `npm pack --dry-run` 与可移植性门禁（`npm run verify`）。

