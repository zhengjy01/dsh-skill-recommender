/**
 * dsh-skill-recommender — loopback HTTP routes for the web settings panel.
 *
 * Route family: /api/dsh-skill-recommender/*. All routes are loopback-only
 * (127.0.0.1/localhost, same-origin) — the settings panel is the sole consumer.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { RecommenderStore } from './recommend.ts'
import { runScan, recommend, buildProfile, scanSessions, getScanProgress, setCachedResult, getCachedResult } from './recommend.ts'

/** Route paths. */
export const RC_API = {
	status: '/api/dsh-skill-recommender/status',
	scan: '/api/dsh-skill-recommender/scan',
	progress: '/api/dsh-skill-recommender/progress',
	results: '/api/dsh-skill-recommender/results',
	recommend: '/api/dsh-skill-recommender/recommend',
	config: '/api/dsh-skill-recommender/config',
	profile: '/api/dsh-skill-recommender/profile'
} as const

/** Cap on JSON request bodies. */
const MAX_JSON_BODY_BYTES = 64 * 1024

/** Strict loopback fence for all routes. */
export function isLoopbackRequest(request: IncomingMessage): boolean {
	const address = request.socket.remoteAddress
	if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
	const host = request.headers.host
	if (typeof host !== 'string') return false
	let hostUrl: URL
	try {
		hostUrl = new URL(`http://${host}`)
	} catch {
		return false
	}
	if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
	if (request.headers['sec-fetch-site'] === 'cross-site') return false
	const origin = request.headers.origin
	if (origin === undefined) return true
	try {
		return new URL(origin).host === hostUrl.host
	} catch {
		return false
	}
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body)
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
	res.end(payload)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
	const chunks: Buffer[] = []
	let size = 0
	for await (const chunk of req) {
		const buffer = chunk as Buffer
		size += buffer.length
		if (size > MAX_JSON_BODY_BYTES) return undefined
		chunks.push(buffer)
	}
	try {
		const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
		return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
	} catch {
		return undefined
	}
}

function handle(fn: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
	return async (req: IncomingMessage, res: ServerResponse) => {
		try {
			await fn(req, res)
		} catch (error) {
			writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
		}
	}
}

export interface RouteContext {
	store: RecommenderStore
}

/** Build every /api/dsh-skill-recommender route (exact paths). */
export function makeRoutes(deps: RouteContext): WebRoute[] {
	const { store } = deps

	const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
		if (!isLoopbackRequest(req)) {
			writeJson(res, 403, { error: 'forbidden: loopback-only' })
			return false
		}
		if (req.method !== method) {
			writeJson(res, 405, { error: `method not allowed: ${req.method}` })
			return false
		}
		return true
	}

	return [
		{
			kind: 'exact',
			path: RC_API.status,
			handler: handle(async (req, res) => {
				if (!guard(req, res, 'GET')) return
				const view = await store.view()
				writeJson(res, 200, { ok: true, ...view })
			})
		},
		{
			kind: 'exact',
			path: RC_API.progress,
			handler: handle(async (req, res) => {
				if (!guard(req, res, 'GET')) return
				writeJson(res, 200, { ok: true, ...getScanProgress() })
			})
		},
		{
			kind: 'exact',
			path: RC_API.results,
			handler: handle(async (req, res) => {
				if (!guard(req, res, 'GET')) return
				const result = await getCachedResult()
				writeJson(res, 200, { ok: true, hasResult: Boolean(result), result })
			})
		},
		{
			kind: 'exact',
			path: RC_API.scan,
			handler: handle(async (req, res) => {
				if (!guard(req, res, 'POST')) return
				const cfg = await store.load()
				const body = await readJsonBody(req)
				const forceRefresh = typeof body === 'object' && body !== null && body.forceRefresh === true
				const result = await runScan(cfg, { forceRefresh })
				if (result.site) await store.patch(result.site)
				await setCachedResult(result)
				writeJson(res, 200, {
					ok: result.ok,
					message: result.message,
					records: result.records,
					summary: result.summary,
					profile: result.profile,
					skillsTotal: result.skillsTotal,
					recommendations: result.recommendations,
					catalogMeta: RC_API_META
				})
			})
		},
		{
			kind: 'exact',
			path: RC_API.recommend,
			handler: handle(async (req, res) => {
				if (!guard(req, res, 'POST')) return
				const cfg = await store.load()
				const body = await readJsonBody(req)
				const overrides = typeof body === 'object' && body !== null ? body : {}
				if (overrides.index !== undefined) cfg.index = Number(overrides.index)
				if (overrides.topN !== undefined) cfg.topN = Number(overrides.topN)
				if (overrides.weights && typeof overrides.weights === 'object') cfg.weights = { ...cfg.weights, ...(overrides.weights as object) }
				const forceRefresh = overrides.forceRefresh === true
				// Re-run the scan so recommend reflects the latest sessions/config.
				const result = await runScan(cfg, { forceRefresh })
				if (result.site) await store.patch(result.site)
				await setCachedResult(result)
				writeJson(res, 200, {
					ok: result.ok,
					message: result.message,
					index: cfg.index,
					topN: cfg.topN,
					weights: cfg.weights,
					records: result.records,
					profile: result.profile,
					skillsTotal: result.skillsTotal,
					recommendations: result.recommendations,
					catalogMeta: RC_API_META
				})
			})
		},
		{
			kind: 'exact',
			path: RC_API.profile,
			handler: handle(async (req, res) => {
				if (!guard(req, res, 'GET')) return
				const cfg = await store.load()
				const records = await scanSessions(cfg)
				const profile = buildProfile(records)
				writeJson(res, 200, { ok: true, records: records.length, profile })
			})
		},
		{
			kind: 'exact',
			path: RC_API.config,
			handler: handle(async (req, res) => {
				if (!guard(req, res, 'POST')) return
				const body = await readJsonBody(req)
				if (body === undefined) writeJson(res, 400, { error: 'invalid JSON body' })
				const view = await store.patch((body || {}) as object)
				writeJson(res, 200, { ok: true, message: '配置已保存', config: view })
			})
		}
	]
}

const RC_API_META = [
	{ id: 'awesome-dsh-skills', label: 'awesome-dsh-skills (DSH 技能)' },
	{ id: 'awesome-dsh-plugin', label: 'awesome-dsh-plugin (DSH 插件)' },
	{ id: 'awesome-deepseek-harness', label: 'awesome-deepseek-harness (DSH 生态)' },
	{ id: 'claude-skills', label: 'Claude skills 生态' }
]
