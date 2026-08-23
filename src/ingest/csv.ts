/**
 * A strict CSV reader.
 *
 * Written rather than installed, for one reason that is worth stating: a bank export is
 * untrusted input and the failure this system exists to prevent is a plausible wrong
 * number. A parser that silently coerces, silently truncates, or silently accepts a row
 * with the wrong column count reintroduces exactly that failure at the boundary. This one
 * throws instead.
 *
 * It handles quoted fields, embedded commas, doubled quotes and both line endings. It
 * does not handle anything clever, because a bank export is not clever.
 */

export class CsvError extends Error {
  override readonly name = "CsvError";
  readonly file: string;
  readonly line: number;

  constructor(file: string, line: number, message: string) {
    super(`${file}:${line}: ${message}`);
    this.file = file;
    this.line = line;
  }
}

/** One parsed record, plus where it came from, so every error can name a line. */
export interface CsvRow {
  readonly line: number;
  readonly cells: readonly string[];
  get(column: string): string;
}

export interface CsvFile {
  readonly file: string;
  readonly header: readonly string[];
  readonly rows: readonly CsvRow[];
}

function splitLine(file: string, lineNumber: number, line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i] as string;
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      if (current !== "") {
        throw new CsvError(file, lineNumber, "quote opens in the middle of an unquoted field");
      }
      inQuotes = true;
    } else if (char === ",") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (inQuotes) throw new CsvError(file, lineNumber, "unterminated quoted field");
  cells.push(current);
  return cells;
}

export function parseCsv(file: string, content: string): CsvFile {
  const lines = content.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) throw new CsvError(file, 0, "file is empty");

  const header = splitLine(file, 1, lines[0] as string).map((h) => h.trim());
  const index = new Map<string, number>();
  header.forEach((name, i) => {
    if (index.has(name)) throw new CsvError(file, 1, `duplicate column ${JSON.stringify(name)}`);
    index.set(name, i);
  });

  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const lineNumber = i + 1;
    const cells = splitLine(file, lineNumber, lines[i] as string);
    if (cells.length !== header.length) {
      // never pad and never truncate. A row with the wrong shape is a row we cannot read,
      // and reading it anyway is how a wrong number gets manufactured
      throw new CsvError(
        file,
        lineNumber,
        `expected ${header.length} columns, found ${cells.length}`,
      );
    }
    rows.push({
      line: lineNumber,
      cells,
      get(column: string): string {
        const at = index.get(column);
        if (at === undefined) {
          throw new CsvError(file, lineNumber, `no column named ${JSON.stringify(column)}`);
        }
        return (cells[at] as string).trim();
      },
    });
  }

  return { file, header, rows };
}

export function requireColumns(csv: CsvFile, expected: readonly string[]): void {
  const missing = expected.filter((name) => !csv.header.includes(name));
  if (missing.length > 0) {
    throw new CsvError(csv.file, 1, `missing column(s): ${missing.join(", ")}`);
  }
}
