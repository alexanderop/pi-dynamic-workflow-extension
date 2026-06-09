import { vi } from "vitest";
import type { PiWorkflowAgentSession } from "#src/extension/agent/pi-runner.ts";

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
  /**
   * One spy per `subscribe()` call. Each entry removes only its own listener, so
   * assertions distinguish "the single subscription was torn down" from "some
   * shared spy was poked", which a single shared unsubscribe spy would conflate.
   */
  readonly unsubscribes: Array<ReturnType<typeof vi.fn<() => void>>> = [];
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
    const unsubscribe = vi.fn<() => void>(() => {
      const index = this.#listeners.indexOf(listener);
      if (index !== -1) this.#listeners.splice(index, 1);
    });
    this.unsubscribes.push(unsubscribe);
    return unsubscribe;
  }

  /** Number of currently-subscribed listeners (after any unsubscribes). */
  get listenerCount(): number {
    return this.#listeners.length;
  }

  emit(event: unknown): void {
    // Snapshot via slice so a listener that unsubscribes mid-emit does not
    // disturb iteration over the live array.
    for (const listener of this.#listeners.slice()) listener(event);
  }
}
