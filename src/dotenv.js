const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/s;

function closingQuote(text, quote) {
  for (let i = 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === quote) return i;
  }
  return -1;
}

/** Parses dotenv text into its entries and any repeated keys. */
export function parseDotenv(text) {
  const lines = text.split(/\r?\n/);
  const entries = new Map();
  const duplicates = [];

  for (let i = 0; i < lines.length; i++) {
    const startLine = i + 1;
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    const match = ASSIGNMENT.exec(line);
    if (!match) continue;

    const name = match[1];
    let value = match[2];
    const quote = /^["'`]/.test(value) ? value[0] : null;

    if (quote) {
      let candidate = value;
      let end = closingQuote(candidate, quote);
      let cursor = i;
      while (end === -1 && cursor + 1 < lines.length) {
        cursor++;
        candidate += '\n' + lines[cursor];
        end = closingQuote(candidate, quote);
      }
      // An unterminated quote stays on its own line so it can't swallow later keys.
      if (end !== -1) {
        value = candidate.slice(1, end);
        i = cursor;
      }
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }

    if (entries.has(name)) duplicates.push({ name, line: startLine });
    entries.set(name, { value, line: startLine });
  }

  return { entries, duplicates };
}
