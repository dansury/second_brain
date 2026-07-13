//Slug-утилиты для имён файлов Obsidian-хранилища (ТЗ §7, §7.1: [[Имя_Фамилия_(роль)]]).
// Оставляем юникод (кириллицу) — Obsidian и файловые системы amvera с ней работают,
// а транслитерация только затруднила бы поиск/чтение базы человеком.

const UNSAFE_CHARS = /["*/:<>?\\|]/g;

/**
 * Пробелы → «_», убираем символы, недопустимые в именах файлов.
 * Не трогаем «(» «)» — они часть конвенции именования персон.
 */
export function slugify(input) {
  return String(input)
    .trim()
    .replace(UNSAFE_CHARS, "")
    .replace(/\s+/g, "_");
}

/** Имя файла персонажа по конвенции ТЗ §3: Имя_Фамилия_(роль).md */
export function personFileName(name, role) {
  const namePart = slugify(name) || "Неизвестный";
  const rolePart = slugify(role || "не_уточнено");
  return `${namePart}_(${rolePart}).md`;
}

/** Разобрать имя файла персонажа обратно на {name, role}. */
export function parsePersonFileName(fileName) {
  const base = fileName.replace(/\.md$/, "");
  const m = base.match(/^(.*)_\(([^)]*)\)$/);
  if (!m) return { name: base, role: null };
  return { name: m[1].replace(/_/g, " "), role: m[2].replace(/_/g, " ") };
}

/** ISO-дата (YYYY-MM-DD) + slug заголовка — имя файла дневниковой/др. заметки. */
export function dateTitleFileName(isoDate, title) {
  const datePart = isoDate ? isoDate.slice(0, 10) : "0000-00-00";
  const titlePart = slugify(title || "без_названия").slice(0, 80);
  return `${datePart} ${titlePart}.md`;
}
