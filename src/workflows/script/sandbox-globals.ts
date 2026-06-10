// The host-provided globals and shims injected into every workflow sandbox:
// the public parallel()/pipeline() combinators and the determinism shims for
// Date/Math. Script execution itself lives in runtime.ts.

export const WORKFLOW_COLLECTION_ITEM_LIMIT = 4096;

export interface WorkflowBranchFailure {
  readonly index: number;
  readonly cause: unknown;
}

/**
 * Notified when a `parallel()` thunk or `pipeline()` item is dropped to `null`.
 * The runtime binds this to the workflow log so a swallowed fan-out failure is
 * visible for debugging instead of vanishing silently.
 */
export type WorkflowBranchFailureReporter = (failure: WorkflowBranchFailure) => void;

export function createParallel(reportFailure?: WorkflowBranchFailureReporter) {
  return async function parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> {
    if (!Array.isArray(thunks)) throw new TypeError("parallel() requires an array of thunks.");
    assertCollectionItemLimit("parallel", thunks.length);
    for (const thunk of thunks) {
      if (typeof thunk !== "function")
        throw new TypeError("parallel() accepts only thunks: () => Promise<T>.");
    }

    return Promise.all(
      thunks.map(async (thunk, index) => {
        try {
          return await thunk();
        } catch (cause) {
          reportFailure?.({ index, cause });
          return null;
        }
      }),
    );
  };
}

export function createPipeline(reportFailure?: WorkflowBranchFailureReporter) {
  return async function pipeline<T>(
    items: T[],
    ...stages: Array<(previous: unknown, item: T, index: number) => Promise<unknown>>
  ): Promise<unknown[]> {
    if (!Array.isArray(items)) throw new TypeError("pipeline() requires an array of items.");
    assertCollectionItemLimit("pipeline", items.length);
    for (const stage of stages) {
      if (typeof stage !== "function") throw new TypeError("pipeline() stages must be functions.");
    }

    return Promise.all(
      items.map(async (item, index) => {
        let previous: unknown = item;
        for (const stage of stages) {
          try {
            previous = await stage(previous, item, index);
          } catch (cause) {
            reportFailure?.({ index, cause });
            return null;
          }
        }
        return previous;
      }),
    );
  };
}

function assertCollectionItemLimit(name: "parallel" | "pipeline", length: number): void {
  if (length > WORKFLOW_COLLECTION_ITEM_LIMIT) {
    throw new TypeError(
      `${name}() accepts at most ${WORKFLOW_COLLECTION_ITEM_LIMIT} items, got ${length}.`,
    );
  }
}

export function deterministicMath(): Math {
  const deterministic = Object.create(null);
  for (const key of Reflect.ownKeys(Math)) {
    Object.defineProperty(deterministic, key, Object.getOwnPropertyDescriptor(Math, key)!);
  }
  Object.defineProperty(deterministic, "random", {
    value: () => {
      throw new Error("Workflow scripts must not call Math.random(); use stable indexes instead.");
    },
  });
  return deterministic;
}

export function deterministicDate(): DateConstructor {
  const RealDate = Date;
  const DeterministicDate = function (this: Date, ...args: unknown[]) {
    if (args.length === 0) {
      throw new Error(
        "Workflow scripts must not call argument-less new Date(); pass timestamps through args instead.",
      );
    }
    return Reflect.construct(RealDate, args, new.target ?? RealDate);
  };

  Object.setPrototypeOf(DeterministicDate, RealDate);
  DeterministicDate.prototype = RealDate.prototype;
  Object.defineProperty(DeterministicDate, "now", {
    value: (): number => {
      throw new Error(
        "Workflow scripts must not call Date.now(); pass timestamps through args instead.",
      );
    },
  });

  return DeterministicDate as unknown as DateConstructor;
}
