// Минимальный YAML-подмножество для frontmatter, которое сами же и пишем:
// строки (голые/в кавычках) и плоские inline-массивы `[a, b]`. Не общий
// YAML-парсер — vault всегда читается/пишется только этим сервером
// (см. ТЗ §11, Promts/08_obsidian_lint.md «Запреты»), поэтому формат
// контролируем целиком мы и можем позволить себе узкий парсер.

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseScalar(raw) {
  const v = raw.trim();
  if (v === "") return "";
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  return v;
}

function parseArray(raw) {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
  if (inner === "") return [];
  return inner
    .split(",")
    .map((s) => parseScalar(s.trim()))
    .filter((s) => s !== "");
}

export function parseFrontmatter(content) {
  const match = FM_RE.exec(content ?? "");
  if (!match) return { frontmatter: {}, body: content ?? "" };
  const [, fmBlock, body] = match;
  const frontmatter = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const rawValue = line.slice(idx + 1).trim();
    frontmatter[key] = rawValue.startsWith("[") ? parseArray(rawValue) : parseScalar(rawValue);
  }
  return { frontmatter, body };
}

function needsQuotes(s) {
  return /[:#\[\]{}"]/.test(s) || s.trim() !== s;
}

function stringifyScalar(v) {
  const s = String(v);
  return needsQuotes(s) ? JSON.stringify(s) : s;
}

function stringifyValue(v) {
  if (Array.isArray(v)) return `[${v.map(stringifyScalar).join(", ")}]`;
  return stringifyScalar(v);
}

export function stringifyFrontmatter(frontmatter, body = "") {
  const lines = Object.entries(frontmatter)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${stringifyValue(v)}`);
  const bodyPart = body.startsWith("\n") ? body : `\n${body}`;
  return `---\n${lines.join("\n")}\n---\n${bodyPart}`;
}
