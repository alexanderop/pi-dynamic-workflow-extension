# Error Handling

This project uses explicit return values for recoverable errors at TypeScript
module boundaries, while keeping the workflow runtime API aligned with
`spec.md`.

The local pattern is inspired by Rust-style `Result<T, E>` and by the
`better-result` library, but this repository does not install or vendor that
library. The implementation is intentionally small and lives in
`src/workflows/result.ts`.

## Goals

- Make expected failures visible in function signatures.
- Keep caller code honest about success and error branches.
- Avoid adding a dependency before the project proves it needs a larger Result
  library.
- Preserve observed dynamic-workflow behavior from `spec.md`, even where that
  behavior uses `null` rather than a typed error value.

## Local Result Type

Use `Result<T, E>` when an internal function can fail in an expected,
recoverable way.

```ts
import { err, ok, type Result } from "./result.ts";

interface LoadWorkflowError {
  readonly _tag: "LoadWorkflowError";
  readonly message: string;
}

function loadWorkflow(path: string): Result<string, LoadWorkflowError> {
  if (path.length === 0) {
    return err({
      _tag: "LoadWorkflowError",
      message: "Workflow path must not be empty.",
    });
  }

  return ok(path);
}
```

A `Result` value has one of two shapes:

```ts
type Result<T, E> =
  | { status: "ok"; value: T }
  | { status: "error"; error: E };
```

The discriminator is `status`, using `"ok"` and `"error"`.

## Helper Functions

`src/workflows/result.ts` provides:

- `ok(value)` - create a success value.
- `err(error)` - create an error value.
- `isOk(result)` - narrow a result to the success branch.
- `isErr(result)` - narrow a result to the error branch.
- `match(result, handlers)` - handle both branches in one expression.
- `tryResult(run, mapError)` - convert a throwing sync function into `Result`.
- `tryPromise(run, mapError)` - convert a rejecting async function into
  `Promise<Result>`.

Prefer typed domain errors over raw strings:

```ts
const parsed = tryResult(
  () => JSON.parse(source),
  (cause) => ({
    _tag: "WorkflowJsonParseError" as const,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  }),
);
```

## Current Workflow APIs

Some APIs still throw because that is the existing public surface:

- `parseWorkflowScript(source)` throws `WorkflowParseError`.
- `runWorkflowScript(source, options)` rejects on parse or runtime failures.
- `parallel(thunks)` throws for invalid input, such as already-started promises.
- `pipeline(items, ...stages)` throws for invalid input.

For call sites that want explicit error values, use the opt-in wrappers:

- `tryParseWorkflowScript(source)` returns
  `Result<ParsedWorkflowScript, WorkflowParseError>`.
- `tryRunWorkflowScript(source, options)` returns
  `Promise<Result<WorkflowRuntimeState, WorkflowRuntimeError>>`.

This lets existing tests and behavior stay stable while new code can choose the
Result-returning contract.

## Workflow Spec Exceptions

Do not replace all workflow-level `null` values with `Result` objects.

`spec.md` currently defines these externally visible behaviors:

- `agent()` resolves to `null` when the user skips the agent.
- `parallel()` resolves a throwing thunk to `null` at that result index.
- `pipeline()` drops a failed item to `null` and skips its remaining stages.

Those `null` values are part of the reverse-engineered workflow contract. Keep
them unless `spec.md` changes. If internal implementation code needs richer
failure details, record them in run failures, progress rows, journal events, or
typed internal helpers without changing the workflow script return contract.

## When To Use Result

Use `Result` for:

- parser and loader functions where invalid input is expected.
- filesystem or persistence helpers that can fail for known reasons.
- scheduler or controller operations where the caller can decide how to recover.
- adapter boundaries where thrown third-party or VM errors should become typed
  project errors.

Use throwing errors for:

- programmer mistakes, such as invalid helper arguments.
- invariant violations that should fail fast in tests.
- APIs whose current contract already throws and where adding a wrapper is less
  disruptive than changing the base function.

Use `null` for:

- workflow script values that `spec.md` explicitly says resolve to `null`.

## Error Shape

Prefer tagged object errors:

```ts
interface WorkflowRuntimeError {
  readonly _tag: "WorkflowRuntimeError";
  readonly message: string;
  readonly cause: unknown;
}
```

The `_tag` field makes error unions easier to narrow and pattern-match without
relying on `instanceof`, which can be unreliable for errors created in another
VM context.

## Tests

When adding Result-returning behavior:

- test the success branch.
- test the error branch.
- assert the typed error tag and message.
- keep separate tests for existing throwing behavior if the throwing API remains
  public.

