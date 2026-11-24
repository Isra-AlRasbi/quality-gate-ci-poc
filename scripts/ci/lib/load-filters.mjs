/**
 * The one parser for .github/ci/paths-filter.yaml.
 *
 * Shared by filter-query.mjs and audit-filter-coverage.mjs deliberately. Two parsers of the
 * same config drift, and the interesting failure is a silent one: if one learns to read a
 * pattern shape and the other skips it, the two disagree about whether a file is covered, and
 * whichever one CI happens to run decides the answer.
 *
 * Not a YAML dependency on purpose: this runs in CI's self-check job before any `npm install`,
 * and the config is a flat map of keys to quoted strings. It rejects shapes it does not
 * understand rather than skipping them, because a silently-dropped pattern is a wrong answer,
 * not a missing one.
 */
import { readFileSync } from 'node:fs'

export function parseFilterConfig(text, source = 'paths-filter.yaml') {
  const filters = {}
  let current = null
  for (const [i, raw] of text.split('\n').entries()) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    const key = raw.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/)
    if (key) {
      current = key[1]
      // An inline value means flow style (`foo: ['a']`), which this does not read. Fail
      // loudly: treating it as an empty list would make every file unmatched by that filter.
      if (key[2] && key[2].trim()) {
        throw new Error(`${source}:${i + 1}: unexpected inline value for '${current}'; only block-style quoted lists are parsed`)
      }
      filters[current] = []
      continue
    }
    const item = raw.match(/^\s+-\s+'([^']+)'\s*$/)
    if (item) {
      if (!current) throw new Error(`${source}:${i + 1}: pattern outside of any filter`)
      filters[current].push(item[1])
      continue
    }
    if (current && /^\s+-/.test(raw)) {
      throw new Error(`${source}:${i + 1}: pattern is not a single-quoted scalar; refusing to guess: ${raw.trim()}`)
    }
  }
  return filters
}

/** Every pattern in the config, negations stripped, in file order and de-duplicated. */
export function allPatterns(filters) {
  return [...new Set(Object.values(filters).flat().map((p) => (p.startsWith('!') ? p.slice(1) : p)))]
}
