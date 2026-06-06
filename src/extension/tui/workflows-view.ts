import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Result } from "#src/workflows/result.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";
import type { WorkflowRunStoreError } from "#src/workflows/run/store.ts";
import { WorkflowsTuiComponent } from "./workflows-component.ts";

export interface ShowWorkflowsTuiOptions {
  readonly runs: WorkflowRunState[];
  readonly savedWorkflowCount: number;
  readonly loadRuns?: () => Promise<Result<WorkflowRunState[], WorkflowRunStoreError>>;
  readonly pollIntervalMs?: number;
  readonly onPauseRun?: (runId: string) => void;
  readonly onResumeRun?: (runId: string) => void;
  readonly onStopRun?: (runId: string) => void;
  readonly onStopAgent?: (runId: string, agentId: string) => void;
}

export async function showWorkflowsTui(
  ctx: ExtensionCommandContext,
  options: ShowWorkflowsTuiOptions,
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const component = new WorkflowsTuiComponent({
      runs: options.runs,
      savedWorkflowCount: options.savedWorkflowCount,
      theme,
      onClose: () => done(undefined),
      onPauseRun: options.onPauseRun,
      onResumeRun: options.onResumeRun,
      onStopRun: options.onStopRun,
      onStopAgent: options.onStopAgent,
    });

    let disposed = false;
    let refreshPending = false;
    const refresh = async (): Promise<void> => {
      if (disposed || refreshPending || options.loadRuns === undefined) return;
      refreshPending = true;
      try {
        const result = await options.loadRuns();
        if (result.status === "ok") {
          component.setRuns(result.value);
          tui.requestRender();
        }
      } finally {
        refreshPending = false;
      }
    };

    const pollInterval =
      options.loadRuns === undefined
        ? undefined
        : setInterval(refresh, options.pollIntervalMs ?? 1000);
    pollInterval?.unref?.();

    return {
      render: (width: number) => component.render(width),
      handleInput: (data: string) => {
        component.handleInput(data);
        tui.requestRender();
      },
      invalidate: () => component.invalidate(),
      dispose: () => {
        disposed = true;
        if (pollInterval !== undefined) clearInterval(pollInterval);
      },
    };
  });
}
