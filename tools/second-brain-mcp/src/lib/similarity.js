/** Классический Levenshtein — без внешних зависимостей, короткие строки (имена). */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const row = new Array(n + 1);
  for (let j = 0; j <= n; j++) row[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = Math.min(
        row[j] + 1, // удаление
        row[j - 1] + 1, // вставка
        prev + (a[i - 1] === b[j - 1] ? 0 : 1) // замена
      );
      prev = tmp;
    }
  }
  return row[n];
}

/** 0..1, 1 = идентичные строки (без учёта регистра). */
export function stringSimilarity(a, b) {
  const s1 = String(a ?? "").trim().toLowerCase();
  const s2 = String(b ?? "").trim().toLowerCase();
  if (!s1 && !s2) return 1;
  if (!s1 || !s2) return 0;
  const dist = levenshtein(s1, s2);
  return 1 - dist / Math.max(s1.length, s2.length);
}

export function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}
