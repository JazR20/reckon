# ADR 0004: no build step, and what that forbids

**Status:** accepted
**Date:** 2026-08-22

## Context

A reviewer of this repository will clone it and run one command. Every layer between the
clone and the result is a place verification stops. A bundler, a transpiler config, or a
generated `dist/` directory each add a step where the thing being read and the thing
being run diverge.

## Decision

Node runs the TypeScript sources directly using native type stripping. There is no
bundler, no transpile step and no build output. `tsc` is used for checking only, with
`--noEmit`.

## Rationale

`npm install && npm run eval` is the whole contract. Combined with the committed response
cache in ADR 0005, a reviewer reproduces every published number in about thirty seconds
with no API key and no configuration.

## What this forbids

Type stripping is strip only. It erases types and does not synthesise code, so any
TypeScript construct that requires emitted JavaScript is unavailable:

- **parameter properties**, `constructor(private readonly x: T)`. Fields must be declared
  and assigned explicitly. Found the hard way on day one, in `src/money/errors.ts`.
- **enums**. Use a `const` object with `as const` and a derived union type, which is what
  `CURRENCY_EXPONENT` and `Currency` already do.
- **namespaces** and **decorators**.
- Import statements must carry the `.ts` extension, hence
  `allowImportingTsExtensions` in `tsconfig.json`.

These are not workarounds. Every one of them is a construct that hides behaviour behind
generated code, and the repository reads better without them.

## Consequences

- Node 22.6 or newer is required. The `engines` field states 22.
- Contributors hitting `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` should read this file. The
  constraint is intentional.
- `npm run typecheck` is a separate gate from `npm test`, because running a file proves
  it executes and only `tsc` proves it is well typed.
