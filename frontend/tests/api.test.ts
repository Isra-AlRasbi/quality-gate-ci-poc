import { describe, expect, it, vi } from 'vitest'

import { fetchGateReport, GateReportError } from '../src/api'
import type { GateReport } from '../src/api'

const SAMPLE: GateReport = {
  overall: 'success',
  service: 'quality-gate-backend',
  commit: 'abc1234',
  version: '0.1.0',
  checkedAt: '2026-11-24T09:30:00Z',
  checks: [
    { id: 'backend-test', name: 'Unit tests', component: 'backend', status: 'success', durationSeconds: 14 },
  ],
}

/**
 * Builds a stub `fetch` rather than mocking the global.
 *
 * Explicit injection keeps tests independent and order-insensitive, which is a
 * large part of why this suite is stable across machines.
 */
function stubFetch(response: { ok: boolean; status?: number; body?: unknown }): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: async () => response.body,
  })) as unknown as ReturnType<typeof vi.fn>
}

describe('fetchGateReport', () => {
  it('returns the parsed report for a successful response', async () => {
    const fetchImpl = stubFetch({ ok: true, status: 200, body: SAMPLE })

    const report = await fetchGateReport('/api/checks', { fetchImpl })

    expect(report.overall).toBe('success')
    expect(report.checks).toHaveLength(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('requests JSON and passes an abort signal', async () => {
    const fetchImpl = stubFetch({ ok: true, status: 200, body: SAMPLE })

    await fetchGateReport('/api/checks', { fetchImpl })

    const [path, init] = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(path).toBe('/api/checks')
    expect(init.headers).toMatchObject({ accept: 'application/json' })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('defaults the path to /api/checks', async () => {
    const fetchImpl = stubFetch({ ok: true, status: 200, body: SAMPLE })

    await fetchGateReport(undefined, { fetchImpl })

    const [path] = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [string]
    expect(path).toBe('/api/checks')
  })

  it('surfaces the HTTP status when the endpoint fails', async () => {
    const fetchImpl = stubFetch({ ok: false, status: 503 })

    await expect(fetchGateReport('/api/checks', { fetchImpl })).rejects.toThrow(
      /HTTP 503/,
    )
  })

  it('throws GateReportError rather than a bare Error on HTTP failure', async () => {
    const fetchImpl = stubFetch({ ok: false, status: 500 })

    await expect(fetchGateReport('/api/checks', { fetchImpl })).rejects.toBeInstanceOf(
      GateReportError,
    )
  })

  it('normalises a network error into GateReportError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch

    await expect(fetchGateReport('/api/checks', { fetchImpl })).rejects.toThrow(
      /request failed/,
    )
  })

  it('fails clearly when fetch is unavailable in the environment', async () => {
    // Pass no implementation at all so the client has to use globalThis.fetch.
    vi.stubGlobal('fetch', undefined)

    try {
      await expect(fetchGateReport('/api/checks')).rejects.toThrow(/fetch is not available/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
