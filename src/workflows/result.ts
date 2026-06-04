export type Result<T, E> = Ok<T> | Err<E>;

export interface Ok<T> {
  readonly status: "ok";
  readonly value: T;
}

export interface Err<E> {
  readonly status: "error";
  readonly error: E;
}

export function ok<T>(value: T): Ok<T> {
  return { status: "ok", value };
}

export function err<E>(error: E): Err<E> {
  return { status: "error", error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.status === "ok";
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return result.status === "error";
}

export function match<T, E, R>(
  result: Result<T, E>,
  handlers: { ok: (value: T) => R; err: (error: E) => R },
): R {
  return isOk(result) ? handlers.ok(result.value) : handlers.err(result.error);
}

export function tryResult<T, E>(run: () => T, mapError: (cause: unknown) => E): Result<T, E> {
  try {
    return ok(run());
  } catch (cause) {
    return err(mapError(cause));
  }
}

export async function tryPromise<T, E>(
  run: () => Promise<T>,
  mapError: (cause: unknown) => E,
): Promise<Result<T, E>> {
  try {
    return ok(await run());
  } catch (cause) {
    return err(mapError(cause));
  }
}
