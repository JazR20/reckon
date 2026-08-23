# Schema provenance

Where the shape of every source file in `eval/fixtures/` comes from.

The generator emits columns that are supposed to look like a real export. Inventing
those names from memory produces a corpus that is realistic looking rather than
realistic, and every downstream claim inherits that weakness. So the shapes below were
taken from the live API where the API would give them up, and from the public reference
where it would not. Which is which is recorded per resource, because a reader should not
have to guess how much of this was checked.

**Field names and types only. No values appear in this file.** `describe()` in
`scripts/capture-schemas.ts` returns a type name and is structurally incapable of
emitting a value. The script also refuses to run against a key id that does not begin
`rzp_test_`. See `docs/REDLINES.md`.

Regenerate with `npm run capture:schemas`. Requires `.env.local`, which is gitignored.

---

## Capture run

Seeded 2 synthetic test mode order(s) so the order entity had something to
describe. Test mode moves no money and contains no real customer. Orders are the only
resource creatable from a key pair alone: a captured payment requires a checkout flow,
and a settlement is produced by Razorpay on its own schedule and cannot be forced.

## orders

Endpoint: `GET /orders`
Status: `200`

list envelope and the order entity

```
amount: integer
amount_due: integer
amount_paid: null
attempts: integer
created_at: integer
currency: string
entity: string
id: string
notes:
  purpose: string
offer_id: null
receipt: string
status: string
```

## payments

Endpoint: `GET /payments`
Status: `200`

reachable, but empty on this test account, so only the collection envelope is live

```
count: integer
entity: string
items: array (empty)
```

## settlements

Endpoint: `GET /settlements`
Status: `200`

reachable, but empty on this test account, so only the collection envelope is live

```
count: integer
entity: string
has_more: boolean
items: array (empty)
```

## settlement recon

Endpoint: `GET /settlements/recon/combined`
Status: `200`

reachable, but empty on this test account, so only the collection envelope is live

```
count: integer
entity: string
items: array (empty)
```

## refunds

Endpoint: `GET /refunds`
Status: `200`

reachable, but empty on this test account, so only the collection envelope is live

```
count: integer
entity: string
items: array (empty)
```

---

## What this means for the corpus

Any resource above marked empty contributed its collection envelope but not its entity
fields. For those, the generator's columns follow the public API reference at
<https://razorpay.com/docs/api/> rather than a live capture, and that is the weaker
provenance of the two. It is stated here rather than left for a reader to discover.

This resolves the first open question in section 8 of `docs/DESIGN.md`.

---

## One finding from the capture, and it matters

The live order entity returns `amount: integer`. That integer is **paise**, the minor
unit. A dashboard CSV export of the same data writes **rupees** with two decimals.

The same logical field, two units, and nothing in either payload names the unit it is
using. A reader has to already know. That is failure class F01 present in the real
product rather than a hazard invented to make the corpus look difficult, and it is the
reason `src/money` refuses to construct an amount without being told its currency and
scale explicitly.

The corpus follows the export convention, decimals in the CSV files, because a merchant
reconciling by hand works from exports. The generator holds every amount as minor units
internally and formats only at the edge, which is the same discipline.
