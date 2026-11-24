/**
 * Pure presentation logic for the quality-gate dashboard.
 *
 * Kept free of DOM and network access on purpose: it is unit tested in a plain
 * Node environment, which keeps the test run fast and deterministic
 * (no jsdom, no timers, no clock, no randomness).
 */

export type CheckStatus = 'success' | 'failure' | 'skipped' | 'pending'

export type Component = 'frontend' | 'backend' | 'shared'

export interface QualityCheck {
  id: string
  name: string
  component: Component
  status: CheckStatus
  /** Wall-clock seconds reported by CI. `0` for skipped checks. */
  durationSeconds: number
}

/** Severity ranking used to roll individual checks up into one gate result. */
const STATUS_SEVERITY: Record<CheckStatus, number> = {
  success: 0,
  skipped: 0,
  pending: 2,
  failure: 3,
}

/**
 * Rolls individual checks up into the single result a merge gate needs.
 *
 * Rules (documented because they will become the org-wide contract):
 *  - any failure      -> failure
 *  - anything pending -> pending (never report success too early)
 *  - otherwise        -> success, including the "everything skipped" case,
 *                        because a skipped check ran nothing and broke nothing.
 */
export function overallStatus(checks: readonly QualityCheck[]): CheckStatus {
  if (checks.length === 0) {
    return 'pending'
  }

  let worst: CheckStatus = 'success'
  for (const check of checks) {
    if (STATUS_SEVERITY[check.status] > STATUS_SEVERITY[worst]) {
      worst = check.status
    }
  }
  return worst
}

/** Skipped checks contribute no time; they are a feature, not a saving to show off. */
export function totalDurationSeconds(checks: readonly QualityCheck[]): number {
  return checks
    .filter((check) => check.status !== 'skipped')
    .reduce((total, check) => total + check.durationSeconds, 0)
}

/** `90 -> "1m 30s"` — readable in a CI summary table without a calculator. */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return '0s'
  }

  const seconds = Math.round(totalSeconds)
  if (seconds < 60) {
    return `${seconds}s`
  }

  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  if (minutes < 60) {
    return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`
  }

  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/** Grouping used by the dashboard, with a stable component order. */
export function groupByComponent(
  checks: readonly QualityCheck[],
): Array<{ component: Component; checks: QualityCheck[] }> {
  const order: Component[] = ['frontend', 'backend', 'shared']
  return order
    .map((component) => ({
      component,
      checks: checks.filter((check) => check.component === component),
    }))
    .filter((group) => group.checks.length > 0)
}

export function checksByStatus(
  checks: readonly QualityCheck[],
  status: CheckStatus,
): QualityCheck[] {
  return checks.filter((check) => check.status === status)
}
