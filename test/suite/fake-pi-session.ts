import { vi } from "vitest";
import type { PiWorkflowAgentSession } from "#src/workflows/agent/pi-runner.ts";

/**
 * Provider-level fake for a Pi sidechain agent session.
 *
 * This is the low-level fake that satisfies the `PiWorkflowAgentSession`
 * contract directly, letting tests drive the real `PiRunner` against a fake
 * session. It is distinct from the higher-level `agent-mock.ts` server, which
 * fakes the scheduler/runtime agent boundary. Use this when the code under test
 * is the Pi runner adapter itself.
 */
export class FakePiSession implements PiWorkflowAgentSession {
  readonly messages: unknown[] = [];
  readonly prompt = vi.fn<(text: string, options?: unknown) => Promise<void>>(
    async (text, options) => {
      this.promptText = text;
      this.promptTexts.push(text);
      this.promptOptions.push(options);
      await this.onPrompt?.(text, options, this.promptTexts.length - 1);
      this.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "subagent result" }],
      });
    },
  );
  readonly abort = vi.fn<() => void>();
  readonly dispose = vi.fn<() => void>();
  readonly unsubscribe = vi.fn<() => void>();
  #listeners: Array<(event: unknown) => void> = [];
  promptText = "";
  readonly promptTexts: string[] = [];
  readonly promptOptions: unknown[] = [];

  constructor(
    private readonly onPrompt?: (
      text: string,
      options: unknown,
      callIndex: number,
    ) => Promise<void> | void,
  ) {}

  subscribe(listener: (event: unknown) => void): () => void {
    this.#listeners.push(listener);
    return this.unsubscribe;
  }

  emit(event: unknown): void {
    for (const listener of this.#listeners) listener(event);
  }
}
