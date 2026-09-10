/**
 * Browser-side API client for the /api/dsh-skill-recommender route family.
 * Plain fetch, same origin. The only data path the settings panel uses.
 */

export interface RecommenderView {
	enabled: boolean
	sources: string[]
	catalogs: string[]
	types: string[]
	windowDays: number
	index: number
	topN: number
	weights: { topic: number; tool: number; task: number; near: number }
	autoScanMinutes: number
	useLlm: boolean
	lastRunAt: string
	lastRunSummary: string
	catalogMeta: Array<{ id: string; label: string; kind: string }>
	configPath: string
	configured: boolean
}

export interface Recommendation {
	score: number
	parts: { topic: number; tool: number; task: number; near: number }
	skill: {
		id: string
		name: string
		description: string
		source: string
		url?: string
		installed: boolean
		kind: string
	}
}

export interface ScanResult {
	ok: boolean
	message: string
	records: number
	profile: {
		records: number
		topTopicTags: Array<{ k: string; v: number }>
		topToolNames: Array<{ k: string; v: number }>
		topTaskTypes: Array<{ k: string; v: number }>
		topProjects: Array<{ k: string; v: number }>
		models: Array<{ k: string; v: number }>
	}
	skillsTotal: number
	recommendations: Recommendation[]
	catalogMeta: Array<{ id: string; label: string }>
}

export class RecommenderApiError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'RecommenderApiError'
	}
}

async function readJson<T>(response: Response): Promise<T> {
	let body: unknown
	try {
		body = await response.json()
	} catch {
		throw new RecommenderApiError(`HTTP ${response.status}: invalid JSON response`)
	}
	if (!response.ok) {
		const message =
			typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
				? (body as { error: string }).error
				: `HTTP ${response.status}`
		throw new RecommenderApiError(message)
	}
	return body as T
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	let response: Response
	try {
		response = await fetch(path, init)
	} catch (error) {
		throw new RecommenderApiError(`网络请求失败: ${String(error instanceof Error ? error.message : error)}`)
	}
	return readJson<T>(response)
}

export class RecommenderApi {
	async status(): Promise<RecommenderView> {
		return request<RecommenderView>('/api/dsh-skill-recommender/status')
	}
	async progress(): Promise<{ active: boolean; stage: string; pct: number; message: string }> {
		return request('/api/dsh-skill-recommender/progress')
	}
	async results(): Promise<{ ok: boolean; hasResult: boolean; result: ScanResult | null }> {
		return request<{ ok: boolean; hasResult: boolean; result: ScanResult | null }>('/api/dsh-skill-recommender/results')
	}
	async scan(forceRefresh = false): Promise<ScanResult> {
		return request<ScanResult>('/api/dsh-skill-recommender/scan', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ forceRefresh })
		})
	}
	async recommend(patch: { index?: number; topN?: number; weights?: Record<string, number>; forceRefresh?: boolean }): Promise<ScanResult> {
		return request<ScanResult>('/api/dsh-skill-recommender/recommend', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(patch)
		})
	}
	async save(patch: Record<string, unknown>): Promise<{ ok: boolean; message: string; config: RecommenderView }> {
		return request<{ ok: boolean; message: string; config: RecommenderView }>('/api/dsh-skill-recommender/config', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(patch)
		})
	}
}
