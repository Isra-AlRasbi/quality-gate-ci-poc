#!/usr/bin/env node
/**
 * Dependency-free model for the simple globs in paths-filter.yaml.
 * The pinned action uses picomatch with dot:true; the workflow selects
 * some-with-excludes. This is a local sanity check, not an action runner.
 */

/** Escape a literal character for use inside a RegExp. */
function esc(ch) {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? "\\" + ch : ch
}

/**
 * Translate one path segment of a pattern into a regex source string.
 * Returns null when the segment uses syntax this matcher deliberately does not implement.
 */
function segmentToSource(seg) {
  let out = ""
  let i = 0
  while (i < seg.length) {
    const c = seg[i]
    if (c === "*") {
      // `**` inside a single segment (`a**b`) is not the globstar; treat the
      // run as `*`, without crossing a path separator.
      while (seg[i] === "*") i++
      out += "[^/]*"
    } else if (c === "?") {
      out += "[^/]"
      i++
    } else if (c === "{") {
      const close = seg.indexOf("}", i)
      if (close === -1) return null
      const alts = seg.slice(i + 1, close).split(",")
      out +=
        "(?:" +
        alts
          .map((a) => a.split("").map((ch) => (ch === "*" ? "[^/]*" : ch === "?" ? "[^/]" : esc(ch))).join(""))
          .join("|") +
        ")"
      i = close + 1
    } else if (c === "[" || c === "]" || c === "!") {
      // Character classes and extglobs: explicitly unsupported rather than silently wrong.
      return null
    } else {
      out += esc(c)
      i++
    }
  }
  return out
}

/**
 * Compile a glob pattern to a RegExp.
 * Returns null for patterns using unsupported syntax — callers must treat null as
 * "cannot evaluate", never as "no match", so an unsupported pattern cannot quietly
 * narrow a filter the way the bash version quietly widened one.
 */
export function compile(pattern) {
  if (typeof pattern !== "string" || pattern === "") return null
  const segs = pattern.split("/")
  // The pinned action includes dotfiles at every depth.
  const SEG = "[^/]+"
  let source = "^"
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s]
    if (seg === "**") {
      const last = s === segs.length - 1
      // Trailing `a/**` needs at least one segment (`a` alone does not match); an interior
      // `a/**/b` may match zero segments, so `a/b` matches.
      source += last ? `${SEG}(?:/${SEG})*` : `(?:${SEG}/)*`
      continue
    }
    const src = segmentToSource(seg)
    if (src === null) return null
    source += src
    if (s < segs.length - 1) source += "/"
  }
  return new RegExp(source + "$")
}

/**
 * Does `path` match `pattern`?
 * Throws on unsupported syntax. Callers that would rather report than crash should call
 * compile() and check for null.
 */
export function matches(path, pattern) {
  const re = compile(pattern)
  if (re === null) {
    throw new Error(`unsupported glob syntax in pattern: ${pattern}`)
  }
  return re.test(path)
}

/**
 * Match any positive pattern, unless an exclusion matches.
 */
export function matchesAny(path, patterns) {
  let hit = false
  for (const p of patterns) {
    const neg = p.startsWith("!")
    const glob = neg ? p.slice(1) : p
    const re = compile(glob)
    if (re === null) throw new Error(`unsupported glob syntax in pattern: ${glob}`)
    if (re.test(path)) {
      if (neg) return false
      hit = true
    }
  }
  return hit
}
