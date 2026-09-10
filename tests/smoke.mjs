/**
 * dsh-skill-recommender — smoke test.
 *
 * Loads the BUILT lib/index.js and exercises the exported engine functions:
 *   - config defaults
 *   - recommend() returns [] on empty inputs
 *   - a live scan (DSH/Codex/Claude sessions) builds a profile and produces
 *     recommendations, and a higher 匹配指数 threshold yields fewer results.
 *
 * Run: node tests/smoke.mjs
 */
import assert from 'node:assert/strict'
import { runScan, defaultConfig, recommend, buildProfile, scanSessions } from '../lib/index.js'

let failed = 0
const ok = (name) => console.log('  ✓', name)
const bad = (name, e) => {
	failed++
	console.error('  ✗', name, '—', e.message)
}

try {
	const c = defaultConfig()
	assert.deepEqual(c.sources, ['dsh', 'codex', 'claude'])
	assert.equal(c.index, 60)
	assert.equal(typeof c.weights.topic, 'number')
	ok('defaultConfig')
} catch (e) {
	bad('defaultConfig', e)
}

try {
	assert.deepEqual(recommend({ topics: {}, tools: {}, tasks: {} }, [], { ...defaultConfig(), index: 60 }), [])
	ok('recommend([])')
} catch (e) {
	bad('recommend([])', e)
}

const cfg = { ...defaultConfig(), windowDays: 120, maxSessionsPerSource: 15 }
let profile
let recs
let highCount
try {
	const records = await scanSessions(cfg)
	assert.ok(records.length >= 1, 'at least one session')
	profile = buildProfile(records)
	assert.ok(profile.topTopicTags && profile.topToolNames)
	ok(`scanSessions+buildProfile (${records.length} records)`)
} catch (e) {
	bad('scanSessions+buildProfile', e)
}

try {
	const result = await runScan(cfg)
	assert.equal(result.ok, true)
	recs = result.recommendations
	ok(`runScan -> ${recs.length} recommendations`)
} catch (e) {
	bad('runScan', e)
}

try {
	const high = await runScan({ ...cfg, index: 90, topN: 20 })
	highCount = high.recommendations.length
	assert.ok(highCount <= recs.length, 'high index <= low index')
	ok(`higher index filtered to ${highCount}`)
} catch (e) {
	bad('higher index', e)
}

if (failed) {
	console.error(`\n${failed} check(s) failed`)
	process.exit(1)
}
console.log('\nall checks passed')
