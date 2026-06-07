import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { workflowRootDirForCwd } from "#src/workflows/run/root-dir.ts";
import { WorkflowRunStore } from "#src/workflows/run/store.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";
import {
  formatWorkflowStatusline,
  selectWorkflowStatuslineRun,
} from "#src/workflows/statusline/projector.ts";

export const WORKFLOW_STATUSLINE_KEY = "dynamic-workflows";

export interface WorkflowStatuslineControllerOptions {
  readonly setStatus: (key: string, text: string | undefined) => void;
  readonly now?: () => number;
  readonly sessionId?: string;
  readonly statusKey?: string;
}

export interface WorkflowStatuslineController {
  readonly update: (run: WorkflowRunState) => void;
  readonly setRuns: (runs: readonly WorkflowRunState[]) => void;
  readonly tick: () => void;
  readonly dispose: () => void;
}

export interface RegisterWorkflowStatuslineOptions {
  readonly pollIntervalMs?: number;
}

export function createWorkflowStatuslineController(
  options: WorkflowStatuslineControllerOptions,
): WorkflowStatuslineController {
  const runs = new Map<string, WorkflowRunState>();
  const statusKey = options.statusKey ?? WORKFLOW_STATUSLINE_KEY;
  const now = options.now ?? Date.now;

  const render = (): void => {
    const selected = selectWorkflowStatuslineRun(Array.from(runs.values()), {
      sessionId: options.sessionId,
    });
    options.setStatus(
      statusKey,
      selected === undefined ? undefined : formatWorkflowStatusline(selected, { now: now() }),
    );
  };

  return {
    update: (run) => {
      if (options.sessionId !== undefined && run.sessionId !== options.sessionId) return;
      runs.set(run.runId, run);
      render();
    },
    setRuns: (nextRuns) => {
      runs.clear();
      for (const run of nextRuns) runs.set(run.runId, run);
      render();
    },
    tick: render,
    dispose: () => {
      runs.clear();
      options.setStatus(statusKey, undefined);
    },
  };
}

export function registerWorkflowStatusline(
  pi: Pick<ExtensionAPI, "on">,
  options: RegisterWorkflowStatuslineOptions = {},
): void {
  let active: { readonly dispose: () => void } | undefined;

  pi.on("session_start", (_event, ctx) => {
    active?.dispose();
    active = startWorkflowStatuslineSession(ctx, options);
  });

  pi.on("session_shutdown", () => {
    active?.dispose();
    active = undefined;
  });
}

function startWorkflowStatuslineSession(
  ctx: ExtensionContext,
  options: RegisterWorkflowStatuslineOptions,
): { readonly dispose: () => void } {
  const controller = createWorkflowStatuslineController({
    setStatus: (key, text) => ctx.ui.setStatus(key, text),
    now: Date.now,
    sessionId: currentSessionId(ctx),
  });
  const store = new WorkflowRunStore({ rootDir: workflowRootDirForCwd(ctx.cwd) });

  let disposed = false;
  let refreshPending = false;
  const refresh = async (): Promise<void> => {
    if (disposed || refreshPending) return;
    refreshPending = true;
    try {
      const result = await store.listRuns();
      if (result.status === "ok") controller.setRuns(result.value);
    } finally {
      refreshPending = false;
    }
  };

  void refresh();
  const interval = setInterval(() => {
    controller.tick();
    void refresh();
  }, options.pollIntervalMs ?? 1000);
  interval.unref?.();

  return {
    dispose: () => {
      disposed = true;
      clearInterval(interval);
      controller.dispose();
    },
  };
}

function currentSessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager?.getSessionId?.();
  } catch {
    return undefined;
  }
}
