/**
 * Skill 推荐器 settings panel — rendered inside the web settings page
 * (settings.section entry). Reads local DSH/Codex/Claude sessions, derives a
 * user profile, and recommends open-source skills with a weighted score gated
 * by the 匹配指数 (global threshold). The index + per-dimension weights are
 * tunable live. While scanning, the panel polls /progress and shows a real
 * progress bar. Plain React, no emoji, no external UI package — inline styles.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { RecommenderApi, type RecommenderView, type ScanResult } from './api.ts'

const api = new RecommenderApi()

const s = {
	card: {
		display: 'flex',
		flexDirection: 'column',
		gap: '10px',
		maxWidth: '680px',
		padding: '14px 16px',
		borderRadius: '10px',
		border: '1px solid rgba(128,128,128,0.3)',
		fontSize: '13px',
		color: 'inherit'
	} as const,
	title: { fontWeight: 600, fontSize: '13px', margin: 0 } as const,
	status: { fontSize: '12px', opacity: 0.85 } as const,
	hint: { fontSize: '12px', opacity: 0.85, lineHeight: '1.5', margin: 0 } as const,
	row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } as const,
	label: { fontSize: '12px', opacity: 0.85, whiteSpace: 'nowrap' } as const,
	btn: {
		padding: '5px 12px',
		borderRadius: '6px',
		border: '1px solid rgba(90,140,220,0.6)',
		background: 'rgba(90,140,220,0.12)',
		color: 'inherit',
		fontSize: '12px',
		cursor: 'pointer'
	} as const,
	btnSecondary: {
		padding: '5px 12px',
		borderRadius: '6px',
		border: '1px solid rgba(128,128,128,0.35)',
		background: 'rgba(128,128,128,0.06)',
		color: 'inherit',
		fontSize: '12px',
		cursor: 'pointer'
	} as const,
	btnDisabled: {
		padding: '5px 12px',
		borderRadius: '6px',
		border: '1px solid rgba(128,128,128,0.3)',
		background: 'rgba(128,128,128,0.05)',
		color: 'inherit',
		fontSize: '12px',
		cursor: 'not-allowed',
		opacity: 0.6
	} as const,
	sliderRow: { display: 'flex', gap: '8px', alignItems: 'center' } as const,
	slider: { flex: '1', accentColor: '#3E5C9A' } as const,
	sliderVal: {
		width: '34px',
		textAlign: 'right',
		fontSize: '12px',
		opacity: 0.9,
		fontVariantNumeric: 'tabular-nums'
	} as const,
	recCard: {
		display: 'flex',
		flexDirection: 'column',
		gap: '6px',
		padding: '8px 10px',
		borderRadius: '8px',
		border: '1px solid rgba(128,128,128,0.25)',
		background: 'rgba(128,128,128,0.05)'
	} as const,
	score: {
		padding: '1px 6px',
		borderRadius: '999px',
		border: '1px solid rgba(90,170,110,0.5)',
		fontSize: '11px',
		fontVariantNumeric: 'tabular-nums',
		whiteSpace: 'nowrap'
	} as const,
	name: { fontWeight: 600, fontSize: '13px' } as const,
	meta: { fontSize: '11px', opacity: 0.75 } as const,
	desc: { fontSize: '12px', opacity: 0.85, lineHeight: '1.45', margin: 0 } as const,
	link: { fontSize: '11px', color: '#4a7fd4', textDecoration: 'none' } as const,
	err: { fontSize: '12px', color: '#c9763a' } as const,
	parts: { fontSize: '11px', opacity: 0.7 } as const,
	sep: { fontSize: '11px', opacity: 0.5 } as const,
	barTrack: {
		height: '8px',
		borderRadius: '999px',
		background: 'rgba(128,128,128,0.15)',
		overflow: 'hidden',
		width: '100%'
	} as const,
	barFill: {
		height: '100%',
		borderRadius: '999px',
		background: 'linear-gradient(90deg,#3E5C9A,#5a8cdc)',
		transition: 'width 0.3s ease'
	} as const,
	stage: { fontSize: '12px', opacity: 0.85, margin: 0 } as const,
	success: { fontSize: '12px', color: '#4a8a5a', margin: 0 } as const
}

function fmt(v: number): string {
	return Math.round(v * 100).toString()
}

const SRC_LABEL: Record<string, string> = {
	'github-discovery': 'GitHub 全网',
	'awesome-dsh-skills': 'DSH 技能',
	'claude-skills': 'Claude 生态',
	'awesome-dsh-plugin': 'DSH 插件',
	'awesome-deepseek-harness': 'DSH 生态',
	seed: '内置',
	local: '本机'
}
function srcLabel(id: string): string {
	return SRC_LABEL[id] || id
}

export function RecommenderPanel() {
	const [view, setView] = useState<RecommenderView | null>(null)
	const [result, setResult] = useState<ScanResult | null>(null)
	const [busy, setBusy] = useState(false)
	const [err, setErr] = useState('')
	const [index, setIndex] = useState(60)
	const [weights, setWeights] = useState({ topic: 50, tool: 50, task: 35, near: 40 })
	const [progress, setProgress] = useState<{ active: boolean; stage: string; pct: number; message: string } | null>(null)
	const [elapsed, setElapsed] = useState(0)
	const [autoScan, setAutoScan] = useState(60)
	const [includePlugins, setIncludePlugins] = useState(false)
	const resultsRef = useRef<HTMLDivElement | null>(null)

	const loadStatus = useCallback(async () => {
		try {
			const v = await api.status()
			setView(v)
			setIndex(v.index)
			setWeights(v.weights || { topic: 50, tool: 50, task: 35, near: 40 })
			setAutoScan(v.autoScanMinutes)
			setIncludePlugins(Array.isArray(v.types) && v.types.includes('plugin'))
		} catch (e) {
			setErr(String(e instanceof Error ? e.message : e))
		}
	}, [])

	// Show the last cached (background-scan) result immediately so the panel is
	// never blank while waiting for a fresh scan.
	const loadCached = useCallback(async () => {
		try {
			const r = await api.results()
			if (r.ok && r.hasResult && r.result) {
				setResult(r.result)
				setProgress({ active: false, stage: 'done', pct: 100, message: '完成' })
			}
		} catch {
			/* results endpoint unavailable before host restart */
		}
	}, [])

	useEffect(() => {
		void loadStatus()
		void loadCached()
	}, [loadStatus, loadCached])

	const run = useCallback(async (opts?: { index?: number; weights?: Record<string, number>; forceRefresh?: boolean }) => {
		setBusy(true)
		setErr('')
		setResult(null)
		setProgress({ active: true, stage: 'start', pct: 0, message: '开始扫描…' })
		setElapsed(0)
		const t0 = Date.now()
		const elapsedTimer = window.setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500)
		const pollTimer = window.setInterval(async () => {
			try {
				const p = await api.progress()
				setProgress(p)
			} catch {
				/* progress endpoint unavailable before host restart; keep indeterminate */
			}
		}, 500)
		try {
			const res = opts && (opts.index !== undefined || opts.weights) ? await api.recommend(opts) : await api.scan(opts?.forceRefresh === true)
			setResult(res)
			setProgress({ active: false, stage: 'done', pct: 100, message: '完成' })
			window.setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80)
		} catch (e) {
			setErr(String(e instanceof Error ? e.message : e))
		} finally {
			window.clearInterval(elapsedTimer)
			window.clearInterval(pollTimer)
			setBusy(false)
		}
	}, [])

	const save = useCallback(async (patch: Record<string, unknown>) => {
		setBusy(true)
		setErr('')
		try {
			await api.save(patch)
			await loadStatus()
		} catch (e) {
			setErr(String(e instanceof Error ? e.message : e))
		} finally {
			setBusy(false)
		}
	}, [loadStatus])

	// Toggle "含插件": persist the type filter and re-run so recommendations update.
	const togglePlugins = useCallback(async (next: boolean) => {
		setIncludePlugins(next)
		const types = next ? ['skill', 'plugin'] : ['skill']
		await save({ types })
		await run({ index, weights })
	}, [save, run, index, weights])

	const weightKey = (k: keyof typeof weights) => weights[k]
	const setWeight = (k: keyof typeof weights, v: number) => setWeights((w) => ({ ...w, [k]: v }))

	return (
		<div style={s.card}>
			<p style={s.title}>Skill 推荐器</p>
			<p style={s.status}>
				{view
					? `来源 ${view.sources.join(' / ')} · 窗口 ${view.windowDays} 天 · 指数 ${view.index} · 自动扫描 ${view.autoScanMinutes > 0 ? `每 ${view.autoScanMinutes} 分钟` : '关闭'} · 上次 ${view.lastRunAt ? view.lastRunAt.slice(0, 16) : '未运行'}`
					: '加载中…'}
			</p>

			<div style={s.row}>
				<button style={busy ? s.btnDisabled : s.btn} disabled={busy} onClick={() => void run()}>
					{busy ? '扫描中…' : '扫描会话并推荐'}
				</button>
				<button style={busy ? s.btnDisabled : s.btnSecondary} disabled={busy} onClick={() => void run({ forceRefresh: true })}>
					{busy ? '扫描中…' : '刷新云端目录'}
				</button>
			</div>

			{busy && (
				<div style={{ display: 'flex', flexDirection: 'column', gap: '6px', paddingTop: '4px' }}>
					<div style={s.barTrack}>
						<div style={{ ...s.barFill, width: `${progress?.pct ?? 25}%` }} />
					</div>
					<p style={s.stage}>
						{progress?.message || '扫描中…'} · {elapsed}s
					</p>
				</div>
			)}
			{!busy && result && (
				<p style={s.success}>
					扫描完成：{result.records} 个会话 → {result.recommendations.length} 条推荐（目录 {result.skillsTotal} 项）
				</p>
			)}

			<div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
				<div style={s.sliderRow}>
					<label style={s.label} htmlFor="rc-index">匹配指数</label>
					<input
						id="rc-index"
						type="range"
						min={0}
						max={100}
						value={index}
						style={{ flex: '1', accentColor: '#3E5C9A' }}
						onChange={(e) => setIndex(Number(e.target.value))}
					/>
					<span style={s.sliderVal}>{index}</span>
					<button style={busy ? s.btnDisabled : s.btn} disabled={busy} onClick={() => void run({ index, weights })}>
						应用指数
					</button>
				</div>
				{(
					[
						['topic', '主题'],
						['tool', '工具'],
						['task', '任务'],
						['near', '邻近']
					] as Array<[keyof typeof weights, string]>
				).map(([k, label]) => (
					<div style={s.sliderRow} key={k}>
						<label style={s.label} htmlFor={`rc-${k}`}>{label}</label>
						<input
							id={`rc-${k}`}
							type="range"
							min={0}
							max={100}
							value={weightKey(k)}
							style={s.slider}
							onChange={(e) => setWeight(k, Number(e.target.value))}
						/>
						<span style={s.sliderVal}>{weightKey(k)}</span>
					</div>
				))}
				<div style={s.sliderRow}>
					<label style={s.label} htmlFor="rc-autoscan">自动扫描</label>
					<input
						id="rc-autoscan"
						type="number"
						min={0}
						max={1440}
						value={autoScan}
						style={{ width: '64px', padding: '4px 6px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.35)', background: 'rgba(128,128,128,0.08)', color: 'inherit', fontSize: '12px' }}
						onChange={(e) => setAutoScan(Math.max(0, Number(e.target.value) || 0))}
					/>
					<span style={s.meta}>分钟/次（0=关闭）</span>
				</div>
				<div style={s.sliderRow}>
					<label style={s.label} htmlFor="rc-plugins">含插件</label>
					<input
						id="rc-plugins"
						type="checkbox"
						checked={includePlugins}
						style={{ accentColor: '#3E5C9A' }}
						onChange={(e) => void togglePlugins(e.target.checked)}
					/>
					<span style={s.meta}>默认只推荐 skill，勾选后也推荐 DSH 插件</span>
				</div>
				<button style={busy ? s.btnDisabled : s.btn} disabled={busy} onClick={() => void save({ index, weights, autoScanMinutes: autoScan, types: includePlugins ? ['skill', 'plugin'] : ['skill'] })}>
					保存指数/权重/自动扫描
				</button>
			</div>

			<div ref={resultsRef} style={{ display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '8px', borderTop: '1px solid rgba(128,128,128,0.2)' }}>
				{result && (
					<>
						<div style={s.row}>
							<p style={s.title}>画像</p>
							<span style={s.meta}>{result.records} 个会话 · 目录 {result.skillsTotal} 项</span>
						</div>
						{result.profile && result.profile.topTopicTags && result.profile.topTopicTags.length > 0 && (
							<p style={s.hint}>
								主题：{result.profile.topTopicTags.map((t) => `${t.k}(${fmt(t.v)}%)`).join(' · ')}
							</p>
						)}
						{result.profile && result.profile.topToolNames && result.profile.topToolNames.length > 0 && (
							<p style={s.hint}>高频工具：{result.profile.topToolNames.map((t) => t.k).join(', ')}</p>
						)}

						<p style={s.title}>推荐结果（匹配指数 {view?.index ?? index}）</p>
						{result.recommendations.length === 0 ? (
							<p style={s.hint}>无匹配 skill，可调低匹配指数或点「刷新云端目录」再试。</p>
						) : (
							result.recommendations.map((r) => (
								<div style={s.recCard} key={r.skill.id}>
									<div style={s.row}>
										<span style={s.score}>{r.score}</span>
										<span style={s.name}>{r.skill.name}</span>
										<span style={s.meta}>{r.skill.kind === 'plugin' ? '插件' : '技能'}</span>
										{r.skill.url ? (
											<a style={s.link} href={r.skill.url} target="_blank" rel="noreferrer" title="打开原目录">
												{srcLabel(r.skill.source)} ↗
											</a>
										) : (
											<span style={s.meta}>{srcLabel(r.skill.source)}</span>
										)}
									</div>
									<p style={s.desc}>{r.skill.description}</p>
									<span style={s.parts}>
										主题 {fmt(r.parts.topic)} · 工具 {fmt(r.parts.tool)} · 任务 {fmt(r.parts.task)} · 邻近 {fmt(r.parts.near)}
									</span>
								</div>
							))
						)}
					</>
				)}
				{!result && !busy && (
					<p style={s.hint}>扫描后，画像与推荐结果会显示在这里。</p>
				)}
			</div>

			{err && <p style={s.err}>错误：{err}</p>}
		</div>
	)
}
