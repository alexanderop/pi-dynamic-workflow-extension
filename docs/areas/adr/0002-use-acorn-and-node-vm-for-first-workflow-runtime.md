# ADR 0002: Use Acorn And Node VM For First Workflow Runtime

Status: accepted

## Context

`spec.md` defines workflows as plain JavaScript with a literal `export const meta`
header, top-level `await`, a small host API, and deterministic replay
requirements. The launcher must read `meta` statically before executing the
script body, and workflow JavaScript must not receive arbitrary filesystem,
shell, network, or MCP access.

We inspected `Michaelliv/pi-dynamic-workflows` as prior art. Its strongest
reusable parts are the Acorn-based parser for static metadata and determinism
checks, plus a compact `node:vm` runtime that evaluates the validated workflow
body with only selected globals.

That repository is a prototype tool that runs workflows inline. Our target
architecture remains the detached launcher, scheduler, persistence layer,
journal, and `/workflows` UI described in `spec.md`.

## Decision

Use Acorn for the first workflow parser and static validator.

The parser will:

- Require the first statement to be `export const meta = ...`.
- Accept only literal metadata values.
- Reject metadata spreads, computed keys, accessors, function calls, variables,
  and template interpolation.
- Reject workflow scripts that use nondeterministic primitives such as
  `Date.now()`, `Math.random()`, and argument-less `new Date()`.
- Return both the validated `WorkflowMeta` and the executable script body with
  the `meta` export removed.

Use Node's built-in `node:vm` module for the first JavaScript execution kernel.

The runtime will evaluate the parsed body as an async wrapper with only the
workflow globals documented in `spec.md`: `args`, `budget`, `phase`, `log`,
`agent`, `parallel`, `pipeline`, and eventually nested `workflow`.

Keep this execution kernel separate from launcher, scheduler, persistence,
journal, subagent runner, and UI modules.

## Consequences

- The first implementation can satisfy the script-format and runtime-API parts
  of `spec.md` without inventing a custom JavaScript interpreter.
- Parser behavior can be unit-tested heavily before any live Pi subagent work.
- We can reuse the prior art's parser/runtime tests as a starting point while
  adapting names and types to this package.
- `node:vm` is not treated as a complete security boundary. We still need a
  small global object, static validation, no direct trusted APIs in the context,
  and separate tests for denied capabilities.
- Detached execution, persistence, resume, and `/workflows` remain outside this
  ADR. The VM runtime is only the script execution kernel inside the larger
  architecture from `spec.md`.
