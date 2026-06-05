import { stat } from "node:fs/promises";
import type { Result } from "../src/workflows/result.ts";

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

/** A promise with externally accessible `resolve`/`reject`. */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

/** Resolve after `ms` milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WaitForOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

/** Poll `predicate` until it returns true or the timeout elapses. */
export async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 1000, intervalMs = 1 }: WaitForOptions = {},
): Promise<void> {
  const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await delay(intervalMs);
  }
  throw new Error("Timed out waiting for predicate.");
}

/** Unwrap a `Result`, throwing if it is an error. Use to assert the happy path. */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.status === "ok") return result.value;
  throw new Error(`Expected Result to be ok, got error: ${JSON.stringify(result.error)}`);
}

/** True when a filesystem path exists. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
