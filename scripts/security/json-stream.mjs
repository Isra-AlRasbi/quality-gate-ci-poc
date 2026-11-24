/**
 * Decoder for a stream of concatenated JSON values.
 *
 * WHY THIS EXISTS
 * `govulncheck -format=json` does *not* emit newline-delimited JSON. It writes
 * pretty-printed objects back to back, so splitting on newlines yields hundreds
 * of unparseable fragments. Measured in this POC: 435 messages across 46,535
 * lines. Anything that parses this output has to scan for value boundaries.
 *
 * This is a deliberately small brace/string-aware scanner rather than a general
 * JSON parser: it only needs to find top-level values.
 */

/**
 * Returns every top-level JSON value found in `text`, in order.
 * Trailing whitespace is tolerated. Non-whitespace garbage between values throws.
 */
export function decodeJsonStream(text) {
  const values = []
  let index = 0
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  while (index < text.length) {
    const char = text[index]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      index += 1
      continue
    }

    if (char === '"') {
      inString = true
      index += 1
      continue
    }

    if (char === '{' || char === '[') {
      if (depth === 0) {
        start = index
      }
      depth += 1
      index += 1
      continue
    }

    if (char === '}' || char === ']') {
      if (depth === 0) {
        throw new SyntaxError(`unbalanced closing '${char}' at offset ${index}`)
      }
      depth -= 1
      if (depth === 0) {
        values.push(JSON.parse(text.slice(start, index + 1)))
        start = -1
      }
      index += 1
      continue
    }

    if (depth === 0 && !/\s/.test(char)) {
      throw new SyntaxError(
        `unexpected character '${char}' at offset ${index}; expected whitespace between JSON values`,
      )
    }

    index += 1
  }

  if (depth !== 0) {
    throw new SyntaxError(`truncated JSON: ${depth} unclosed container(s) at end of input`)
  }

  return values
}
