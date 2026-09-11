/**
 * dsh-skill-recommender — core recommendation engine.
 *
 * Pure, no DSH-runtime dependency. Handles:
 *   - reading session records from THREE agent sources (DSH / Codex / Claude)
 *   - aggregating them into a compact user "profile" (topics, tools, tasks, langs)
 *   - ingesting an open-source skill catalog (local skill dirs + remote awesome
 *     repos, with a small bundled seed as a guaranteed fallback)
 *   - scoring each skill against the profile with a WEIGHTED model and a global
 *     threshold ("匹配指数"): higher index => only higher-relevance skills pass.
 *
 * All I/O is defensive: a broken/unknown file is skipped, never fatal.
 */
import { readdir, readFile, stat, mkdir, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { childEnv, resolveExecutable } from "./child-env.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG_FILE = join(homedir(), ".dsh", "dsh-skill-recommender", "config.json");
export const DEFAULT_CACHE_DIR = join(homedir(), ".dsh", "dsh-skill-recommender", "cache");
export const SESSION_ROOTS = {
	dsh: join(homedir(), ".dsh", "sessions"),
	codex: join(homedir(), ".codex"),
	claude: join(homedir(), ".claude", "projects")
};

const LOCAL_SKILL_DIRS = () => [
	join(homedir(), ".agents", "skills"),
	join(homedir(), ".dsh", "skills"),
	"/Users/zhengjunyao/Documents/Obsidian Vault/2️⃣ AI/Skill"
];

// Remote open-source skill catalogs. `kind` classifies each catalog so the
// recommender can default to SKILLS (not UI plugins): 'skill' = SKILL.md
// reusable skills; 'plugin' = DSH plugins / ecosystem (opt-in). The
// `sourceType: 'github'` catalog searches the WHOLE of GitHub for agent-skill
// repos (全网发现) instead of reading a fixed awesome list.
const REMOTE_CATALOGS = [
	{
		id: "github-discovery",
		label: "GitHub 全网发现（agent skills）",
		sourceType: "github",
		kind: "skill"
	},
	{
		id: "awesome-dsh-skills",
		label: "awesome-dsh-skills (DSH 技能)",
		repo: "https://raw.githubusercontent.com/hackerFish/awesome-dsh-skills/main/README.md",
		home: "https://github.com/hackerFish/awesome-dsh-skills",
		kind: "skill"
	},
	{
		id: "claude-skills",
		label: "Claude skills 生态",
		repo: "https://raw.githubusercontent.com/cooler333/cool-claude-code/main/README.md",
		home: "https://github.com/cooler333/cool-claude-code",
		kind: "skill"
	},
	{
		id: "awesome-dsh-plugin",
		label: "awesome-dsh-plugin (DSH 插件)",
		repo: "https://raw.githubusercontent.com/beancookie/awesome-dsh-plugin/main/README.md",
		home: "https://github.com/beancookie/awesome-dsh-plugin",
		kind: "plugin"
	},
	{
		id: "awesome-deepseek-harness",
		label: "awesome-deepseek-harness (DSH 生态/插件)",
		repo: "https://raw.githubusercontent.com/Dominic789654/awesome-deepseek-harness/main/README.md",
		home: "https://github.com/Dominic789654/awesome-deepseek-harness",
		kind: "plugin"
	}
];

// ---------------------------------------------------------------------------
// Config store
// ---------------------------------------------------------------------------

export function defaultConfig() {
	return {
		enabled: true,
		sources: ["dsh", "codex", "claude"], // which session sources to read
		catalogs: ["github-discovery", ...REMOTE_CATALOGS.filter((c) => c.kind === "skill" && c.id !== "github-discovery").map((c) => c.id)], // 全网发现 + skill 目录 by default
		types: ["skill"], // recommend only these kinds ('skill' | 'plugin')
		windowDays: 30, // session window
		maxSessionsPerSource: 40,
		index: 60, // 匹配指数：全局阈值 0-100，越高越精越少
		topN: 10,
		weights: { topic: 50, tool: 50, task: 35, near: 40 }, // per-dimension weight 0-100
		autoScanMinutes: 60, // 后台自动扫描间隔（分钟，0=关闭）
		useLlm: false, // optionally enrich profile with an LLM
		llmBaseUrl: "",
		llmApiKey: "",
		llmModel: "",
		lastRunAt: "",
		lastRunSummary: ""
	};
}

// Remote catalogs are cached for this long before a re-fetch. Keeps repeat
// scans fast (the aggregate READMEs can be ~1 MB and slow through a proxy).
export const CATALOG_TTL_MS = 6 * 3600 * 1000;

// ---------------------------------------------------------------------------
// Scan progress (in-memory, single scan at a time)
// ---------------------------------------------------------------------------

let scanProgress = { active: false, stage: "", pct: 0, message: "", updatedAt: 0 };

/** Current scan progress snapshot (for the panel's progress bar). */
export function getScanProgress() {
	return scanProgress;
}

function setScanProgress(patch) {
	scanProgress = { ...scanProgress, ...patch, updatedAt: Date.now() };
}

/** Reset progress to idle. */
export function resetScanProgress() {
	scanProgress = { active: false, stage: "", pct: 0, message: "", updatedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Last-result cache (so the panel can show results instantly, without waiting
// for a fresh scan — refreshed in the background by the auto-scan timer).
// ---------------------------------------------------------------------------

function cacheResultPath() {
	return join(cacheDir(), "..", "last-result.json");
}

let lastResult = null;

/** Return the cached last scan result (falls back to disk on first call). */
export async function getCachedResult() {
	if (lastResult) return lastResult;
	try {
		const parsed = JSON.parse(await readFile(cacheResultPath(), "utf8"));
		lastResult = parsed;
		return parsed;
	} catch {
		return null;
	}
}

/** Cache a scan result in memory + persist to disk (mode 0600). */
export async function setCachedResult(result) {
	lastResult = result || null;
	try {
		await mkdir(dirname(cacheResultPath()), { recursive: true });
		const tmp = cacheResultPath() + ".tmp";
		await writeFile(tmp, JSON.stringify(result || {}, null, 2), { mode: 0o600 });
		await rename(tmp, cacheResultPath());
	} catch {
		/* best-effort persistence */
	}
	return result;
}

function clamp(v, min, max) {
	if (typeof v !== "number" || !Number.isFinite(v)) return null;
	return Math.min(max, Math.max(min, v));
}

export function parse(raw) {
	const r = typeof raw === "object" && raw !== null ? raw : {};
	const num = (v, f, min, max) => clamp(v, min, max) ?? f;
	const bool = (v, f) => typeof v === "boolean" ? v : f;
	const str = (v, f = "") => typeof v === "string" ? v : f;
	const d = defaultConfig();
	const sources = Array.isArray(r.sources) && r.sources.length ? r.sources.filter((s) => ["dsh", "codex", "claude"].includes(s)) : d.sources;
	const cats = Array.isArray(r.catalogs) && r.catalogs.length ? r.catalogs.filter((c) => REMOTE_CATALOGS.some((x) => x.id === c)) : d.catalogs;
	const types = Array.isArray(r.types) && r.types.length ? r.types.filter((t) => ["skill", "plugin"].includes(t)) : d.types;
	const w = typeof r.weights === "object" && r.weights !== null ? r.weights : {};
	return {
		enabled: bool(r.enabled, d.enabled),
		sources,
		catalogs: cats,
		types,
		windowDays: num(r.windowDays, d.windowDays, 1, 365),
		maxSessionsPerSource: num(r.maxSessionsPerSource, d.maxSessionsPerSource, 1, 200),
		index: num(r.index, d.index, 0, 100),
		topN: num(r.topN, d.topN, 1, 50),
		weights: {
			topic: num(w.topic, d.weights.topic, 0, 100),
			tool: num(w.tool, d.weights.tool, 0, 100),
			task: num(w.task, d.weights.task, 0, 100),
			near: num(w.near, d.weights.near, 0, 100)
		},
		autoScanMinutes: num(r.autoScanMinutes, d.autoScanMinutes, 0, 10080),
		useLlm: bool(r.useLlm, d.useLlm),
		llmBaseUrl: str(r.llmBaseUrl, d.llmBaseUrl),
		llmApiKey: str(r.llmApiKey, d.llmApiKey),
		llmModel: str(r.llmModel, d.llmModel),
		lastRunAt: str(r.lastRunAt, d.lastRunAt),
		lastRunSummary: str(r.lastRunSummary, d.lastRunSummary)
	};
}

function configPath() {
	const o = process.env.DSH_RECOMMENDER_CONFIG;
	return o !== void 0 && o !== "" ? o : DEFAULT_CONFIG_FILE;
}
function cacheDir() {
	const o = process.env.DSH_RECOMMENDER_CACHE;
	return o !== void 0 && o !== "" ? o : DEFAULT_CACHE_DIR;
}

export class RecommenderStore {
	async load() {
		try {
			return parse(JSON.parse(await readFile(configPath(), "utf8")));
		} catch {
			return defaultConfig();
		}
	}
	async save(cfg) {
		await mkdir(dirname(configPath()), { recursive: true });
		const tmp = configPath() + ".tmp";
		await writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
		await rename(tmp, configPath());
		return cfg;
	}
	async patch(args) {
		const cur = await this.load();
		let merged = { ...cur };
		if (args !== void 0 && typeof args === "object") {
			for (const k of Object.keys(cur)) {
				if (k in args) merged[k] = args[k];
			}
			if (args.weights && typeof args.weights === "object") {
				merged.weights = { ...cur.weights, ...args.weights };
			}
		}
		if (args && args.reset === true) merged = defaultConfig();
		const view = parse(merged);
		await this.save(view);
		return view;
	}
	async view() {
		const v = await this.load();
		return {
			...v,
			llmKeyMasked: v.llmApiKey ? v.llmApiKey.slice(0, 2) + "…" + v.llmApiKey.slice(-2) : "",
			llmApiKey: "",
			catalogs: v.catalogs,
			types: v.types,
			catalogMeta: REMOTE_CATALOGS,
			configPath: configPath(),
			configured: !(v.useLlm && !(v.llmBaseUrl && v.llmApiKey && v.llmModel))
		};
	}
}

// ---------------------------------------------------------------------------
// Session records
// ---------------------------------------------------------------------------

export interface SessionRecord {
	source: "dsh" | "codex" | "claude";
	id: string;
	ts: number;
	cwd: string;
	model?: string;
	userMsgs: string[];
	assistantMsgs: string[];
	toolNames: string[];
}

const ROLE_LABEL = { user: "user", assistant: "assistant" };

function truncate(s, n) {
	return s.length > n ? s.slice(0, n) : s;
}

// --- Readers ---------------------------------------------------------------

/** A blank record; readers fill it as they walk one session log. */
function emptyRecord(source: SessionRecord["source"]): SessionRecord {
	return { source, id: "", ts: 0, cwd: "", model: "", userMsgs: [], assistantMsgs: [], toolNames: [] };
}

/** Progress sink: fetchCatalog emits a string, loadRegistry an {pct,message}. */
type ProgressFn = (p: any) => void;

interface FetchOptions {
	force?: boolean;
	onProgress?: ProgressFn;
}

interface LoadRegistryOptions {
	localSkills?: any[];
	forceRefresh?: boolean;
	onProgress?: ProgressFn;
}

// --- DSH -------------------------------------------------------------------
async function readDsh(file: string): Promise<SessionRecord> {
	// Absolute zstd + widened PATH: a launchd-started DSH has only
	// /usr/bin:/bin, where zstd is absent — every session would be skipped
	// silently by the per-file catch below.
	const { stdout } = await execFileAsync(resolveExecutable("zstd"), ["-d", "-c", file], {
		maxBuffer: 512 * 1024 * 1024,
		env: childEnv(),
	});
	const rec = emptyRecord("dsh");
	const userMsgs = [];
	const assistantMsgs = [];
	const toolNames = [];
	for (const line of stdout.split("\n")) {
		if (!line) continue;
		let o;
		try {
			o = JSON.parse(line);
		} catch {
			continue;
		}
		if (!o || typeof o !== "object") continue;
		if (o.type === "session") {
			rec.id = o.id;
			rec.ts = o.createdAt || Date.now();
			rec.cwd = o.cwd || "";
			rec.model = o.model || "";
		} else if (o.type === "agent/inbox/spliced") {
			const ins = o.data && o.data.inserted;
			if (Array.isArray(ins)) {
				for (const item of ins) {
					if (!item) continue;
					const role = item.role;
					const content = Array.isArray(item.content) ? item.content : [];
					const text = content.map((c) => (c && c.type === "text" ? c.text : "")).join(" ").trim();
					if (!text) continue;
					if (role === "user") userMsgs.push(text);
					else if (role === "assistant" || role === "agent") assistantMsgs.push(text);
				}
			}
		} else if (o.type === "tool/call") {
			const name = o.data && o.data.name;
			if (name) toolNames.push(String(name));
		}
	}
	rec.userMsgs = userMsgs;
	rec.assistantMsgs = assistantMsgs;
	rec.toolNames = [...new Set(toolNames)];
	return rec;
}

// --- Codex -----------------------------------------------------------------
async function readCodex(file) {
	const text = await readFile(file, "utf8");
	const rec = emptyRecord("codex");
	const userMsgs = [];
	const assistantMsgs = [];
	const toolNames = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		let o;
		try {
			o = JSON.parse(line);
		} catch {
			continue;
		}
		if (!o || typeof o !== "object") continue;
		if (o.type === "session_meta") {
			rec.id = o.payload?.id || "";
			rec.ts = o.payload?.timestamp ? new Date(o.payload.timestamp).getTime() : Date.now();
			rec.cwd = o.payload?.cwd || "";
			rec.model = o.payload?.model_provider || "";
		} else if (o.type === "event_msg" && o.payload) {
			const p = o.payload;
			if (p.type === "response_item") {
				const msg = p.msg || {};
				if (msg.type === "message" && (msg.role === "user" || msg.role === "assistant")) {
					const content = Array.isArray(msg.content) ? msg.content : [];
					const text = content
						.map((c) => (c && (c.type === "input_text" || c.type === "output_text") ? c.text : ""))
						.join(" ")
						.trim();
					if (text) {
						if (msg.role === "user") userMsgs.push(text);
						else assistantMsgs.push(text);
					}
				} else if (msg.type === "function_call" && msg.name) {
					toolNames.push(String(msg.name));
				}
			}
		}
	}
	rec.userMsgs = userMsgs;
	rec.assistantMsgs = assistantMsgs;
	rec.toolNames = [...new Set(toolNames)];
	return rec;
}

// --- Claude ----------------------------------------------------------------
async function readClaude(file) {
	const text = await readFile(file, "utf8");
	const rec = emptyRecord("claude");
	const userMsgs = [];
	const assistantMsgs = [];
	const toolNames = [];
	const push = (role, raw) => {
		if (!raw) return;
		let text = "";
		if (typeof raw === "string") text = raw;
		else if (Array.isArray(raw)) {
			text = raw
				.map((b) => {
					if (!b || typeof b !== "object") return "";
					if (b.type === "text" && typeof b.text === "string") return b.text;
					if (b.type === "tool_use" && b.name) {
						toolNames.push(String(b.name));
						return "";
					}
					if (b.type === "tool_result") return "";
					return "";
				})
				.join(" ")
				.trim();
		}
		if (text) {
			if (role === "user") userMsgs.push(text);
			else assistantMsgs.push(text);
		}
	};
	for (const line of text.split("\n")) {
		if (!line) continue;
		let o;
		try {
			o = JSON.parse(line);
		} catch {
			continue;
		}
		if (!o || typeof o !== "object") continue;
		if (o.type === "queue-operation") {
			// content wraps a message object; check role/type first
			const c = o.content;
			if (c && typeof c === "object") {
				if (c.type === "user") {
					rec.id = rec.id || o.sessionId || "";
					push("user", c.message?.content ?? c.content ?? c.message);
				} else if (c.type === "assistant") {
					push("assistant", c.message?.content ?? c.content);
					if (c.message?.model) rec.model = c.message.model;
				}
			}
		} else if (o.type === "user" || o.type === "assistant") {
			rec.id = rec.id || o.sessionId || o.uuid || "";
			if (o.message?.model) rec.model = o.message.model;
			push(o.type, o.message?.content ?? o.content);
		}
	}
	rec.userMsgs = userMsgs;
	rec.assistantMsgs = assistantMsgs;
	rec.toolNames = [...new Set(toolNames)];
	if (!rec.ts) rec.ts = Date.now();
	return rec;
}

// --- Collect ---------------------------------------------------------------
async function walk(dir, predicate, out) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) await walk(p, predicate, out);
		else if (predicate(e.name)) out.push(p);
	}
}

async function collectForSource(source, cutoff, max) {
	const candidates = [];
	if (source === "dsh") {
		const files = [];
		await walk(SESSION_ROOTS.dsh, (n) => n === "session.jsonl.zstd", files);
		for (const f of files) {
			let st;
			try {
				st = await stat(f);
			} catch {
				continue;
			}
			if (st.mtimeMs < cutoff) continue;
			candidates.push({ f, mtime: st.mtimeMs });
		}
	} else if (source === "codex") {
		const files = [];
		await walk(join(SESSION_ROOTS.codex, "sessions"), (n) => n.endsWith(".jsonl"), files);
		await walk(join(SESSION_ROOTS.codex, "archived_sessions"), (n) => n.startsWith("rollout-") && n.endsWith(".jsonl"), files);
		const seen = new Set();
		const uniq = files.filter((f) => {
			const k = f.replace(/^.*\//, "");
			if (seen.has(k)) return false;
			seen.add(k);
			return true;
		});
		for (const f of uniq) {
			let st;
			try {
				st = await stat(f);
			} catch {
				continue;
			}
			if (st.mtimeMs < cutoff) continue;
			candidates.push({ f, mtime: st.mtimeMs });
		}
	} else if (source === "claude") {
		const files = [];
		await walk(SESSION_ROOTS.claude, (n) => n.endsWith(".jsonl"), files);
		for (const f of files) {
			let st;
			try {
				st = await stat(f);
			} catch {
				continue;
			}
			if (st.mtimeMs < cutoff) continue;
			candidates.push({ f, mtime: st.mtimeMs });
		}
	}
	// Only DECOMPRESS / parse the newest `max` files — stat-ing hundreds of logs
	// is fast, spawning zstd (or parsing JSONL) for all of them is not.
	candidates.sort((a, b) => b.mtime - a.mtime);
	const top = candidates.slice(0, max);
	const found = [];
	for (const c of top) {
		let rec;
		try {
			if (source === "dsh") rec = await readDsh(c.f);
			else if (source === "codex") rec = await readCodex(c.f);
			else rec = await readClaude(c.f);
		} catch {
			continue;
		}
		if (!rec.userMsgs.length && !rec.assistantMsgs.length) continue;
		found.push({ f: c.f, mtime: c.mtime, rec });
	}
	return found;
}

/** Scan enabled sources; returns the unified session records (most recent first). */
export async function scanSessions(cfg) {
	const cutoff = Date.now() - cfg.windowDays * 86400000;
	const all = [];
	for (const source of cfg.sources) {
		try {
			const items = await collectForSource(source, cutoff, cfg.maxSessionsPerSource);
			all.push(...items.map((i) => ({ ...i.rec, file: i.f })));
		} catch {
			// skip a broken source
		}
	}
	all.sort((a, b) => b.ts - a.ts);
	return all;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

// A compact domain tagger — keyword -> tag. Extensible; the LLM (optional)
// refines this with free-text understanding.
const TOPIC_KEYWORDS: Array<[string, string[]]> = [
	["blog", ["博客", "hexo", "notionnext", "文章", "post", "slug", "notion"]],
	["docs", ["文档", "docx", "pdf", "markdown", "知识库", "obsidian", "vault", "笔记"]],
	["dsh-plugin", ["dsh", "插件", "cordis", "tsdown", "bundle", "manifest", "skill"]],
	["dev", ["代码", "npm", "git", "github", "build", "test", "debug", "bug", "typescript", "node"]],
	["automation", ["定时", "cron", "同步", "workflow", "调度", "派发", "report"]],
	["data", ["数据", "统计", "chart", "数据库", "table", "excel", "csv"]],
	["mcp", ["mcp", "oauth", "token", "服务", "代理", "server"]],
	["research", ["研究", "调研", "检索", "search", "research", "资料"]],
	["writing", ["写作", "内容", "文案", "小红书", "公众号", "创作"]],
	["ops", ["部署", "发布", "push", "restart", "配置", "vercel", "cloudflare", "aliyun"]]
];
const TOOL_TASK_RE: Array<[string, string[]]> = [
	["dev", ["bash", "npm", "git", "write", "edit", "read", "grep", "glob", "workflow", "subagent"]],
	["research", ["web_search", "weread", "mnemon", "cubox", "skillmgr"]],
	["io", ["flomo", "notion", "ticktick", "zsxq", "feishu", "wps"]],
	["automation", ["dispatcher", "ticktick", "cron", "task"]]
];

function tokenize(text) {
	const t = String(text || "").toLowerCase();
	return t;
}

function addTagCount(counts, tag, weight) {
	counts[tag] = (counts[tag] || 0) + weight;
}

/** Build a compact user profile from session records. */
export function buildProfile(records) {
	const topicCounts = {};
	const toolCounts = {};
	const tasks = {};
	const langs = {};
	const projects = {};
	const models = {};
	let totalUser = 0;
	let totalAssistant = 0;

	for (const r of records) {
		const joined = tokenize((r.userMsgs || []).join(" ") + " " + (r.assistantMsgs || []).join(" "));
		const words = Math.min((r.userMsgs || []).join(" ").length, 4000);
		totalUser += words;
		totalAssistant += Math.min((r.assistantMsgs || []).join(" ").length, 4000);
		// topics
		for (const [tag, kws] of TOPIC_KEYWORDS) {
			for (const kw of kws) {
				if (joined.includes(kw)) {
					addTagCount(topicCounts, tag, 1);
					break;
				}
			}
		}
		// project
		const proj = r.cwd ? basename(r.cwd) : "";
		if (proj) projects[proj] = (projects[proj] || 0) + 1;
		if (r.model) models[r.model] = (models[r.model] || 0) + 1;
		// zh vs en
		const hasZh = /[\u4e00-\u9fff]/.test(joined);
		langs[hasZh ? "zh" : "en"] = (langs[hasZh ? "zh" : "en"] || 0) + 1;
		// tool -> task
		for (const t of r.toolNames || []) {
			toolCounts[t] = (toolCounts[t] || 0) + 1;
			for (const [task, tools] of TOOL_TASK_RE) {
				if (tools.includes(t)) {
					tasks[task] = (tasks[task] || 0) + 1;
					break;
				}
			}
		}
	}

	const topicVec = normalizeVec(topicCounts);
	const toolVec = normalizeVec(toolCounts);
	const taskVec = normalizeVec(tasks);
	const topTopics = topKeys(topicVec, 8);
	const topTools = topKeys(toolVec, 12);
	const topTasks = topKeys(taskVec, 6);

	return {
		records: records.length,
		totalUserChars: totalUser,
		totalAssistantChars: totalAssistant,
		topics: topicVec,
		tools: toolVec,
		tasks: taskVec,
		topTopicTags: topTopics,
		topToolNames: topTools,
		topTaskTypes: topTasks,
		topProjects: topKeys(projects, 8),
		languages: topKeys(langs, 3),
		models: topKeys(models, 5),
		ts: Date.now()
	};
}

function normalizeVec(counts: Record<string, number>): Record<string, number> {
	const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
	const out: Record<string, number> = {};
	for (const k of Object.keys(counts)) out[k] = counts[k] / total;
	return out;
}
function topKeys(vec: Record<string, number>, n: number) {
	return Object.entries(vec)
		.sort((a, b) => b[1] - a[1])
		.slice(0, n)
		.map(([k, v]) => ({ k, v: +v.toFixed(3) }));
}

// ---------------------------------------------------------------------------
// Skill registry
// ---------------------------------------------------------------------------

export interface Skill {
	id: string;
	name: string;
	description: string;
	tags: string[];
	tools: string[];
	taskTypes: string[];
	source: string;
	url?: string;
	installed: boolean;
	kind: "skill" | "plugin";
}

function slug(s) {
	return String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function readSkillMd(file) {
	const text = await readFile(file, "utf8");
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	const head = m ? m[1] : "";
	const name = (head.match(/^name:\s*(.+)$/m) || [])[1]?.trim() || slug(basename(dirname(file)));
	const desc = (head.match(/^description:\s*(.+)$/m) || [])[1]?.trim() || "";
	return { name, description: desc };
}

async function scanLocalSkills() {
	const out = [];
	for (const dir of LOCAL_SKILL_DIRS()) {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (!e.isDirectory()) continue;
			const md = join(dir, e.name, "SKILL.md");
			let meta;
			try {
				meta = await readSkillMd(md);
			} catch {
				continue;
			}
			out.push({
				id: "local:" + meta.name,
				name: meta.name,
				description: meta.description,
				tags: inferTags(meta.description + " " + meta.name),
				tools: inferTools(meta.description + " " + meta.name),
				taskTypes: inferTasks(meta.description + " " + meta.name),
				source: "local",
				installed: true,
				kind: "skill"
			});
		}
	}
	return out;
}

function inferTags(desc) {
	const t = String(desc || "").toLowerCase();
	const out = [];
	for (const [tag, kws] of TOPIC_KEYWORDS) {
		if (kws.some((kw) => t.includes(kw))) out.push(tag);
	}
	return out;
}
function inferTasks(desc) {
	const t = String(desc || "").toLowerCase();
	const out = [];
	for (const [task, tools] of TOOL_TASK_RE) {
		if (tools.some((kw) => t.includes(kw))) out.push(task);
	}
	return out;
}

// Infer the tools a skill likely uses from its description, so the tool
// dimension can reward genuine overlap instead of always being 0 for entries
// that have no explicit tool list (e.g. table-parsed skill catalogs).
const TOOL_KEYWORDS: Array<[string, string[]]> = [
	["git", ["git", "commit", "branch", "pr", "pull request", "repo", "github", "push"]],
	["bash", ["bash", "shell", "cli", "command", "terminal", "脚本", "terminal"]],
	["npm", ["npm", "node", "package", "install", "publish", "依赖", "tsdown", "build"]],
	["write", ["写", "文档", "doc", "markdown", "file", "笔记", "起草", "生成文件"]],
	["read", ["读", "查看", "读取", "search", "检索", "review"]],
	["web_search", ["搜索", "调研", "research", "联网"]],
	["skill", ["skill", "技能", "skillmgr"]],
	["subagent", ["subagent", "并行", "子代理", "分派"]],
	["workflow", ["workflow", "流程", "编排", "自动化"]]
];
function inferTools(desc) {
	const t = String(desc || "").toLowerCase();
	const out = [];
	for (const [tool, kws] of TOOL_KEYWORDS) if (kws.some((kw) => t.includes(kw))) out.push(tool);
	return out;
}

// Parse an awesome README into skill/plugin entries. Supports BOTH markdown
// list items (`- [name](url) — desc`) and markdown tables (`| Skill | Purpose |`),
// because the DSH *skill* catalogs use tables while the *plugin* lists use
// bullets. Every entry is tagged with the catalog `kind` ('skill' | 'plugin').
function parseAwesomeMd(md, sourceId, kind) {
	const out = [];
	const lines = String(md || "").split("\n");
	const isNumeric = (c) => /^\d+(\.\d+)?k?%?$/.test(c) || /^[+−-]?\d/.test(c);
	const isStarCell = (c) => /[⭐★]/.test(c);
	const isHeaderCell = (c) => /^(name|skill|package|repo|plugin|purpose|description|stars|growth|category|#|#)$/i.test(c);
	const push = (name, desc, url) => {
		if (!name) return;
		// A name cell may itself be a markdown link `[label](url)`; extract both.
		let url2 = url || "";
		let n = String(name).trim();
		const linkInName = n.match(/\[([^\]]+)\]\(([^)]+)\)/);
		if (linkInName) {
			n = linkInName[1].trim();
			url2 = url2 || linkInName[2].trim();
		}
		n = n.replace(/^[0-9]+[.\s)]*/, "").trim();
		if (n.length < 3) return;
		const key = slug(n) || slug(name);
		if (!key || key.length < 3) return;
		if (out.some((e) => e.id === sourceId + ":" + key)) return;
		out.push({
			id: sourceId + ":" + key,
			name: n,
			description: (desc || "").replace(/^—\s*/, "").slice(0, 220),
			tags: inferTags(desc + " " + n),
			tools: inferTools(desc + " " + n),
			taskTypes: inferTasks(desc + " " + n),
			source: sourceId,
			url: url2 ? (url2.startsWith("http") ? url2 : "https://github.com/" + url2.replace(/^\.\//, "")) : url2,
			installed: false,
			kind
		});
	};
	for (const line of lines) {
		const t = line.trim();
		// --- list item: - [name](url) — desc ---
		const list = t.match(/^[-*]\s+\[([^\]]+)\]\(([^)]+)\)\s*[:—-]?\s*(.*)$/);
		if (list) {
			const label = list[1].trim();
			const url = list[2].trim();
			const rawDesc = (list[3] || "").replace(/^—\s*/, "").trim();
			if (url.startsWith("#") || /^(table|contents|toc|license|contribut|back to top|相关|贡献|免责|徽章)/i.test(label)) continue;
			// owner/repo -> repo basename
			let name = label;
			const gh = url.match(/github\.com\/([^/?#]+)\/([^/?#]+)/);
			if (gh && (label.includes("/") || /^https?:/.test(label))) name = gh[2];
			else if (name.includes("/")) name = name.split("/").pop();
			const display = name.replace(/^dsh[-_]?/i, "").replace(/[_-]+/g, " ").trim() || name;
			push(display, rawDesc, url);
			continue;
		}
		// --- table row: | a | b | c | ---
		if (t.startsWith("|")) {
			const cells = t.split("|").map((c) => c.trim()).filter((c) => c !== "");
			if (!cells.length) continue;
			if (cells.every((c) => /^:?-{1,}:?$/.test(c))) continue; // separator
			if (cells.some(isHeaderCell) && !cells.some((c) => c.length > 24)) continue; // short header row
			let name = "";
			let desc = "";
			for (let i = 0; i < cells.length; i++) {
				const c = cells[i].trim();
				if (isNumeric(c) || isStarCell(c) || c.length < 3) continue;
				if (/^(name|skill|purpose|description|package|repo|plugin)$/i.test(c)) continue;
				name = c;
				for (let j = i + 1; j < cells.length; j++) {
					const d = cells[j].trim();
					if (isNumeric(d) || isStarCell(d) || d.length < 2) continue;
					desc = d;
					break;
				}
				break;
			}
			if (name) push(name, desc, "");
		}
	}
	return out;
}

async function fetchCatalog(c, { force = false, onProgress }: FetchOptions = {}) {
	// GitHub-全网 discovery: search the whole of GitHub for agent-skill repos.
	if (c.sourceType === "github") {
		return fetchGithubSkills(c, { force, onProgress });
	}
	// Serve from cache when fresh (unless forced) — avoids the slow re-fetch.
	if (!force) {
		try {
			const cached = join(cacheDir(), "catalog-" + c.id + ".md");
			const st = await stat(cached);
			if (Date.now() - st.mtimeMs < CATALOG_TTL_MS) {
				onProgress?.(`读缓存 ${c.id}`);
				return parseAwesomeMd(await readFile(cached, "utf8"), c.id, c.kind);
			}
		} catch {
			/* no fresh cache */
		}
	}
	try {
		onProgress?.(`抓取 ${c.id}…`);
		const res = await fetch(c.repo, { signal: AbortSignal.timeout(12000) });
		if (!res.ok) throw new Error("catalog http " + res.status);
		const md = await res.text();
		await mkdir(cacheDir(), { recursive: true });
		await writeFile(join(cacheDir(), "catalog-" + c.id + ".md"), md, "utf8");
		return parseAwesomeMd(md, c.id, c.kind);
	} catch {
		// fall back to cached catalog if present
		try {
			const cached = await readFile(join(cacheDir(), "catalog-" + c.id + ".md"), "utf8");
			return parseAwesomeMd(cached, c.id, c.kind);
		} catch {
			return [];
		}
	}
}

// Whole-web GitHub discovery. Queries the GitHub search API for agent-skill
// repositories across the entire platform (星标排序), covers the agent-skills
// ecosystem broadly rather than one designated list. Results are cached (6h);
// the unauthenticated search limit (10 req/min) is respected since we run a
// handful of queries per scan and cache the outcome.
const GITHUB_SKILL_QUERIES = [
	"agent skills",
	"claude skills",
	"codex skills",
	'"SKILL.md"',
	"awesome skills",
	"deepseek harness dsh"
];
async function fetchGithubSkills(c, { force = false, onProgress }: FetchOptions = {}) {
	const cacheFile = join(cacheDir(), "catalog-" + c.id + ".json");
	if (!force) {
		try {
			const st = await stat(cacheFile);
			if (Date.now() - st.mtimeMs < CATALOG_TTL_MS) {
				onProgress?.(`读缓存 ${c.id}`);
				return JSON.parse(await readFile(cacheFile, "utf8"));
			}
		} catch {
			/* no fresh cache */
		}
	}
	const seen = new Map();
	for (const q of GITHUB_SKILL_QUERIES) {
		onProgress?.(`搜索 GitHub: ${q}`);
		try {
			const url = "https://api.github.com/search/repositories?q=" + encodeURIComponent(q) + "&sort=stars&order=desc&per_page=25";
			const res = await fetch(url, {
				headers: { accept: "application/vnd.github+json", "user-agent": "dsh-skill-recommender" },
				signal: AbortSignal.timeout(12000)
			});
			if (!res.ok) continue;
			const data = await res.json();
			for (const it of data.items || []) {
				const key = slug(it.name);
				if (!key || seen.has(key)) continue;
				const lower = (it.name + " " + (it.description || "")).toLowerCase();
				const kind = /(dsh[- ]).*(ui|skin|theme|panel|sidebar|hud)/.test(lower) || /plugin.*(ui|skin|theme|panel)/.test(lower) ? "plugin" : "skill";
				const desc = (it.description || "").slice(0, 220);
				seen.set(key, {
					id: c.id + ":" + key,
					name: it.name,
					description: desc,
					tags: inferTags(desc + " " + it.name),
					tools: inferTools(desc + " " + it.name),
					taskTypes: inferTasks(desc + " " + it.name),
					source: c.id,
					url: it.html_url,
					installed: false,
					kind,
					stars: it.stargazers_count ?? 0
				});
			}
		} catch {
			/* skip a failing query */
		}
	}
	const arr = [...seen.values()];
	try {
		await mkdir(cacheDir(), { recursive: true });
		await writeFile(cacheFile, JSON.stringify(arr), "utf8");
	} catch {
		/* best-effort */
	}
	return arr;
}

// A small guaranteed seed of well-known open-source DSH skills (so the plugin
// always returns something even offline); enriched by local + remote catalogs.
const SEED = [
	{ name: "session-knowledge", description: "DSH Obsidian 项目知识库与会话收尾，维护项目档案/主题知识/会话记录/日报", tags: ["dsh-plugin", "docs"], tools: ["mnemon", "flomo", "ticktick"], taskTypes: ["docs"] },
	{ name: "skill-extraction-from-conversations", description: "从历史对话自动提取可复用技能并持久化到知识库", tags: ["dsh-plugin", "docs"], tools: ["skillmgr"], taskTypes: ["docs"] },
	{ name: "writing-skills", description: "创建/编辑/校验 skill 的规范流程（frontmatter、description 何时用）", tags: ["dsh-plugin", "dev"], tools: ["skillmgr", "write", "edit"], taskTypes: ["dev"], url: "https://github.com/obra/superpowers" },
	{ name: "subagent-driven-development", description: "用 subagent 并行/分步执行实现计划", tags: ["dev", "automation"], tools: ["subagent", "workflow"], taskTypes: ["dev"], url: "https://github.com/obra/superpowers" },
	{ name: "systematic-debugging", description: "遇到 bug 先系统化排障再提修复，避免盲改", tags: ["dev"], tools: ["bash", "grep", "read"], taskTypes: ["dev"], url: "https://github.com/obra/superpowers" },
	{ name: "test-driven-development", description: "先写测试再实现，质量门禁", tags: ["dev"], tools: ["bash", "npm"], taskTypes: ["dev"], url: "https://github.com/obra/superpowers" },
	{ name: "using-git-worktrees", description: "用 git worktree 隔离功能开发", tags: ["dev", "dev"], tools: ["git", "bash"], taskTypes: ["dev"], url: "https://github.com/obra/superpowers" }
];

export async function loadRegistry(cfg, { localSkills = [], forceRefresh = false, onProgress }: LoadRegistryOptions = {}) {
	const byKey = new Map();
	const add = (s) => {
		if (!s || !s.name) return;
		const k = slug(s.name);
		if (!k || byKey.has(k)) return;
		byKey.set(k, { ...s, kind: s.kind || "skill", id: s.id || "seed:" + k });
	};
	// seed
	for (const s of SEED) add({ ...s, id: "seed:" + slug(s.name), source: "seed", kind: "skill" });
	// local skills (installed)
	for (const s of localSkills) add(s);
	// remote catalogs (parallel, cached by TTL, progress-per-item)
	const eligible = cfg.catalogs.length ? REMOTE_CATALOGS.filter((c) => cfg.catalogs.includes(c.id)) : [];
	if (eligible.length) {
		let done = 0;
		onProgress?.({ pct: 40, message: `载入 skill 目录 0/${eligible.length}…` });
		await Promise.all(
			eligible.map(async (c) => {
				const list = await fetchCatalog(c, {
					force: forceRefresh,
					onProgress: (msg) => onProgress?.({ pct: 40 + Math.round((done / eligible.length) * 30), message: msg })
				});
				// Ensure every entry has a clickable source url (table-parsed rows
				// carry no link; fall back to the catalog's home repo).
				for (const s of list) add({ ...s, url: s.url || c.home || "" });
				done += 1;
				onProgress?.({ pct: 40 + Math.round((done / eligible.length) * 30), message: `载入 skill 目录 ${done}/${eligible.length}…` });
			})
		);
	}
	return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Scoring — the customizable 匹配指数 model
// ---------------------------------------------------------------------------

function overlapScore(profileVec, skillArr) {
	if (!skillArr.length) return 0;
	let weighted = 0;
	for (const k of skillArr) {
		weighted += profileVec[k] ?? 0;
	}
	// Presence bonus: even a partial keyword match signals direction, so a skill
	// hitting the user's strongest topic ranks clearly above one that misses it.
	// Cap so a single strong hit can't max out the dimension by itself.
	return Math.min(1, weighted + Math.min(skillArr.length, 3) * 0.15);
}

export function scoreSkill(profile, skill, weights) {
	const topicSim = overlapScore(profile.topics, skill.tags);
	const toolSim = overlapScore(profile.tools, skill.tools);
	const taskSim = overlapScore(profile.tasks, skill.taskTypes);
	// near: user already installed => deprioritize (already have it), else neutral
	const nearSim = skill.installed ? 0.15 : 0.75;

	const w = {
		topic: Math.max(0, weights?.topic ?? 50),
		tool: Math.max(0, weights?.tool ?? 50),
		task: Math.max(0, weights?.task ?? 35),
		near: Math.max(0, weights?.near ?? 40)
	};
	const wSum = w.topic + w.tool + w.task + w.near || 1;
	const raw = (w.topic * topicSim + w.tool * toolSim + w.task * taskSim + w.near * nearSim) / wSum;
	const score = Math.round(Math.max(0, Math.min(1, raw)) * 100);

	return {
		score,
		parts: {
			topic: +topicSim.toFixed(3),
			tool: +toolSim.toFixed(3),
			task: +taskSim.toFixed(3),
			near: +nearSim.toFixed(3)
		}
	};
}

/** Rank skills: keep score >= index (匹配指数), sort desc, cap to topN. */
export function recommend(profile, skills, cfg) {
	const weights = cfg.weights;
	const types = Array.isArray(cfg.types) && cfg.types.length ? cfg.types : ["skill"];
	const scored = skills
		.filter((s) => types.includes(s.kind === "plugin" ? "plugin" : "skill"))
		.map((s) => ({ skill: s, ...scoreSkill(profile, s, weights) }))
		.filter((x) => x.score >= cfg.index)
		.sort((a, b) => b.score - a.score)
		.slice(0, cfg.topN);
	return scored;
}

export function summarizeSessions(records) {
	const bySource = {};
	for (const r of records) bySource[r.source] = (bySource[r.source] || 0) + 1;
	return {
		total: records.length,
		bySource,
		userChars: records.reduce((a, r) => a + (r.userMsgs || []).join(" ").length, 0),
		assistantChars: records.reduce((a, r) => a + (r.assistantMsgs || []).join(" ").length, 0),
		tools: [...new Set(records.flatMap((r) => r.toolNames || []))]
	};
}

// Optional LLM pass to enrich the profile tags (turned on via config).
export async function llmEnrichProfile(cfg, profile, digests) {
	if (!(cfg.useLlm && cfg.llmBaseUrl && cfg.llmApiKey && cfg.llmModel)) return profile;
	try {
		const base = cfg.llmBaseUrl.replace(/\/+$/, "");
		const sample = digests
			.map((d) => `## ${d.source} @ ${new Date(d.ts).toISOString()} cwd=${d.cwd}\n用户: ${truncate((d.userMsgs || []).slice(-2).join(" "), 160)}\n助手: ${truncate((d.assistantMsgs || []).slice(-2).join(" "), 160)}`)
			.join("\n\n")
			.slice(0, 4000);
		const prompt =
			"从以下多来源工作会话看，这个用户是做什么的？输出 JSON：{\"topics\":[\"tag\"...],\"tasks\":[\"dev|docs|research|io|automation\"...]}\n只输出 JSON。\n\n" + sample;
		const res = await fetch(base + "/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${cfg.llmApiKey}` },
			body: JSON.stringify({
				model: cfg.llmModel,
				messages: [
					{ role: "system", content: "你从会话摘要提炼用户画像标签。只输出 JSON。" },
					{ role: "user", content: prompt }
				],
				temperature: 0.2,
				max_tokens: 600,
				response_format: { type: "json_object" }
			}),
			signal: AbortSignal.timeout(60000)
		});
		if (!res.ok) return profile;
		const data = await res.json();
		const text = data?.choices?.[0]?.message?.content;
		if (!text) return profile;
		const obj = JSON.parse(text);
		const tags = Array.isArray(obj.topics) ? obj.topics : [];
		const profile2 = { ...profile };
		for (const t of tags) {
			if (typeof t !== "string" || t.length > 40) continue;
			profile2.topics[t] = (profile2.topics[t] || 0) + 0.5;
			if (!profile2.topTopicTags.some((x) => x.k === t)) profile2.topTopicTags.push({ k: t, v: 0.5 });
		}
		return profile2;
	} catch {
		return profile;
	}
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function runScan(cfg, { now = Date.now(), forceRefresh = false } = {}) {
	if (!cfg.enabled) return { ok: false, message: "插件已禁用" };
	resetScanProgress();
	setScanProgress({ active: true, stage: "read", pct: 6, message: "扫描会话记录…" });
	const records = await scanSessions(cfg);
	setScanProgress({ active: true, stage: "profile", pct: 24, message: "构建用户画像…" });
	let profile = buildProfile(records);
	profile = await llmEnrichProfile(cfg, profile, records);
	setScanProgress({ active: true, stage: "catalog", pct: 40, message: "载入 skill 目录…" });
	const summary = summarizeSessions(records);
	const localSkills = await scanLocalSkills();
	const skills = await loadRegistry(cfg, {
		localSkills,
		forceRefresh,
		onProgress: (p) => setScanProgress({ active: true, stage: "catalog", ...(p || {}) })
	});
	setScanProgress({ active: true, stage: "score", pct: 92, message: "匹配打分…" });
	const recs = recommend(profile, skills, cfg);
	setScanProgress({ active: false, stage: "done", pct: 100, message: "完成" });
	return {
		ok: true,
		message: `扫描 ${records.length} 会话 → 推荐 ${recs.length} 个 skill（目录 ${skills.length}）`,
		records: records.length,
		summary,
		profile,
		skillsTotal: skills.length,
		recommendations: recs,
		site: {
			lastRunAt: new Date(now).toISOString(),
			lastRunSummary: `扫描 ${records.length} 会话 → 推荐 ${recs.length} 个 skill（目录 ${skills.length}）`
		}
	};
}
