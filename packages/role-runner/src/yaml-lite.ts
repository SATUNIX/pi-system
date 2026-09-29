/**
 * Minimal, dependency-free YAML reader for agent-role contracts.
 *
 * Only the YAML subset used by `roles/<role>/agent-role.yaml` is supported:
 * block mappings, block sequences of scalars, nested mappings, indentless
 * sequences under a key, single/double quoted scalars, plain scalars (with
 * folded continuation lines), comments, booleans, null and numbers.
 *
 * It deliberately fails closed: anything it cannot classify raises, so the
 * runner exits 20 rather than silently using a partially parsed contract.
 *
 * Why not the `yaml` package? The role-runner image must stay dependency-free
 * and offline-testable (no registry at build time in this environment). The
 * contract grammar is small and fixed, and `parseYaml` is covered against all
 * seven shipped contracts. Replace with `yaml` when the workspace lockfile is
 * regenerated (see packages/role-runner/README.md).
 */

interface Line {
  indent: number;
  text: string;
  line: number;
}

const KEY_RE = /^([A-Za-z_][A-Za-z0-9_.-]*):(?:[ \t]+(.*))?$/;

function stripComment(raw: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "#" && (i === 0 || raw[i - 1] === " " || raw[i - 1] === "\t")) {
      break;
    }
    out += ch;
  }
  return out;
}

function tokenize(input: string): Line[] {
  const lines: Line[] = [];
  const raw = input.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < raw.length; i += 1) {
    const cleaned = stripComment(raw[i]);
    const trimmed = cleaned.trim();
    if (trimmed === "" || trimmed === "---" || trimmed === "...") continue;
    const indent = cleaned.length - cleaned.trimStart().length;
    if (cleaned.slice(0, indent).includes("\t")) {
      throw new Error(`tab indentation is not supported (line ${i + 1})`);
    }
    lines.push({ indent, text: trimmed, line: i + 1 });
  }
  return lines;
}

function isSequence(line: Line): boolean {
  return line.text === "-" || line.text.startsWith("- ");
}

function matchKey(text: string): { key: string; rest: string } | null {
  const match = KEY_RE.exec(text);
  if (!match) return null;
  return { key: match[1], rest: match[2] ?? "" };
}

function parseScalar(raw: string): unknown {
  const text = raw.trim();
  if (text === "" || text === "~" || text === "null" || text === "Null" || text === "NULL") return null;
  if (text === "true" || text === "True" || text === "TRUE") return true;
  if (text === "false" || text === "False" || text === "FALSE") return false;
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) throw new Error(`unterminated single-quoted scalar: ${text}`);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) throw new Error(`unterminated double-quoted scalar: ${text}`);
    return JSON.parse(text);
  }
  if (/^[+-]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(text)) {
    return Number(text);
  }
  if (text === "*") return "*";
  if (text.startsWith("&") || text.startsWith("|") || text.startsWith(">")) {
    throw new Error(`unsupported YAML scalar form: ${text}`);
  }
  return text;
}

function parseNode(lines: Line[], index: number): [unknown, number] {
  const line = lines[index];
  if (isSequence(line)) return parseSequence(lines, index);
  return parseMapping(lines, index);
}

function parseMapping(lines: Line[], start: number): [Record<string, unknown>, number] {
  const indent = lines[start].indent;
  const result: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent !== indent || isSequence(line)) break;
    const entry = matchKey(line.text);
    if (!entry) throw new Error(`expected a mapping key at line ${line.line}: ${line.text}`);
    i += 1;
    if (entry.rest !== "") {
      let value: unknown = parseScalar(entry.rest);
      // A plain scalar may fold onto more-indented continuation lines. Stop at
      // the next key or sequence item.
      while (
        i < lines.length &&
        lines[i].indent > indent &&
        !isSequence(lines[i]) &&
        !matchKey(lines[i].text)
      ) {
        value = `${String(value)} ${lines[i].text}`;
        i += 1;
      }
      result[entry.key] = value;
      continue;
    }
    const next = lines[i];
    if (next && (next.indent > indent || (next.indent === indent && isSequence(next)))) {
      const [value, consumed] = parseNode(lines, i);
      result[entry.key] = value;
      i = consumed;
    } else {
      result[entry.key] = null;
    }
  }
  return [result, i];
}

function parseSequence(lines: Line[], start: number): [unknown[], number] {
  const indent = lines[start].indent;
  const result: unknown[] = [];
  let i = start;
  while (i < lines.length && lines[i].indent === indent && isSequence(lines[i])) {
    const line = lines[i];
    const item = line.text === "-" ? "" : line.text.slice(2).trim();
    i += 1;
    if (item === "") {
      if (i < lines.length && lines[i].indent > indent) {
        const [value, consumed] = parseNode(lines, i);
        result.push(value);
        i = consumed;
      } else {
        result.push(null);
      }
      continue;
    }
    if (matchKey(item)) {
      throw new Error(`inline mapping sequence items are not supported (line ${line.line})`);
    }
    result.push(parseScalar(item));
  }
  return [result, i];
}

export function parseYaml(input: string): unknown {
  const lines = tokenize(input);
  if (lines.length === 0) return null;
  const [value, consumed] = parseNode(lines, 0);
  if (consumed !== lines.length) {
    throw new Error(`unexpected content at line ${lines[consumed].line}`);
  }
  return value;
}
