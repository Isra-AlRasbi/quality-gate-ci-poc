import { fetchGateReport } from './api'
import { directionFor, statusMessage } from './lib/i18n'
import {
  checksByStatus,
  formatDuration,
  groupByComponent,
  overallStatus,
  totalDurationSeconds,
  type CheckStatus,
  type QualityCheck,
} from './lib/status'

const DEFAULT_CHECKS: QualityCheck[] = [
  { id: 'frontend-lint', name: 'Lint', component: 'frontend', status: 'success', durationSeconds: 11 },
  { id: 'frontend-typecheck', name: 'Type check', component: 'frontend', status: 'success', durationSeconds: 7 },
  { id: 'frontend-test', name: 'Unit tests', component: 'frontend', status: 'success', durationSeconds: 16 },
  { id: 'frontend-build', name: 'Build', component: 'frontend', status: 'pending', durationSeconds: 0 },
  { id: 'backend-test', name: 'Unit tests', component: 'backend', status: 'skipped', durationSeconds: 0 },
  { id: 'security', name: 'Dependency audit', component: 'shared', status: 'success', durationSeconds: 9 },
]

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

function renderChecks(checks: QualityCheck[]): void {
  const list = byId<HTMLUListElement>('check-list')
  if (!list) {
    return
  }

  list.replaceChildren()

  for (const group of groupByComponent(checks)) {
    const heading = document.createElement('li')
    heading.className = 'group'
    heading.textContent = group.component

    const nested = document.createElement('ul')
    for (const check of group.checks) {
      const item = document.createElement('li')
      item.className = `check check--${check.status}`
      item.textContent = `${iconFor(check.status)} ${check.name} — ${check.status} (${formatDuration(check.durationSeconds)})`
      nested.appendChild(item)
    }

    heading.appendChild(nested)
    list.appendChild(heading)
  }
}

function iconFor(status: CheckStatus): string {
  switch (status) {
    case 'success':
      return '[ok]'
    case 'failure':
      return '[x]'
    case 'skipped':
      return '[-]'
    case 'pending':
      return '[..]'
  }
}

function renderSummary(checks: QualityCheck[]): void {
  const overall = overallStatus(checks)
  const banner = byId<HTMLElement>('overall')
  if (banner) {
    const failures = checksByStatus(checks, 'failure').length
    const suffix = failures > 0 ? ` (${failures} failing)` : ''
    banner.textContent = `${statusMessage(overall, 'en')}${suffix}`
    banner.dataset.status = overall
  }

  const totals = byId<HTMLElement>('totals')
  if (totals) {
    const ran = checks.filter((check) => check.status !== 'skipped').length
    totals.textContent = `${ran} check(s) ran · ${formatDuration(totalDurationSeconds(checks))} of CI time`
  }

  const summary = byId<HTMLElement>('status-summary')
  summary?.setAttribute('dir', directionFor('en'))
}

function renderBuildInfo(): void {
  const target = byId<HTMLElement>('build-info')
  if (!target) {
    return
  }
  const commit = import.meta.env.VITE_GIT_SHA ?? 'local'
  const version = import.meta.env.VITE_APP_VERSION ?? '0.0.0-local'
  target.textContent = `build ${version} · commit ${commit}`
}

export function boot(): void {
  renderBuildInfo()
  renderChecks(DEFAULT_CHECKS)
  renderSummary(DEFAULT_CHECKS)

  // The backend call is opportunistic: the dashboard must still render when the
  // API is not running, which is the normal state during frontend-only CI.
  void fetchGateReport()
    .then((report) => {
      renderChecks(report.checks)
      renderSummary(report.checks)
    })
    .catch(() => undefined)
}

boot()
