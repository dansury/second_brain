// Минимальный парсер/сериализатор YAML-frontmatter — не общего назначения,
// а ровно под то подмножество, которое пишет и читает secondbrain (см. ТЗ §7.1).
// Специально без зависимости от внешних YAML-библиотек (нулевые deps, см. README).

const FENCE = "---";

function parseScalar(raw) {
  const v = raw.trim();
  if (v === "") return "";
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

function parseInlineArray(raw) {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (inner.trim() === "") return [];
  return inner.split(",").map((s) => parseScalar(s));
}

/**
 * Разобрать markdown-файл с frontmatter.
 * @returns {{frontmatter: object, body: string}}
 */
export function parseFrontmatter(content) {
  if (!content.startsWith(FENCE)) {
    return { frontmatter: {}, body: content };
  }
  const lines = content.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FENCE) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { frontmatter: {}, body: content };
  }
  const yamlLines = lines.slice(1, end);
  const body = lines.slice(end + 1).join("\n").replace(/^\n+/, "");

  const fm = {};
  let currentKey = null;
  for (const line of yamlLines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const blockItem = line.match(/^\s*-\s+(.*)$/);
    if (blockItem && currentKey) {
      if (!Array.isArray(fm[currentKey])) fm[currentKey] = [];
      fm[currentKey].push(parseScalar(blockItem[1]));
      continue;
    }
    const kv = line.match(/^(\S[^:]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const rawValue = kv[2];
    currentKey = key;
    if (rawValue.trim() === "") {
      fm[key] = []; // возможен последующий block-style список
    } else if (rawValue.trim().startsWith("[")) {
      fm[key] = parseInlineArray(rawValue);
    } else {
      fm[key] = parseScalar(rawValue);
    }
  }
  return { frontmatter: fm, body };
}

function stringifyValue(v) {
  if (Array.isArray(v)) {
    return `[${v.map((x) => JSON.stringify(String(x))).join(", ")}]`;
  }
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (v === null || v === undefined) return "null";
  const s = String(v);
  // Кавычим, если есть символы, ломающие YAML-скаляр без кавычек.
  if (/[:#\[\]{}]/.test(s) || /^\s|\s$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

/**
 * Собрать markdown-файл из frontmatter-объекта и тела.
 */
export function stringifyFrontmatter(frontmatter, body) {
  const keys = Object.keys(frontmatter);
  const yaml = keys
    .map((k) => `${k}: ${stringifyValue(frontmatter[k])}`)
    .join("\n");
  const trimmedBody = body.replace(/^\n+/, "").replace(/\s+$/, "\n");
  return `${FENCE}\n${yaml}\n${FENCE}\n\n${trimmedBody}`;
}
