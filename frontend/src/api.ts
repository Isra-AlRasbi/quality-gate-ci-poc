import type { QualityCheck } from './lib/status'

export interface GateReport {
  overall: string
  service: string
  commit: string
  version: string
  checkedAt: string
  checks: QualityCheck[]
}

export interface FetchReportOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export class GateReportError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'GateReportError'
  }
}

/**
 * Thin, injectable API client.
 *
 * `fetchImpl` is a parameter rather than a module-level mock so tests stay
 * explicit and no global state is shared between them.
 */
export async function fetchGateReport(
  path = '/api/checks',
  options: FetchReportOptions = {},
): Promise<GateReport> {
  const doFetch = options.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw new GateReportError('fetch is not available in this environment')
  }

  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? 5_000
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await doFetch(path, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!response.ok) {
      throw new GateReportError(`Quality gate report request failed (HTTP ${response.status})`, response.status)
    }
    return (await response.json()) as GateReport
  } catch (error) {
    if (error instanceof GateReportError) {
      throw error
    }
    throw new GateReportError('Quality gate report request failed')
  } finally {
    clearTimeout(timer)
  }
}
