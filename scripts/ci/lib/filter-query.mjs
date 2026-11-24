#!/usr/bin/env node
/**
 * Queries the local model of the workflow's path filters.
 *
 * Deliberately batched on stdin: verify-path-filters.sh runs this once per Dockerfile rather
 * than once per COPY line, so the cost is one node start instead of dozens.
 *
 * Usage: filter-query.mjs <filter-name> [<filter-name> ...] < paths
 * Output: one line per input path -> "<path>\t<comma-separated matching filters>|-"
 * Exits 2 if a pattern uses syntax the matcher refuses rather than guessing at it.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { matchesAny } from './glob-match.mjs'
import { parseFilterConfig } from './load-filters.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')

const wanted = process.argv.slice(2)
if (wanted.length === 0) {
  console.error('usage: filter-query.mjs <filter-name>... < paths')
  process.exit(2)
}

let filters
try {
  const file = join(REPO, '.github/ci/paths-filter.yaml')
  filters = parseFilterConfig(readFileSync(file, 'utf8'), file)
} catch (e) {
  console.error(e.message)
  process.exit(2)
}

const unknown = wanted.filter((w) => !(w in filters))
if (unknown.length) {
  console.error(`no such filter(s): ${unknown.join(', ')} (have: ${Object.keys(filters).join(', ')})`)
  process.exit(2)
}

const input = readFileSync(0, 'utf8').split('\n').filter(Boolean)
if (input.length === 0) {
  // An empty query is not a clean result. Either the caller found no files, which is worth
  // knowing, or the extraction upstream broke -- and the upstream extractor is a Dockerfile
  // regex, which is exactly the kind of thing that breaks quietly by returning nothing.
  console.error('no paths on stdin: nothing checked is not everything checked')
  process.exit(2)
}

try {
  for (const path of input) {
    const hits = wanted.filter((name) => matchesAny(path, filters[name]))
    process.stdout.write(`${path}\t${hits.length ? hits.join(',') : '-'}\n`)
  }
} catch (e) {
  console.error(e.message)
  process.exit(2)
}
