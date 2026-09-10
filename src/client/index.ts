/**
 * dsh-skill-recommender — browser half. Registers the "Skill 推荐器" settings
 * panel into the web settings page (settings.section entry). The panel scans
 * local sessions, shows the derived profile, lets the user tune the 匹配指数
 * (global threshold) and per-dimension weights, and lists recommended skills
 * with scores + repo links. Failure policy: registration problems are logged,
 * never thrown — an external plugin must not take the GUI down.
 */
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { RecommenderPanel } from './RecommenderPanel.tsx'

/** Required services. */
export const inject = ['slots']

export function apply(ctx: ClientContext): void {
	try {
		ctx.slots.inject('settings.section', () =>
			ctx.slots.register(
				{
					name: 'settings.section',
					id: 'skill-recommender',
					order: 322,
					label: () => 'Skill 推荐器'
				},
				RecommenderPanel
			)
		)
	} catch (error) {
		console.warn('[dsh-skill-recommender] settings panel registration failed:', error)
	}
}
