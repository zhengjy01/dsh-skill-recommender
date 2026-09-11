/**
 * dsh-skill-recommender — 会话画像 → 开源 skill 推荐器. Host half.
 *
 * Reads local session records (DSH / Codex / Claude), builds a compact user
 * profile, ingests an open-source skill catalog, and ranks skills with a
 * weighted model + a global threshold ("匹配指数"): higher index => only
 * higher-relevance skills are returned. Exposes recommender_* tools for the
 * agent and a Web settings panel (recommend cards, index slider, per-dimension
 * weights, catalog toggles) via the /api/dsh-skill-recommender/* route family.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
	RecommenderStore,
	runScan,
	buildProfile,
	defaultConfig,
	scanSessions,
	recommend,
	getScanProgress,
	setCachedResult
} from './recommend.ts'
import { makeRoutes, RC_API, isLoopbackRequest } from './routes.ts'

/** Stable cordis plugin name. */
export const name = 'skill-recommender'

/** Services required before the surfaces can mount. */
export const inject = ['tools', 'systemPrompt', 'webServer', 'timer']

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 160

/** Model-facing announcement: plugin presence and capabilities. */
export const RECOMMENDER_GUIDANCE =
	'本机已安装 dsh-skill-recommender 插件（会话画像→开源 skill 推荐器）：可浏览本地 Codex/Claude/DSH 三种会话记录，' +
	'用加权打分 + 全局「匹配指数」（阈值越高→只返回关联度越高）推荐适合你的开源 skill。' +
	'工具：recommender_scan（扫描会话并建画像+初步推荐）、recommender_recommend（推荐，可临时调 index/topN/weights）、' +
	'recommender_profile（查看当前画像）、recommender_config（配置指数/权重/目录源/窗口/LLM）、recommender_status（状态）。' +
	'也可在 Web 设置页「Skill 推荐器」面板可视化扫描、调指数滑条与每维度权重、查看并跳转推荐 skill。' +
	'用户提到「推荐 skill / 匹配指数 / 会话画像 / 开源 skill」时即指本插件，请据此协作。'

/** Plugin config from the composition row. */
export interface Config {
	announceToAgent?: boolean
	enabled?: boolean
}

function renderRecommendList(recommendations: unknown): string {
	const list = (recommendations as Array<{ score: number; skill: { name: string; source: string; description: string }; parts: Record<string, number> }>) ?? []
	if (!list.length) return '（无匹配 skill，可在 Web 面板调低匹配指数）'
	return list
		.map((r) => {
			const s = r.skill
			const parts = r.parts
			const detail = [
				`主题 ${Math.round(parts.topic * 100)}`,
				`工具 ${Math.round(parts.tool * 100)}`,
				`任务 ${Math.round(parts.task * 100)}`,
				`邻近 ${Math.round(parts.near * 100)}`
			].join(' / ')
			return `- [${r.score}] ${s.name} (${s.source}) — ${detail} — ${(s.description || '').slice(0, 80)}`
		})
		.join('\n')
}

// DSH 0.1.5+: output.render must return ContentBlock[] (an array), not a single
// block — a bare object fails result finalization with "content is not iterable".
const text = (value: string): Array<{ type: 'text'; text: string }> => [{ type: 'text', text: value }]

/** Mount the recommender tools, routes, and announcement. */
export function apply(ctx: Context, config?: Config): void {
	const announceToAgent = config?.announceToAgent !== false
	const enabled = config?.enabled !== false
	const store = new RecommenderStore()

	// Run a scan, persist its lastRunAt, and cache the result so the panel can
	// show it instantly (refreshed in the background by the auto-scan timer).
	const runAndCache = async (cfg, opts?: { forceRefresh?: boolean }) => {
		const result = await runScan(cfg, opts)
		if (result.site) await store.patch(result.site)
		await setCachedResult(result)
		return result
	}

	let disposeTools: (() => void) | undefined
	let disposeRoutes: (() => void) | undefined
	let disposeSection: (() => void) | undefined
	let disposeTimer: (() => void) | undefined
	let scanBusy = false

	const tools = [
		defineTool({
			name: 'recommender_status',
			description: '查看 skill 推荐器插件状态：是否启用、会话来源(DSH/Codex/Claude)、扫描窗口(天)、匹配指数阈值、每维度权重、是否用 LLM 富化、上次运行结果。不会泄露密钥。',
			parameters: {},
			output: {
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: {
						ok: { type: 'boolean', required: true },
						message: { type: 'string', required: true }
					}
				},
				render: (_args, value) => text(String(value.message ?? ''))
			},
			async execute() {
				const view = await store.view()
				const srcs = (view.sources as string[]).join('/')
				return {
					ok: true,
					message:
						( view.enabled ? '已启用' : '已禁用' ) + ' · 来源 ' + srcs + ' · 窗口 ' + view.windowDays +
						' 天 · 匹配指数 ' + view.index + ' · 权重 ' + JSON.stringify(view.weights) +
						' · 目录源 ' + (view.catalogs as string[]).join(',') +
						' · LLM ' + (view.useLlm ? '已开启' : '关闭') +
						' · 上次 ' + (view.lastRunAt || '未运行') + ' —— ' + (view.lastRunSummary || '')
				}
			}
		}),
		defineTool({
			name: 'recommender_config',
			description: '配置 skill 推荐器：sources(会话来源 dsh/codex/claude)、catalogs(目录源，见 catalogMeta)、windowDays(扫描窗口天)、index(匹配指数 0-100 全局阈值，越高越精越少)、topN、weights(主题/工具/任务/邻近 各 0-100)、useLlm/llmBaseUrl/llmApiKey/llmModel(LLM 富化画像)、reset=true 恢复默认。',
			parameters: {
				sources: { type: 'array', items: { type: 'string' }, description: '会话来源：dsh/codex/claude' },
				catalogs: { type: 'array', items: { type: 'string' }, description: '目录源 id 列表' },
				windowDays: { type: 'number', description: '扫描窗口（天）' },
				index: { type: 'number', description: '匹配指数（0-100 全局阈值）' },
				topN: { type: 'number', description: '最多返回推荐数' },
				weights: {
					type: 'object',
					description: '{topic,tool,task,near} 各 0-100',
					properties: {
						topic: { type: 'number', description: '主题权重（0-100）' },
						tool: { type: 'number', description: '工具权重（0-100）' },
						task: { type: 'number', description: '任务权重（0-100）' },
						near: { type: 'number', description: '邻近权重（0-100）' }
					},
					additionalProperties: false
				},
				useLlm: { type: 'boolean', description: '是否用 LLM 富化画像' },
				llmBaseUrl: { type: 'string', description: 'LLM Base URL（OpenAI 兼容）' },
				llmApiKey: { type: 'string', description: 'LLM API Key' },
				llmModel: { type: 'string', description: 'LLM 模型名' },
				reset: { type: 'boolean', description: '恢复默认配置' }
			},
			output: {
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: {
						ok: { type: 'boolean', required: true },
						message: { type: 'string', required: true }
					}
				},
				render: (_args, value) => text(String(value.message ?? ''))
			},
			async execute(args) {
				// Read the reset intent from the request: `patch()` folds it into the
				// stored config, so the returned view never carries the flag itself.
				const wantReset = (args as { reset?: boolean } | undefined)?.reset === true
				const view = await store.patch((args as object) ?? {})
				return {
					ok: true,
					message: '配置已保存：指数 ' + view.index + ' · 权重 ' + JSON.stringify(view.weights) + ' · 来源 ' + (view.sources as string[]).join('/') +
						' · 目录 ' + (view.catalogs as string[]).join(',') + ' · 窗口 ' + view.windowDays + ' 天' +
						(wantReset ? '（已重置默认）' : '')
				}
			}
		}),
		defineTool({
			name: 'recommender_scan',
			description: '扫描本地 DSH/Codex/Claude 会话并构建用户画像，同时按当前指数/权重做一次初步推荐。返回会话统计、画像、推荐列表。',
			parameters: {},
			output: {
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: {
						ok: { type: 'boolean', required: true },
						message: { type: 'string', required: true },
						records: { type: 'number' },
						profile: { type: 'object', additionalProperties: true },
						recommendations: { type: 'array', items: { type: 'object', additionalProperties: true } }
					}
				},
				render: (_args, value) => {
					const p = value.profile as { topTopicTags?: Array<{ k: string; v: number }>; topToolNames?: Array<{ k: string; v: number }> } | undefined
					const topics = (p?.topTopicTags ?? []).map((t) => `${t.k}(${Math.round(t.v * 100)}%)`).join(', ')
					const tools = (p?.topToolNames ?? []).slice(0, 8).map((t) => t.k).join(', ')
					const rec = renderRecommendList(value.recommendations)
					return text(
						`[ok] 扫描 ${value.records} 个会话\n画像主题：${topics || '无'}\n高频工具：${tools || '无'}\n\n推荐（当前指数）：\n${rec}`
					)
				}
			},
			async execute() {
				const cfg = await store.load()
				const result = await runAndCache(cfg)
				return {
					ok: result.ok,
					message: result.message,
					records: result.records,
					profile: result.profile,
					recommendations: result.recommendations
				}
			}
		}),
		defineTool({
			name: 'recommender_recommend',
			description: '推荐开源 skill：先扫描重建画像，再按匹配指数打分排序。可临时覆盖 index(0-100，越高越精越少)、topN、weights(主题/工具/任务/邻近 权重)。返回带分数的推荐列表。',
			parameters: {
				index: { type: 'number', description: '匹配指数（0-100 全局阈值，覆盖配置）' },
				topN: { type: 'number', description: '最多返回数（覆盖配置）' },
				weights: {
					type: 'object',
					description: '每维度权重覆盖 {topic,tool,task,near}',
					properties: {
						topic: { type: 'number', description: '主题权重（0-100）' },
						tool: { type: 'number', description: '工具权重（0-100）' },
						task: { type: 'number', description: '任务权重（0-100）' },
						near: { type: 'number', description: '邻近权重（0-100）' }
					},
					additionalProperties: false
				}
			},
			output: {
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: {
						ok: { type: 'boolean', required: true },
						message: { type: 'string', required: true },
						index: { type: 'number' },
						profile: { type: 'object', additionalProperties: true },
						recommendations: { type: 'array', items: { type: 'object', additionalProperties: true } }
					}
				},
				render: (_args, value) => {
					const rec = renderRecommendList(value.recommendations)
					return text(`[ok] 匹配指数 ${value.index} → ${(value.recommendations as unknown[]).length} 个推荐\n\n${rec}`)
				}
			},
			async execute(args) {
				const cfg = await store.load()
				if (args && args.index !== undefined) cfg.index = Number(args.index)
				if (args && args.topN !== undefined) cfg.topN = Number(args.topN)
				if (args && args.weights && typeof args.weights === 'object') cfg.weights = { ...cfg.weights, ...(args.weights as object) }
				const result = await runAndCache(cfg)
				return {
					ok: result.ok,
					message: result.message,
					index: cfg.index,
					profile: result.profile,
					recommendations: result.recommendations
				}
			}
		}),
		defineTool({
			name: 'recommender_profile',
			description: '查看当前会话画像：主题分布、高频工具、任务类型、常用项目目录、语言/模型来源（不含会话正文）。',
			parameters: {},
			output: {
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: {
						ok: { type: 'boolean', required: true },
						message: { type: 'string', required: true },
						profile: { type: 'object', additionalProperties: true }
					}
				},
				render: (_args, value) => {
					const p = value.profile as { topTopicTags?: Array<{ k: string; v: number }>; topToolNames?: Array<{ k: string; v: number }>; topTaskTypes?: Array<{ k: string; v: number }>; topProjects?: Array<{ k: string; v: number }>; models?: Array<{ k: string; v: number }> } | undefined
					const line = (arr: Array<{ k: string; v: number }> | undefined) => (arr ?? []).map((t) => `${t.k}(${Math.round(t.v * 100)}%)`).join(', ')
					return text(
						`[ok] 画像（${value.profile ? Object.keys(value.profile).length : 0} 字段）\n主题：${line(p?.topTopicTags) || '无'}\n工具：${line(p?.topToolNames) || '无'}\n任务：${line(p?.topTaskTypes) || '无'}\n项目：${line(p?.topProjects) || '无'}\n模型：${line(p?.models) || '无'}`
					)
				}
			},
			async execute() {
				const cfg = await store.load()
				const records = await scanSessions(cfg)
				const profile = buildProfile(records)
				return { ok: true, message: `画像：${records.length} 个会话`, profile }
			}
		})
	]

	const sync = (): void => {
		if (disposeTools !== undefined) { disposeTools(); disposeTools = undefined }
		if (disposeRoutes !== undefined) { disposeRoutes(); disposeRoutes = undefined }
		if (disposeSection !== undefined) { disposeSection(); disposeSection = undefined }
		if (disposeTimer !== undefined) { disposeTimer(); disposeTimer = undefined }
		if (!enabled) return
		disposeTools = ctx.effect(
			() => {
				const disposers = tools.map((tool) => ctx.tools.register(tool))
				return () => { for (const dispose of disposers) dispose() }
			},
			'dsh-skill-recommender: tools'
		)
		disposeRoutes = ctx.effect(
			() => {
				const disposers = makeRoutes({ store }).map((route) => ctx.webServer.register(route))
				return () => { for (const dispose of disposers) dispose() }
			},
			'dsh-skill-recommender: routes'
		)
		if (announceToAgent) {
			disposeSection = ctx.systemPrompt.section({
				name: 'plugin:dsh-skill-recommender',
				order: SECTION_ORDER,
				text: RECOMMENDER_GUIDANCE
			})
		}
		// Background auto-scan: every minute, if autoScanMinutes>0 and it has
		// been that long, quietly refresh the cached result so the panel is warm.
		disposeTimer = ctx.interval(
			() => {
				(async () => {
					if (scanBusy) return
					scanBusy = true
					try {
						const cfg = await store.load()
						if (!cfg.enabled) return
						const minutes = cfg.autoScanMinutes
						if (!(minutes > 0)) return
						const now = Date.now()
						const last = cfg.lastRunAt !== '' ? new Date(cfg.lastRunAt).getTime() : 0
						if (last !== 0 && now - last < minutes * 60 * 1000) return
						const result = await runAndCache(cfg)
						ctx.logger?.info?.('[dsh-skill-recommender] autoscan: ' + result.message)
					} catch (error) {
						ctx.logger?.warn?.('[dsh-skill-recommender] autoscan failed: ' + String(error instanceof Error ? error.message : error))
					} finally {
						scanBusy = false
					}
				})()
			},
			60 * 1000
		)
	}

	sync()
}

export { RC_API, isLoopbackRequest, defaultConfig, recommend }
export {
	runScan,
	scanSessions,
	buildProfile,
	loadRegistry,
	scoreSkill,
	getScanProgress,
	getCachedResult,
	setCachedResult,
	defaultConfig as rcDefaults
} from './recommend.ts'
