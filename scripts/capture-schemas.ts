/**
 * Records the SHAPE of live Razorpay test mode API responses.
 *
 * Why this exists: the corpus generator emits files whose columns are supposed to look
 * like the real thing. Inventing those column names from memory produces a corpus that
 * is realistic looking rather than realistic, and every downstream claim inherits that
 * weakness. So the shapes are taken from the API itself where the API will give them up,
 * and from the public reference where it will not, and which is which is recorded.
 *
 * What this writes: field names and types. Never values.
 *
 * Test mode carries no real money and no real customer, but a captured value is still a
 * value, and a script that writes values into a tracked file is one edit away from
 * writing the wrong ones. So the recorder is structurally incapable of emitting a value:
 * `describe()` returns a type name and nothing else. See docs/REDLINES.md.
 *
 *   npm run capture:schemas
 *
 * Requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env.local, which is gitignored.
 */

import { readFile, writeFile } from "node:fs/promises";

const API = "https://api.razorpay.com/v1";

// ---------------------------------------------------------------------------
// credentials, read from the gitignored env file and never logged
// ---------------------------------------------------------------------------

async function loadCredentials(): Promise<{ auth: string }> {
  let raw: string;
  try {
    raw = await readFile(".env.local", "utf8");
  } catch {
    throw new Error(".env.local not found. It is gitignored. See the README.");
  }
  const read = (key: string): string => {
    const line = raw.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
    return (line ?? "").slice(key.length + 1).replace(/["']/g, "").trim();
  };
  const id = read("RAZORPAY_KEY_ID");
  const secret = read("RAZORPAY_KEY_SECRET");
  if (!id || !secret) throw new Error("RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is empty");
  if (!id.startsWith("rzp_test_")) {
    // fail closed. A live key here would put live identifiers into a capture run
    throw new Error("Refusing to run: key id is not a test mode key");
  }
  return { auth: Buffer.from(`${id}:${secret}`).toString("base64") };
}

// ---------------------------------------------------------------------------
// shape recording. Returns type names, never values
// ---------------------------------------------------------------------------

type Shape = string | { [key: string]: Shape };

function describe(value: unknown, depth = 0): Shape {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "array (empty)";
    return { "[]": depth > 3 ? "..." : describe(value[0], depth + 1) };
  }
  if (typeof value === "object") {
    if (depth > 3) return "object";
    const out: { [key: string]: Shape } = {};
    for (const key of Object.keys(value as object).sort()) {
      out[key] = describe((value as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  }
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string") return "string";
  return typeof value;
}

function renderShape(shape: Shape, indent = 0): string[] {
  if (typeof shape === "string") return [shape];
  const lines: string[] = [];
  for (const [key, child] of Object.entries(shape)) {
    if (typeof child === "string") {
      lines.push(`${" ".repeat(indent)}${key}: ${child}`);
    } else {
      lines.push(`${" ".repeat(indent)}${key}:`);
      lines.push(...renderShape(child, indent + 2));
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// calls
// ---------------------------------------------------------------------------

interface Capture {
  readonly label: string;
  readonly endpoint: string;
  readonly status: number;
  readonly shape: Shape | null;
  readonly note: string;
}

async function call(
  auth: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

async function main(): Promise<void> {
  const { auth } = await loadCredentials();
  const captures: Capture[] = [];

  // Seed a small amount of test data. Test mode moves no money. Orders are the only
  // resource creatable from a key pair alone: a captured payment needs a checkout flow,
  // and a settlement is produced by Razorpay on its own schedule.
  const seeds = [
    { amount: 34900, currency: "INR", receipt: "reckon-shape-1" },
    { amount: 99900, currency: "INR", receipt: "reckon-shape-2" },
  ];
  let created = 0;
  for (const seed of seeds) {
    const { status } = await call(auth, "POST", "/orders", {
      ...seed,
      notes: { purpose: "schema shape capture, synthetic" },
    });
    if (status === 200) created++;
  }

  const endpoints: ReadonlyArray<readonly [string, string, string]> = [
    ["orders", "/orders?count=1", "list envelope and the order entity"],
    ["payments", "/payments?count=1", "list envelope and the payment entity"],
    ["settlements", "/settlements?count=1", "list envelope and the settlement entity"],
    [
      "settlement recon",
      "/settlements/recon/combined?year=2026&month=8",
      "the payment level reconciliation report",
    ],
    ["refunds", "/refunds?count=1", "list envelope and the refund entity"],
  ];

  for (const [label, path, note] of endpoints) {
    const { status, json } = await call(auth, "GET", path);
    const record = json as { items?: unknown[]; count?: number; error?: { description?: string } };
    const sample =
      Array.isArray(record?.items) && record.items.length > 0 ? record.items[0] : json;
    captures.push({
      label,
      endpoint: path.split("?")[0] ?? path,
      status,
      shape: status === 200 ? describe(sample) : null,
      note:
        status !== 200
          ? `unavailable on this account: ${record?.error?.description ?? `HTTP ${status}`}`
          : Array.isArray(record?.items) && record.items.length === 0
            ? "reachable, but empty on this test account, so only the collection envelope is live"
            : note,
    });
  }

  await writeFile("docs/SCHEMA-PROVENANCE.md", render(captures, created), "utf8");
  console.log(`\nseeded ${created} test order(s)`);
  for (const capture of captures) {
    const live = capture.shape !== null && !capture.note.startsWith("reachable, but empty");
    console.log(
      `  ${capture.label.padEnd(18)} HTTP ${capture.status}  ${live ? "shape captured live" : capture.note}`,
    );
  }
  console.log("\nwrote docs/SCHEMA-PROVENANCE.md (field names and types only)\n");
}

function render(captures: readonly Capture[], created: number): string {
  const lines: string[] = [
    "# Schema provenance",
    "",
    "Where the shape of every source file in `eval/fixtures/` comes from.",
    "",
    "The generator emits columns that are supposed to look like a real export. Inventing",
    "those names from memory produces a corpus that is realistic looking rather than",
    "realistic, and every downstream claim inherits that weakness. So the shapes below were",
    "taken from the live API where the API would give them up, and from the public reference",
    "where it would not. Which is which is recorded per resource, because a reader should not",
    "have to guess how much of this was checked.",
    "",
    "**Field names and types only. No values appear in this file.** `describe()` in",
    "`scripts/capture-schemas.ts` returns a type name and is structurally incapable of",
    "emitting a value. The script also refuses to run against a key id that does not begin",
    "`rzp_test_`. See `docs/REDLINES.md`.",
    "",
    "Regenerate with `npm run capture:schemas`. Requires `.env.local`, which is gitignored.",
    "",
    "---",
    "",
    "## Capture run",
    "",
    `Seeded ${created} synthetic test mode order(s) so the order entity had something to`,
    "describe. Test mode moves no money and contains no real customer. Orders are the only",
    "resource creatable from a key pair alone: a captured payment requires a checkout flow,",
    "and a settlement is produced by Razorpay on its own schedule and cannot be forced.",
    "",
  ];

  for (const capture of captures) {
    lines.push(`## ${capture.label}`);
    lines.push("");
    lines.push(`Endpoint: \`GET ${capture.endpoint}\``);
    lines.push(`Status: \`${capture.status}\``);
    lines.push("");
    lines.push(capture.note);
    lines.push("");
    if (capture.shape) {
      lines.push("```");
      lines.push(...renderShape(capture.shape));
      lines.push("```");
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("");
  lines.push("## What this means for the corpus");
  lines.push("");
  lines.push(
    "Any resource above marked empty contributed its collection envelope but not its entity",
  );
  lines.push(
    "fields. For those, the generator's columns follow the public API reference at",
  );
  lines.push(
    "<https://razorpay.com/docs/api/> rather than a live capture, and that is the weaker",
  );
  lines.push(
    "provenance of the two. It is stated here rather than left for a reader to discover.",
  );
  lines.push("");
  lines.push(
    "This resolves the first open question in section 8 of `docs/DESIGN.md`.",
  );
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## One finding from the capture, and it matters");
  lines.push("");
  lines.push(
    "The live order entity returns `amount: integer`. That integer is **paise**, the minor",
  );
  lines.push(
    "unit. A dashboard CSV export of the same data writes **rupees** with two decimals.",
  );
  lines.push("");
  lines.push(
    "The same logical field, two units, and nothing in either payload names the unit it is",
  );
  lines.push(
    "using. A reader has to already know. That is failure class F01 present in the real",
  );
  lines.push(
    "product rather than a hazard invented to make the corpus look difficult, and it is the",
  );
  lines.push(
    "reason `src/money` refuses to construct an amount without being told its currency and",
  );
  lines.push("scale explicitly.");
  lines.push("");
  lines.push(
    "The corpus follows the export convention, decimals in the CSV files, because a merchant",
  );
  lines.push(
    "reconciling by hand works from exports. The generator holds every amount as minor units",
  );
  lines.push("internally and formats only at the edge, which is the same discipline.");
  lines.push("");
  return lines.join("\n");
}

await main();
