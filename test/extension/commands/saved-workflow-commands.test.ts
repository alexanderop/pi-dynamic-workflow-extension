import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RegisteredCommand, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tempWorkflowDir } from "../../suite/tmpdir.ts";
import {
  classifySavedWorkflowCommand,
  formatSyncDirectCommandsDiagnostics,
  isCommandSafeName,
  SavedWorkflowCommandRegistry,
  type RegisterSavedWorkflowCommandsPi,
  type SavedWorkflowCommandRegistryOptions,
} from "#src/extension/commands/saved-workflow-commands.ts";
import { ok } from "#src/workflows/result.ts";
import type { WorkflowLaunch, WorkflowTaskNotification } from "#src/workflows/launch/launcher.ts";
import { workflowScript } from "../../builders/workflow-script.ts";
import { fakePi } from "../../support.ts";

type RegisteredCommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

interface FakePiHarness {
  readonly pi: RegisterSavedWorkflowCommandsPi;
  readonly commands: Map<string, RegisteredCommandOptions>;
  readonly sendMessage: ReturnType<typeof vi.fn>;
}

function fakeHarness(existing: Pick<SlashCommandInfo, "name" | "source">[] = []): FakePiHarness {
  const commands = new Map<string, RegisteredCommandOptions>();
  const sendMessage = vi.fn<(...args: unknown[]) => void>();
  const pi = fakePi<RegisterSavedWorkflowCommandsPi>({
    registerCommand: (name: string, options: RegisteredCommandOptions) => {
      commands.set(name, options);
    },
    getCommands: () => [...existing, ...registeredAsInfo(commands)],
    sendMessage,
  });
  return { pi, commands, sendMessage };
}

function registeredAsInfo(
  commands: Map<string, RegisteredCommandOptions>,
): Pick<SlashCommandInfo, "name" | "source">[] {
  return [...commands.keys()].map((name) => ({ name, source: "extension" as const }));
}

async function writeSavedWorkflow(
  rootDir: string,
  name: string,
  description?: string,
): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, `${name}.js`),
    workflowScript({ meta: { name, description } }),
    "utf8",
  );
}

function launchSpy() {
  return vi.fn<NonNullable<SavedWorkflowCommandRegistryOptions["launchWorkflow"]>>(async () =>
    ok<WorkflowLaunch>({
      taskId: "task_saved",
      runId: "wf_saved",
      scriptPath: "/tmp/wf_saved/script.js",
      transcriptDir: "/tmp/wf_saved/transcripts",
      confirmation: "Workflow launched.",
      completion: Promise.resolve(ok({} as never)),
    }),
  );
}

function notificationForTest(
  status: WorkflowTaskNotification["details"]["status"],
): WorkflowTaskNotification {
  return {
    customType: "workflow-task-notification",
    display: true,
    content: "<task-notification />",
    details: {
      taskId: "task_saved",
      runId: "wf_saved",
      outputFile: "/tmp/wf_saved/output.json",
      status,
      summary: `Dynamic workflow ${status}`,
      result: "",
      usage: { agentCount: 0, subagentTokens: 0, toolUses: 0, durationMs: 0 },
    },
  };
}

describe("command-name classification", () => {
  it("should accept plain command names", () => {
    expect(isCommandSafeName("deep-research")).toBe(true);
  });

  it.each([
    ["", "empty"],
    ["/leading", "leading slash"],
    ["skill:foo", "skill prefix"],
    ["has space", "whitespace"],
    ["nested/name", "path separator"],
    ["back\\slash", "backslash"],
  ])("should reject unsafe name %s (%s)", (name) => {
    expect(isCommandSafeName(name)).toBe(false);
  });

  it("should classify a safe, unused name as registered", () => {
    const result = classifySavedWorkflowCommand(
      { name: "deep-research", path: "/p/deep-research.js" },
      [],
    );
    expect(result.status).toBe("registered");
  });

  it("should classify invalid names", () => {
    const result = classifySavedWorkflowCommand({ name: "has space", path: "/p/x.js" }, []);
    expect(result.status).toBe("skipped_invalid_name");
  });

  it.each(["workflow", "workflows"])("should classify reserved name %s", (name) => {
    const result = classifySavedWorkflowCommand({ name, path: `/p/${name}.js` }, []);
    expect(result.status).toBe("skipped_reserved");
  });

  it("should classify a prompt-template collision with a usable fallback reason", () => {
    const result = classifySavedWorkflowCommand({ name: "review", path: "/p/review.js" }, [
      { name: "review", source: "prompt" },
    ]);
    expect(result.status).toBe("skipped_collision");
    expect(result.reason).toContain("prompt template");
    expect(result.reason).toContain("/workflow review");
  });

  it("should classify a skill collision", () => {
    const result = classifySavedWorkflowCommand({ name: "triage", path: "/p/triage.js" }, [
      { name: "triage", source: "skill" },
    ]);
    expect(result.status).toBe("skipped_collision");
    expect(result.reason).toContain("skill command");
  });
});

describe("formatSyncDirectCommandsDiagnostics", () => {
  it("should return undefined for a clean sync", () => {
    expect(
      formatSyncDirectCommandsDiagnostics({ status: "ok", registrations: [] }),
    ).toBeUndefined();
  });

  it("should surface listing errors", () => {
    const message = formatSyncDirectCommandsDiagnostics({
      status: "error",
      message: "workflow root unreadable",
    });
    expect(message).toContain("workflow root unreadable");
  });

  it("should surface per-command registration failures", () => {
    const message = formatSyncDirectCommandsDiagnostics({
      status: "ok",
      registrations: [
        {
          workflowName: "boom",
          commandName: "boom",
          path: "/p/boom.js",
          status: "error",
          reason: "kaboom",
        },
        { workflowName: "ok", commandName: "ok", path: "/p/ok.js", status: "registered" },
      ],
    });
    expect(message).toContain("/boom");
    expect(message).toContain("kaboom");
  });

  it("should ignore expected skips", () => {
    expect(
      formatSyncDirectCommandsDiagnostics({
        status: "ok",
        registrations: [
          {
            workflowName: "review",
            commandName: "review",
            path: "/p/review.js",
            status: "skipped_collision",
            reason: "already used",
          },
        ],
      }),
    ).toBeUndefined();
  });
});

describe("SavedWorkflowCommandRegistry", () => {
  let tempDir: string;
  let rootDir: string;

  beforeEach(async () => {
    tempDir = await tempWorkflowDir("pi-saved-commands-");
    rootDir = join(tempDir, ".pi", "workflows");
  });

  it("should register the generic /workflow command with completions", () => {
    const { pi, commands } = fakeHarness();
    new SavedWorkflowCommandRegistry(pi).registerGenericCommand();

    const generic = commands.get("workflow");
    expect(generic).toBeDefined();
    expect(generic?.description).toContain("/workflow <name>");
    expect(generic?.getArgumentCompletions).toBeTypeOf("function");
  });

  it("should launch a saved workflow by name through the generic command", async () => {
    const { pi, commands } = fakeHarness();
    const launchWorkflow = launchSpy();
    new SavedWorkflowCommandRegistry(pi, { launchWorkflow }).registerGenericCommand();

    const notify = vi.fn<(...args: unknown[]) => void>();
    await commands.get("workflow")?.handler("deep-research who is alex", {
      cwd: tempDir,
      mode: "tui",
      hasUI: true,
      ui: { notify },
    } as never);

    expect(launchWorkflow).toHaveBeenCalledWith(
      { name: "deep-research", args: "who is alex" },
      expect.objectContaining({
        rootDir,
        cwd: tempDir,
        triggerSource: "saved",
      }),
    );
    expect(notify).toHaveBeenCalledWith(
      "Launched workflow 'deep-research' as wf_saved. Watch with /workflows.",
      "info",
    );
  });

  it("should pass empty args when the generic command has only a name", async () => {
    const { pi, commands } = fakeHarness();
    const launchWorkflow = launchSpy();
    new SavedWorkflowCommandRegistry(pi, { launchWorkflow }).registerGenericCommand();

    await commands.get("workflow")?.handler("echo", {
      cwd: tempDir,
      mode: "tui",
      hasUI: true,
      ui: { notify: vi.fn<() => void>() },
    } as never);

    expect(launchWorkflow).toHaveBeenCalledWith(
      { name: "echo", args: "" },
      expect.objectContaining({ triggerSource: "saved" }),
    );
  });

  it("should route terminal notifications through prepareWorkflowNotification to sendMessage", async () => {
    const { pi, commands, sendMessage } = fakeHarness();
    const launchWorkflow = launchSpy();
    new SavedWorkflowCommandRegistry(pi, { launchWorkflow }).registerGenericCommand();

    await commands.get("workflow")?.handler("deep-research who is alex", {
      cwd: tempDir,
      mode: "tui",
      hasUI: true,
      ui: { notify: vi.fn<() => void>() },
    } as never);

    const launchOptions = launchWorkflow.mock.calls[0]?.[1];
    expect(launchOptions?.notifyTerminal).toBeTypeOf("function");

    await launchOptions?.notifyTerminal?.(notificationForTest("completed"));
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "<task-notification />" }),
      { deliverAs: "followUp", triggerTurn: true },
    );

    await launchOptions?.notifyTerminal?.(notificationForTest("stopped"));
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Do not rerun, resume, or replace it yourself"),
      }),
      { deliverAs: "followUp", triggerTurn: false },
    );
  });

  it("should leave notifyTerminal undefined when the host cannot send messages", async () => {
    const commands = new Map<string, RegisteredCommandOptions>();
    const launchWorkflow = launchSpy();
    const pi = fakePi<RegisterSavedWorkflowCommandsPi>({
      registerCommand: (name: string, options: RegisteredCommandOptions) => {
        commands.set(name, options);
      },
      getCommands: () => [],
    });
    new SavedWorkflowCommandRegistry(pi, { launchWorkflow }).registerGenericCommand();

    await commands.get("workflow")?.handler("echo hi", {
      cwd: tempDir,
      mode: "tui",
      hasUI: true,
      ui: { notify: vi.fn<() => void>() },
    } as never);

    expect(launchWorkflow.mock.calls[0]?.[1]?.notifyTerminal).toBeUndefined();
  });

  it("should print a usage message when the generic command has no name", async () => {
    const { pi, commands } = fakeHarness();
    const launchWorkflow = launchSpy();
    new SavedWorkflowCommandRegistry(pi, { launchWorkflow }).registerGenericCommand();
    const stdoutWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await commands.get("workflow")?.handler("   ", {
        cwd: tempDir,
        mode: "print",
        hasUI: false,
        ui: { notify: vi.fn<() => void>() },
      } as never);

      expect(launchWorkflow).not.toHaveBeenCalled();
      expect(stdoutWrite).toHaveBeenCalledWith(
        expect.stringContaining("Usage: /workflow <name> [args]"),
      );
    } finally {
      stdoutWrite.mockRestore();
    }
  });

  it("should label generic launch output with the /workflow command name in json mode", async () => {
    const { pi, commands } = fakeHarness();
    const launchWorkflow = launchSpy();
    new SavedWorkflowCommandRegistry(pi, { launchWorkflow }).registerGenericCommand();
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await commands.get("workflow")?.handler("deep-research who is alex", {
        cwd: tempDir,
        mode: "json",
        hasUI: false,
        ui: { notify: vi.fn<() => void>() },
      } as never);

      const output = String(stdoutWrite.mock.calls[0]?.[0]);
      expect(JSON.parse(output)).toMatchObject({
        type: "workflow_command_output",
        command: "workflow",
        severity: "info",
      });
    } finally {
      stdoutWrite.mockRestore();
    }
  });

  it("should label direct launch output with the workflow command name in json mode", async () => {
    await writeSavedWorkflow(rootDir, "deep-research", "Research a question");
    const { pi, commands } = fakeHarness();
    const launchWorkflow = launchSpy();
    const registry = new SavedWorkflowCommandRegistry(pi, { launchWorkflow });
    await registry.syncDirectCommands({ cwd: tempDir });
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await commands.get("deep-research")?.handler("who is alex", {
        cwd: tempDir,
        mode: "json",
        hasUI: false,
        ui: { notify: vi.fn<() => void>() },
      } as never);

      const output = String(stdoutWrite.mock.calls[0]?.[0]);
      expect(JSON.parse(output)).toMatchObject({
        type: "workflow_command_output",
        command: "deep-research",
        severity: "info",
      });
    } finally {
      stdoutWrite.mockRestore();
    }
  });

  it("should report an error status without throwing when registerCommand fails", async () => {
    await writeSavedWorkflow(rootDir, "boom", "Boom");
    const pi = fakePi<RegisterSavedWorkflowCommandsPi>({
      registerCommand: (name: string) => {
        if (name === "boom") throw new Error("registry exploded");
      },
      getCommands: () => [],
    });
    const registry = new SavedWorkflowCommandRegistry(pi);

    const result = await registry.syncDirectCommands({ cwd: tempDir });

    if (result.status !== "ok") throw new Error("expected ok");
    const registration = result.registrations.find((entry) => entry.workflowName === "boom");
    expect(registration?.status).toBe("error");
    expect(registration?.reason).toContain("registry exploded");
  });

  it("should surface resolver errors for a missing saved workflow in json mode", async () => {
    const { pi, commands } = fakeHarness();
    new SavedWorkflowCommandRegistry(pi).registerGenericCommand();
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await commands.get("workflow")?.handler("missing", {
        cwd: tempDir,
        mode: "json",
        hasUI: false,
        ui: { notify: vi.fn<() => void>() },
      } as never);

      expect(stderrWrite).toHaveBeenCalledWith(
        expect.stringContaining("Saved workflow 'missing' was not found."),
      );
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("should register safe direct commands on sync", async () => {
    await writeSavedWorkflow(rootDir, "deep-research", "Research a question");
    const { pi, commands } = fakeHarness();
    const registry = new SavedWorkflowCommandRegistry(pi);

    const result = await registry.syncDirectCommands({ cwd: tempDir });

    expect(result.status).toBe("ok");
    const direct = commands.get("deep-research");
    expect(direct).toBeDefined();
    expect(direct?.description).toBe("Research a question");
  });

  it("should launch by name with trailing text as args from a direct command", async () => {
    await writeSavedWorkflow(rootDir, "deep-research", "Research a question");
    const { pi, commands } = fakeHarness();
    const launchWorkflow = launchSpy();
    const registry = new SavedWorkflowCommandRegistry(pi, { launchWorkflow });
    await registry.syncDirectCommands({ cwd: tempDir });

    await commands.get("deep-research")?.handler("who is alex", {
      cwd: tempDir,
      mode: "tui",
      hasUI: true,
      ui: { notify: vi.fn<() => void>() },
    } as never);

    expect(launchWorkflow).toHaveBeenCalledWith(
      { name: "deep-research", args: "who is alex" },
      expect.objectContaining({ triggerSource: "saved", rootDir }),
    );
  });

  it("should skip a saved workflow that collides with a prompt template", async () => {
    await writeSavedWorkflow(rootDir, "review", "Review changes");
    const { pi, commands } = fakeHarness([{ name: "review", source: "prompt" }]);
    const registry = new SavedWorkflowCommandRegistry(pi);

    const result = await registry.syncDirectCommands({ cwd: tempDir });

    expect(commands.has("review")).toBe(false);
    if (result.status !== "ok") throw new Error("expected ok");
    const registration = result.registrations.find((entry) => entry.workflowName === "review");
    expect(registration?.status).toBe("skipped_collision");
  });

  it("should stay idempotent across repeated syncs", async () => {
    await writeSavedWorkflow(rootDir, "echo", "Echo");
    const registerCommand = vi.fn<(...args: unknown[]) => void>();
    const pi = fakePi<RegisterSavedWorkflowCommandsPi>({
      registerCommand,
      getCommands: () => [],
    });
    const registry = new SavedWorkflowCommandRegistry(pi);

    await registry.syncDirectCommands({ cwd: tempDir });
    await registry.syncDirectCommands({ cwd: tempDir });

    const echoRegistrations = registerCommand.mock.calls.filter((call) => call[0] === "echo");
    expect(echoRegistrations).toHaveLength(1);
  });

  it("should offer saved workflow names as generic-command completions after sync", async () => {
    await writeSavedWorkflow(rootDir, "deep-research", "Research a question");
    await writeSavedWorkflow(rootDir, "echo", "Echo");
    const { pi, commands } = fakeHarness();
    const registry = new SavedWorkflowCommandRegistry(pi);
    registry.registerGenericCommand();
    await registry.syncDirectCommands({ cwd: tempDir });

    const completions = await commands.get("workflow")?.getArgumentCompletions?.("deep");
    expect(completions).toEqual([
      { value: "deep-research", label: "deep-research", description: "Research a question" },
    ]);
  });
});
