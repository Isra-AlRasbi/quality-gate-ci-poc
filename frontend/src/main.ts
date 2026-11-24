import { fetchGateReport } from './api'
import { directionFor, statusMessage } from './lib/i18n'
import './style.css'
import {
  checksByStatus,
  formatDuration,
  groupByComponent,
  overallStatus,
  totalDurationSeconds,
  type CheckStatus,
  type Component,
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

const COMPONENT_LABELS: Record<Component, string> = {
  frontend: 'Frontend',
  backend: 'Backend',
  shared: 'Shared',
}

const STATUS_LABELS: Record<CheckStatus, string> = {
  success: 'Passed',
  failure: 'Failed',
  skipped: 'Skipped',
  pending: 'Pending',
}

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
    const card = document.createElement('li')
    card.className = 'group'
    const heading = document.createElement('h3')
    heading.textContent = COMPONENT_LABELS[group.component]
    card.append(heading)

    const nested = document.createElement('ul')
    nested.className = 'check-rows'
    for (const check of group.checks) {
      const item = document.createElement('li')
      item.className = 'check'
      const name = document.createElement('span')
      name.className = 'check-name'
      name.textContent = check.name
      const badge = document.createElement('span')
      badge.className = 'badge'
      badge.dataset.status = check.status
      badge.textContent = STATUS_LABELS[check.status]
      const duration = document.createElement('span')
      duration.className = 'duration'
      duration.textContent = check.status === 'skipped' || check.status === 'pending'
        ? '—'
        : formatDuration(check.durationSeconds)
      item.append(name, badge, duration)
      nested.appendChild(item)
    }

    card.append(nested)
    list.append(card)
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

  const passed = byId<HTMLElement>('passed')
  if (passed) passed.textContent = `${checksByStatus(checks, 'success').length} / ${checks.length}`
  const totals = byId<HTMLElement>('totals')
  if (totals) totals.textContent = formatDuration(totalDurationSeconds(checks))

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
    .catch(() => {
      const source = byId<HTMLElement>('report-source')
      if (source) source.textContent = 'The API is unavailable. Showing built-in demo data.'
    })
}

boot()
