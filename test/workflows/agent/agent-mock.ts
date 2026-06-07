import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentOptions } from "#src/workflows/agent/model.ts";
import type {
  WorkflowAgentRunRequest,
  WorkflowAgentRunner,
} from "#src/workflows/agent/scheduler.ts";
import { afterAll, afterEach, beforeAll } from "vitest";

export interface AgentMockUnhandledPrint {
  readonly warning: () => void;
  readonly error: () => never;
  readonly bypass: () => string;
}

export type AgentMockUnhandledCallback = (
  call: AgentMockCall,
  print: AgentMockUnhandledPrint,
) => unknown;

export type AgentMockUnhandledStrategy = "error" | "warn" | "bypass" | AgentMockUnhandledCallback;

export interface AgentMockServerOptions {
  readonly onUnhandledAgent?: AgentMockUnhandledStrategy;
}

export interface AgentCallMatcher {
  readonly prompt?: AgentValueMatcher<string>;
  readonly label?: AgentValueMatcher<string>;
  readonly phase?: AgentValueMatcher<string>;
  readonly agentType?: AgentValueMatcher<string>;
  readonly model?: AgentValueMatcher<string>;
  readonly thinkingLevel?: AgentValueMatcher<NonNullable<AgentOptions["thinkingLevel"]>>;
  readonly schema?: AgentValueMatcher<unknown>;
}

export type AgentValueMatcher<T> = T | RegExp | ((value: T | undefined) => boolean);

export interface AgentMockCall {
  readonly prompt: string;
  readonly options: AgentOptions;
  readonly handled: boolean;
  readonly handler?: string;
  readonly agentId?: string;
  readonly journalKey?: string;
}

export interface AgentResolverInfo {
  readonly request: AgentMockRequest;
  readonly prompt: string;
  readonly options: AgentOptions;
  readonly callIndex: number;
  readonly agentId?: string;
  readonly journalKey?: string;
  readonly signal?: AbortSignal;
}

export interface AgentMockRequest {
  readonly prompt: string;
  readonly options: AgentOptions;
  readonly agentId?: string;
  readonly journalKey?: string;
  readonly signal?: AbortSignal;
}

export type AgentResolverValue = unknown;
export type AgentResponseValue = AgentResolverValue | AgentDelayedResponse;
export type AgentResolverIterator = Iterator<
  MaybePromise<AgentResponseValue>,
  MaybePromise<AgentResponseValue>
>;
export type AgentAsyncResolverIterator = AsyncIterator<AgentResponseValue, AgentResponseValue>;
export type AgentResolverReturn =
  | MaybePromise<AgentResponseValue>
  | AgentResolverIterator
  | AgentAsyncResolverIterator;

export type AgentResolver = (info: AgentResolverInfo) => AgentResolverReturn;

export interface AgentHandlerOptions {
  readonly once?: boolean;
}

export class AgentMockError extends Error {
  readonly variant: "error" | "network" | "schema";

  constructor(message: string, variant: "error" | "network" | "schema" = "error") {
    super(message);
    this.name = "AgentMockError";
    this.variant = variant;
  }
}

export interface AgentDelayedResponse {
  readonly type: "agent:delay";
  readonly ms: number;
  readonly response: AgentResponseValue;
}

export type AgentMockEvent =
  | {
      readonly type: "agent:start";
      readonly callIndex: number;
      readonly prompt: string;
      readonly options: AgentOptions;
      readonly agentId?: string;
      readonly journalKey?: string;
    }
  | {
      readonly type: "agent:match";
      readonly callIndex: number;
      readonly handler: string;
    }
  | {
      readonly type: "agent:unhandled";
      readonly callIndex: number;
    }
  | {
      readonly type: "agent:result";
      readonly callIndex: number;
      readonly result: unknown;
    }
  | {
      readonly type: "agent:error";
      readonly callIndex: number;
      readonly error: unknown;
    }
  | {
      readonly type: "agent:end";
      readonly callIndex: number;
    };

export const AgentResponse = {
  text(value: string): string {
    return value;
  },

  json<T>(value: T): T {
    return clone(value);
  },

  error(message: string): AgentMockError {
    return new AgentMockError(message);
  },

  delay(ms: number, response: AgentResponseValue): AgentDelayedResponse {
    return { type: "agent:delay", ms, response };
  },

  networkError(message: string): AgentMockError {
    return new AgentMockError(message, "network");
  },

  schemaError(message: string): AgentMockError {
    return new AgentMockError(message, "schema");
  },
};

function createAnyAgentHandler(): AgentMockHandlerBuilder;
function createAnyAgentHandler(
  resolver: AgentResolver,
  options?: AgentHandlerOptions,
): AgentMockHandler;
function createAnyAgentHandler(
  resolver?: AgentResolver,
  options: AgentHandlerOptions = {},
): AgentMockHandler | AgentMockHandlerBuilder {
  if (resolver === undefined) return new AgentMockHandlerBuilder({});
  return new AgentMockHandler({}, resolver, options);
}

export const agent = {
  call(
    matcher: AgentCallMatcher,
    resolver: AgentResolver,
    options: AgentHandlerOptions = {},
  ): AgentMockHandler {
    return new AgentMockHandler(matcher, resolver, options);
  },

  any: createAnyAgentHandler,

  pending(matcher: AgentCallMatcher = {}, options: AgentHandlerOptions = {}): PendingAgentHandler {
    return new PendingAgentHandler(matcher, options);
  },

  prompt(value: AgentValueMatcher<string>): AgentMockHandlerBuilder {
    return new AgentMockHandlerBuilder({ prompt: value });
  },

  label(value: AgentValueMatcher<string>): AgentMockHandlerBuilder {
    return new AgentMockHandlerBuilder({ label: value });
  },

  phase(value: AgentValueMatcher<string>): AgentMockHandlerBuilder {
    return new AgentMockHandlerBuilder({ phase: value });
  },

  model(value: AgentValueMatcher<string>): AgentMockHandlerBuilder {
    return new AgentMockHandlerBuilder({ model: value });
  },

  agentType(value: AgentValueMatcher<string>): AgentMockHandlerBuilder {
    return new AgentMockHandlerBuilder({ agentType: value });
  },

  schema(value: AgentValueMatcher<unknown>): AgentMockHandlerBuilder {
    return new AgentMockHandlerBuilder({ schema: value });
  },
};

export type AgentReplyResolver<T> = T | ((info: AgentResolverInfo) => AgentResolverReturn);

export class AgentMockHandlerBuilder {
  readonly #matcher: AgentCallMatcher;
  readonly #options: AgentHandlerOptions;

  constructor(matcher: AgentCallMatcher, options: AgentHandlerOptions = {}) {
    this.#matcher = matcher;
    this.#options = options;
  }

  withPrompt(value: AgentValueMatcher<string>): AgentMockHandlerBuilder {
    return this.#with({ prompt: value });
  }

  withLabel(value: AgentValueMatcher<string>): AgentMockHandlerBuilder {
    return this.#with({ label: value });
  }

  withPhase(value: AgentValueMatcher<string>): AgentMockHandlerBuilder {
    return this.#with({ phase: value });
  }

  withModel(value: AgentValueMatcher<string>): AgentMockHandlerBuilder {
    return this.#with({ model: value });
  }

  withAgentType(value: AgentValueMatcher<string>): AgentMockHandlerBuilder {
    return this.#with({ agentType: value });
  }

  withSchema(value: AgentValueMatcher<unknown>): AgentMockHandlerBuilder {
    return this.#with({ schema: value });
  }

  once(): AgentMockHandlerBuilder {
    return new AgentMockHandlerBuilder(this.#matcher, { ...this.#options, once: true });
  }

  replyText(value: AgentReplyResolver<string>): AgentMockHandler {
    return this.replyWith(asResolver(value, AgentResponse.text));
  }

  replyJson<T>(value: AgentReplyResolver<T>): AgentMockHandler {
    return this.replyWith(asResolver(value, AgentResponse.json));
  }

  replyError(message: string | Error): AgentMockHandler {
    const text = message instanceof Error ? message.message : message;
    return this.replyWith(() => AgentResponse.error(text));
  }

  replyWith(resolver: AgentResolver): AgentMockHandler {
    return new AgentMockHandler(
      this.#matcher,
      resolver,
      this.#options,
      formatFluentMatcher(this.#matcher),
    );
  }

  pending(): PendingAgentHandler {
    return new PendingAgentHandler(
      this.#matcher,
      this.#options,
      formatFluentMatcher(this.#matcher),
    );
  }

  #with(matcher: AgentCallMatcher): AgentMockHandlerBuilder {
    return new AgentMockHandlerBuilder({ ...this.#matcher, ...matcher }, this.#options);
  }
}

export class AgentMockHandler {
  readonly #matcher: AgentCallMatcher;
  readonly #resolver: AgentResolver;
  readonly #options: AgentHandlerOptions;
  readonly #header?: string;
  #resolverIterator?: AgentResolverIterator | AgentAsyncResolverIterator;
  #resolverIteratorResult?: AgentResponseValue;
  #isIteratorDone = false;

  isUsed = false;

  constructor(
    matcher: AgentCallMatcher,
    resolver: AgentResolver,
    options: AgentHandlerOptions,
    header?: string,
  ) {
    this.#matcher = matcher;
    this.#resolver = resolver;
    this.#options = options;
    this.#header = header;
  }

  clone(): AgentMockHandler {
    return new AgentMockHandler(this.#matcher, this.#resolver, this.#options, this.#header);
  }

  get header(): string {
    return this.#header ?? formatMatcher(this.#matcher);
  }

  test(prompt: string, options: AgentOptions): boolean {
    if (this.#options.once === true && this.isUsed) return false;
    return matchesCall(this.#matcher, prompt, options);
  }

  async run(info: AgentResolverInfo): Promise<AgentResolverValue> {
    if (this.#options.once === true && this.isUsed) {
      throw new Error(`Agent handler '${this.header}' has already been used.`);
    }

    if (this.#isIteratorDone) return unwrapResponse(this.#resolverIteratorResult);

    this.isUsed = true;

    if (this.#resolverIterator === undefined) {
      const result = await this.#resolver(info);
      if (!isResolverIterator(result)) {
        return await unwrapResponse(result);
      }
      this.#resolverIterator = result;
    }

    this.isUsed = false;
    const next = await this.#resolverIterator.next();
    const value = await next.value;
    if (next.done === true) {
      this.#isIteratorDone = true;
      this.#resolverIteratorResult = value;
      this.isUsed = this.#options.once === true;
    }

    return await unwrapResponse(value);
  }

  reset(): void {
    this.#resolverIterator = undefined;
    this.#resolverIteratorResult = undefined;
    this.#isIteratorDone = false;
    this.isUsed = false;
  }

  restore(): void {
    if (this.#options.once === true) this.reset();
  }
}

/**
 * A handler whose result is controlled by the test rather than a resolver
 * function. Register it like any other handler, then drive timing with
 * `waitUntilStarted()`, `resolve()`, and `reject()`. This replaces the
 * hand-rolled `deferred()` + `agentStarted` boolean pattern in timing tests so
 * even ordering-sensitive cases can stay on the mock boundary.
 */
export class PendingAgentHandler extends AgentMockHandler {
  readonly #matcher: AgentCallMatcher;
  readonly #options: AgentHandlerOptions;
  readonly #header?: string;
  readonly #calls: AgentResolverInfo[] = [];
  readonly #waiting: ControlledDeferred<AgentResolverValue>[] = [];
  readonly #presets: PendingPreset[] = [];
  readonly #started: ControlledDeferred<void> = createControlledDeferred<void>();

  constructor(matcher: AgentCallMatcher, options: AgentHandlerOptions, header?: string) {
    super(matcher, (info) => this.#handleCall(info), options, header);
    this.#matcher = matcher;
    this.#options = options;
    this.#header = header;
  }

  clone(): PendingAgentHandler {
    return new PendingAgentHandler(this.#matcher, this.#options, this.#header);
  }

  get started(): boolean {
    return this.#calls.length > 0;
  }

  get callCount(): number {
    return this.#calls.length;
  }

  get info(): AgentResolverInfo | undefined {
    return this.#calls.at(-1);
  }

  get prompt(): string | undefined {
    return this.info?.prompt;
  }

  waitUntilStarted(): Promise<void> {
    return this.#started.promise;
  }

  resolve(value: AgentResolverValue): void {
    const waiter = this.#waiting.find((entry) => !entry.settled);
    if (waiter) {
      waiter.resolve(value);
      return;
    }
    this.#presets.push({ type: "resolve", value });
  }

  reject(reason: unknown): void {
    const error = typeof reason === "string" ? new AgentMockError(reason) : reason;
    const waiter = this.#waiting.find((entry) => !entry.settled);
    if (waiter) {
      waiter.reject(error);
      return;
    }
    this.#presets.push({ type: "reject", reason: error });
  }

  #handleCall(info: AgentResolverInfo): Promise<AgentResolverValue> {
    this.#calls.push(snapshotResolverInfo(info));
    this.#started.resolve();

    const preset = this.#presets.shift();
    if (preset !== undefined) {
      return preset.type === "resolve"
        ? Promise.resolve(preset.value)
        : Promise.reject(preset.reason);
    }

    const waiter = createControlledDeferred<AgentResolverValue>();
    this.#waiting.push(waiter);
    return waiter.promise;
  }
}

interface AgentMockBoundaryScope {
  initialHandlers: AgentMockHandler[];
  handlers: AgentMockHandler[];
}

export class AgentMockServer {
  #initialHandlers: AgentMockHandler[];
  #onUnhandledAgent: AgentMockUnhandledStrategy;
  #handlers: AgentMockHandler[];
  #calls: AgentMockCall[] = [];
  #events: AgentMockEvent[] = [];
  #isListening: boolean;
  readonly #compatibilityMode: boolean;
  readonly #boundaryStorage = new AsyncLocalStorage<AgentMockBoundaryScope>();

  constructor(
    handlers: AgentMockHandler[],
    options: AgentMockServerOptions = {},
    { compatibilityMode = false }: { readonly compatibilityMode?: boolean } = {},
  ) {
    validateHandlers(handlers, compatibilityMode ? "setupAgentMock" : "setupAgentServer");
    this.#initialHandlers = [...handlers];
    this.#handlers = [...handlers];
    this.#onUnhandledAgent = options.onUnhandledAgent ?? "error";
    this.#isListening = compatibilityMode;
    this.#compatibilityMode = compatibilityMode;
  }

  readonly runner = async (prompt: string, options: AgentOptions = {}): Promise<unknown> => {
    this.#assertListening();
    return await this.#runAgent({ prompt, options });
  };

  readonly schedulerRunner: WorkflowAgentRunner = async (request: WorkflowAgentRunRequest) => {
    this.#assertListening();
    return await this.#runAgent({
      prompt: request.prompt,
      options: request.options,
      agentId: request.agentId,
      journalKey: request.journalKey,
      signal: request.signal,
    });
  };

  listen(options: AgentMockServerOptions = {}): void {
    if (this.#isListening) {
      throw new AgentMockError(
        "Failed to call agents.listen(): agent mock server is already listening.",
      );
    }
    this.#onUnhandledAgent = options.onUnhandledAgent ?? this.#onUnhandledAgent;
    this.#isListening = true;
  }

  close(): void {
    this.#isListening = false;
  }

  async boundary<T>(callback: () => T | Promise<T>): Promise<Awaited<T>> {
    const inheritedHandlers = this.#activeHandlers().map((handler) => handler.clone());
    const scope: AgentMockBoundaryScope = {
      initialHandlers: inheritedHandlers,
      handlers: [...inheritedHandlers],
    };

    return await this.#boundaryStorage.run(scope, async () => await callback());
  }

  use(...handlers: AgentMockHandler[]): void {
    validateHandlers(handlers, "agents.use");
    this.#setActiveHandlers([...handlers, ...this.#activeHandlers()]);
  }

  resetHandlers(...nextHandlers: AgentMockHandler[]): void {
    validateHandlers(nextHandlers, "agents.resetHandlers");
    const scope = this.#activeScope();
    const activeHandlers = this.#activeHandlers();
    for (const handler of activeHandlers) handler.reset();

    if (scope === undefined) {
      if (nextHandlers.length > 0) this.#initialHandlers = [...nextHandlers];
      this.#handlers = [...this.#initialHandlers];
    } else {
      if (nextHandlers.length > 0) scope.initialHandlers = [...nextHandlers];
      scope.handlers = [...scope.initialHandlers];
    }

    this.#calls = [];
    this.#events = [];
  }

  restoreHandlers(): void {
    for (const handler of this.#activeHandlers()) handler.restore();
  }

  listHandlers(): readonly AgentMockHandler[] {
    return [...this.#activeHandlers()];
  }

  printHandlers(): string {
    return this.#activeHandlers()
      .map((handler) => handler.header)
      .join("\n");
  }

  calls(): AgentMockCall[] {
    return this.#calls.map((call) => ({
      ...call,
      options: clone(call.options),
    }));
  }

  events(): AgentMockEvent[] {
    return this.#events.map((event) => clone(event));
  }

  unhandledCalls(): AgentMockCall[] {
    return this.calls().filter((call) => !call.handled);
  }

  expectNoUnhandledAgents(): void {
    const unhandled = this.unhandledCalls();
    if (unhandled.length === 0) return;
    throw new Error(
      `Expected no unhandled agent calls, but found ${unhandled.length}:\n${unhandled
        .map(formatCall)
        .join("\n")}`,
    );
  }

  expectNoAgents(): void {
    if (this.#calls.length === 0) return;
    throw new Error(
      `Expected no agent calls, but found ${this.#calls.length}:\n${this.#calls
        .map(formatCall)
        .join("\n")}`,
    );
  }

  expectAgentCalled(matcher: AgentCallMatcher): void {
    const matched = this.#calls.some((call) => matchesCall(matcher, call.prompt, call.options));
    if (matched) return;
    throw new Error(
      `Expected agent call matching ${formatMatcher(matcher)}, but recorded:\n${this.#calls
        .map(formatCall)
        .join("\n")}`,
    );
  }

  expectAgentCalledTimes(matcher: AgentCallMatcher, times: number): void {
    const count = this.#calls.filter((call) =>
      matchesCall(matcher, call.prompt, call.options),
    ).length;
    if (count === times) return;
    throw new Error(
      `Expected agent call matching ${formatMatcher(matcher)} ${times} time(s), but found ${count}.`,
    );
  }

  expectAgentsInOrder(matchers: readonly AgentCallMatcher[]): void {
    const missingIndex = matchers.findIndex((matcher, index) => {
      const call = this.#calls[index];
      return call === undefined || !matchesCall(matcher, call.prompt, call.options);
    });
    if (missingIndex === -1) return;
    throw new Error(
      `Expected agent call ${missingIndex} to match ${formatMatcher(matchers[missingIndex]!)}, but recorded:\n${this.#calls
        .map(formatCall)
        .join("\n")}`,
    );
  }

  expectAllHandlersUsed(): void {
    const unused = this.#activeHandlers().filter((handler) => !handler.isUsed);
    if (unused.length === 0) return;
    throw new Error(
      `Expected all agent handlers to be used, but found ${unused.length} unused:\n${unused
        .map((handler) => handler.header)
        .join("\n")}`,
    );
  }

  async #runAgent({
    prompt,
    options,
    agentId,
    journalKey,
    signal,
  }: {
    readonly prompt: string;
    readonly options: AgentOptions;
    readonly agentId?: string;
    readonly journalKey?: string;
    readonly signal?: AbortSignal;
  }): Promise<unknown> {
    const callIndex = this.#calls.length;
    const callOptions = clone(options);
    const request = snapshotRequest({ prompt, options: callOptions, agentId, journalKey, signal });
    this.#events.push({
      type: "agent:start",
      callIndex,
      prompt,
      options: clone(callOptions),
      agentId,
      journalKey,
    });
    const handler = this.#activeHandlers().find((candidate) => candidate.test(prompt, callOptions));

    if (handler === undefined) {
      const call = {
        prompt,
        options: callOptions,
        handled: false,
        agentId,
        journalKey,
      } satisfies AgentMockCall;
      this.#calls.push(call);
      this.#events.push({ type: "agent:unhandled", callIndex });
      try {
        const result = this.#handleUnhandledAgent(call);
        this.#events.push({ type: "agent:result", callIndex, result: clone(result) });
        return result;
      } catch (error) {
        this.#events.push({ type: "agent:error", callIndex, error });
        throw error;
      } finally {
        this.#events.push({ type: "agent:end", callIndex });
      }
    }

    this.#calls.push({
      prompt,
      options: callOptions,
      handled: true,
      handler: handler.header,
      agentId,
      journalKey,
    });
    this.#events.push({ type: "agent:match", callIndex, handler: handler.header });
    try {
      const result = await handler.run({
        request,
        prompt,
        options: clone(callOptions),
        signal,
        callIndex,
        agentId,
        journalKey,
      });
      validateAgentResultAgainstSchema(result, callOptions.schema, handler.header);
      this.#events.push({ type: "agent:result", callIndex, result: clone(result) });
      return result;
    } catch (error) {
      this.#events.push({ type: "agent:error", callIndex, error });
      throw error;
    } finally {
      this.#events.push({ type: "agent:end", callIndex });
    }
  }

  #handleUnhandledAgent(call: AgentMockCall): unknown {
    const message = `Unhandled agent call: ${formatCall(call)}`;
    const print: AgentMockUnhandledPrint = {
      warning: () => {
        console.warn(message);
      },
      error: () => {
        throw new Error(message);
      },
      bypass: () => call.prompt,
    };

    if (typeof this.#onUnhandledAgent === "function") {
      return this.#onUnhandledAgent(call, print);
    }
    if (this.#onUnhandledAgent === "error") throw new Error(message);
    if (this.#onUnhandledAgent === "warn") console.warn(message);
    // No real agent backend exists in tests, so "warn" and "bypass" both fall
    // through to echoing the prompt back as the agent's result.
    return call.prompt;
  }

  #activeScope(): AgentMockBoundaryScope | undefined {
    return this.#boundaryStorage.getStore();
  }

  #activeHandlers(): AgentMockHandler[] {
    return this.#activeScope()?.handlers ?? this.#handlers;
  }

  #setActiveHandlers(handlers: AgentMockHandler[]): void {
    const scope = this.#activeScope();
    if (scope === undefined) {
      this.#handlers = handlers;
      return;
    }
    scope.handlers = handlers;
  }

  #assertListening(): void {
    if (this.#isListening) return;
    const hint = this.#compatibilityMode
      ? "The compatibility server was closed; call agents.listen() before using runner."
      : "Call agents.listen() before using runner or schedulerRunner.";
    throw new AgentMockError(`Agent mock server is not listening. ${hint}`);
  }
}

export function setupAgentServer(...handlers: AgentMockHandler[]): AgentMockServer;
export function setupAgentServer(
  ...args: [...AgentMockHandler[], AgentMockServerOptions]
): AgentMockServer;
export function setupAgentServer(
  ...args: Array<AgentMockHandler | AgentMockServerOptions>
): AgentMockServer {
  const { handlers, options } = splitServerArgs(args);
  return new AgentMockServer(handlers, options);
}

export function setupAgentMock(...handlers: AgentMockHandler[]): AgentMockServer;
export function setupAgentMock(
  ...args: [...AgentMockHandler[], AgentMockServerOptions]
): AgentMockServer;
export function setupAgentMock(
  ...args: Array<AgentMockHandler | AgentMockServerOptions>
): AgentMockServer {
  const { handlers, options } = splitServerArgs(args);
  return new AgentMockServer(handlers, options, { compatibilityMode: true });
}

export function setupAgentTestServer(...handlers: AgentMockHandler[]): AgentMockServer;
export function setupAgentTestServer(
  ...args: [...AgentMockHandler[], AgentMockServerOptions]
): AgentMockServer;
export function setupAgentTestServer(
  ...args: Array<AgentMockHandler | AgentMockServerOptions>
): AgentMockServer {
  const { handlers, options } = splitServerArgs(args);
  return setupAgentTestServerFromHandlers(handlers, options);
}

export function setupDefaultAgentTestServer(...handlers: AgentMockHandler[]): AgentMockServer;
export function setupDefaultAgentTestServer(
  ...args: [...AgentMockHandler[], AgentMockServerOptions]
): AgentMockServer;
export function setupDefaultAgentTestServer(
  ...args: Array<AgentMockHandler | AgentMockServerOptions>
): AgentMockServer {
  const { handlers, options } = splitServerArgs(args);
  return setupAgentTestServerFromHandlers([...handlers, defaultAgentMockHandler()], options);
}

export function defaultAgentMockHandler(): AgentMockHandler {
  return agent.any().replyText(({ prompt, options }) => {
    const label = options.label === undefined ? "" : ` label=${JSON.stringify(options.label)}`;
    return `[default mocked agent${label}] ${prompt}`;
  });
}

function setupAgentTestServerFromHandlers(
  handlers: AgentMockHandler[],
  options: AgentMockServerOptions | undefined,
): AgentMockServer {
  const server = new AgentMockServer(handlers, options);

  beforeAll(() => {
    server.listen();
  });
  afterEach(() => {
    server.resetHandlers();
  });
  afterAll(() => {
    server.close();
  });

  return server;
}

function splitServerArgs(args: Array<AgentMockHandler | AgentMockServerOptions>): {
  readonly handlers: AgentMockHandler[];
  readonly options?: AgentMockServerOptions;
} {
  const maybeOptions = args.at(-1);
  const hasOptions = isServerOptions(maybeOptions);
  const handlers = (hasOptions ? args.slice(0, -1) : args) as AgentMockHandler[];
  const options = hasOptions ? maybeOptions : undefined;
  return { handlers, options };
}

function matchesCall(matcher: AgentCallMatcher, prompt: string, options: AgentOptions): boolean {
  return (
    matchesValue(matcher.prompt, prompt) &&
    matchesValue(matcher.label, options.label) &&
    matchesValue(matcher.phase, options.phase) &&
    matchesValue(matcher.agentType, options.agentType) &&
    matchesValue(matcher.model, options.model) &&
    matchesValue(matcher.thinkingLevel, options.thinkingLevel) &&
    matchesValue(matcher.schema, options.schema)
  );
}

function matchesValue<T>(matcher: AgentValueMatcher<T> | undefined, value: T | undefined): boolean {
  if (matcher === undefined) return true;
  if (matcher instanceof RegExp) return typeof value === "string" && matcher.test(value);
  if (typeof matcher === "function") return (matcher as (value: T | undefined) => boolean)(value);
  return deepEqual(matcher, value);
}

function isResolverIterator(
  value: unknown,
): value is AgentResolverIterator | AgentAsyncResolverIterator {
  return (
    typeof value === "object" &&
    value !== null &&
    "next" in value &&
    typeof value.next === "function"
  );
}

async function unwrapResponse(value: AgentResponseValue): Promise<AgentResolverValue> {
  if (isDelayedResponse(value)) {
    await new Promise((resolve) => setTimeout(resolve, value.ms));
    return await unwrapResponse(value.response);
  }
  if (value instanceof AgentMockError) throw value;
  return value;
}

function isDelayedResponse(value: unknown): value is AgentDelayedResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as AgentDelayedResponse).type === "agent:delay" &&
    typeof (value as AgentDelayedResponse).ms === "number"
  );
}

function asResolver<T>(
  value: AgentReplyResolver<T>,
  response: (value: T) => AgentResponseValue,
): AgentResolver {
  if (typeof value === "function") return value as AgentResolver;
  return () => response(value);
}

function isServerOptions(value: unknown): value is AgentMockServerOptions {
  return (
    typeof value === "object" &&
    value !== null &&
    "onUnhandledAgent" in value &&
    (value.onUnhandledAgent === "error" ||
      value.onUnhandledAgent === "warn" ||
      value.onUnhandledAgent === "bypass" ||
      typeof value.onUnhandledAgent === "function")
  );
}

function validateHandlers(handlers: unknown[], apiName: string): void {
  for (const handler of handlers) {
    if (Array.isArray(handler)) {
      throw new TypeError(
        `Failed to call ${apiName} with an array of handlers. Did you forget to spread it?`,
      );
    }
    if (!(handler instanceof AgentMockHandler)) {
      throw new TypeError(`Failed to call ${apiName} with an invalid agent handler.`);
    }
  }
}

function validateAgentResultAgainstSchema(
  result: unknown,
  schema: unknown,
  handlerHeader: string,
): void {
  if (schema === undefined) return;

  const errors = validateJsonSchemaSubset(result, schema, "$");
  if (errors.length === 0) return;

  throw new AgentMockError(
    `Agent response from ${handlerHeader} does not satisfy agent schema:\n${errors.join("\n")}`,
  );
}

function validateJsonSchemaSubset(value: unknown, schema: unknown, path: string): string[] {
  if (!isRecord(schema)) return [];

  const errors: string[] = [];
  const type = schema.type;
  if (typeof type === "string" && !matchesJsonSchemaType(value, type)) {
    errors.push(`${path} expected ${type}, received ${describeJsonValue(value)}`);
    return errors;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => deepEqual(entry, value))) {
    errors.push(
      `${path} expected one of ${formatValue(schema.enum)}, received ${formatValue(value)}`,
    );
  }

  if (isRecord(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !Object.prototype.hasOwnProperty.call(value, key)) {
          errors.push(`${path}.${key} is required`);
        }
      }
    }

    if (isRecord(schema.properties)) {
      for (const [key, propertySchema] of Object.entries(schema.properties)) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          errors.push(...validateJsonSchemaSubset(value[key], propertySchema, `${path}.${key}`));
        }
      }
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    for (const [index, item] of value.entries()) {
      errors.push(...validateJsonSchemaSubset(item, schema.items, `${path}[${index}]`));
    }
  }

  return errors;
}

function matchesJsonSchemaType(value: unknown, type: string): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "null") return value === null;
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "object") return isRecord(value) && !Array.isArray(value);
  return typeof value === type;
}

function describeJsonValue(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => deepEqual(value, right[index]));
  }

  const leftEntries = Object.entries(left as Record<string, unknown>);
  const rightObject = right as Record<string, unknown>;
  if (leftEntries.length !== Object.keys(rightObject).length) return false;
  return leftEntries.every(
    ([key, value]) =>
      Object.prototype.hasOwnProperty.call(rightObject, key) && deepEqual(value, rightObject[key]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return structuredClone(value);
}

function formatMatcher(matcher: AgentCallMatcher): string {
  const parts = Object.entries(matcher).map(([key, value]) => `${key}: ${formatValue(value)}`);
  return parts.length === 0 ? "agent.any" : `agent.call({ ${parts.join(", ")} })`;
}

function formatFluentMatcher(matcher: AgentCallMatcher): string {
  const entries = Object.entries(matcher);
  if (entries.length === 0) return "agent.any()";

  const [firstKey, firstValue] = entries[0]!;
  const first = `agent.${formatFluentMethod(firstKey)}(${formatValue(firstValue)})`;
  const rest = entries
    .slice(1)
    .map(([key, value]) => `.with${capitalize(formatFluentMethod(key))}(${formatValue(value)})`);
  return [first, ...rest].join("");
}

function formatFluentMethod(key: string): string {
  return key;
}

function formatCall(call: AgentMockCall): string {
  const label =
    call.options.label === undefined ? "" : ` label=${JSON.stringify(call.options.label)}`;
  const phase =
    call.options.phase === undefined ? "" : ` phase=${JSON.stringify(call.options.phase)}`;
  const agentType =
    call.options.agentType === undefined
      ? ""
      : ` agentType=${JSON.stringify(call.options.agentType)}`;
  const model =
    call.options.model === undefined ? "" : ` model=${JSON.stringify(call.options.model)}`;
  const thinkingLevel =
    call.options.thinkingLevel === undefined
      ? ""
      : ` thinkingLevel=${JSON.stringify(call.options.thinkingLevel)}`;
  const schema =
    call.options.schema === undefined ? "" : ` schema=${formatValue(call.options.schema)}`;
  return `agent(${JSON.stringify(call.prompt)}${label}${phase}${agentType}${model}${thinkingLevel}${schema})`;
}

function formatValue(value: unknown): string {
  if (value instanceof RegExp) return String(value);
  if (typeof value === "function") return "[predicate]";
  return JSON.stringify(value);
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function snapshotRequest(request: AgentMockRequest): AgentMockRequest {
  return {
    prompt: request.prompt,
    options: clone(request.options),
    agentId: request.agentId,
    journalKey: request.journalKey,
    signal: request.signal,
  };
}

function snapshotResolverInfo(info: AgentResolverInfo): AgentResolverInfo {
  return {
    request: snapshotRequest(info.request),
    prompt: info.prompt,
    options: clone(info.options),
    callIndex: info.callIndex,
    agentId: info.agentId,
    journalKey: info.journalKey,
    signal: info.signal,
  };
}

type MaybePromise<T> = T | Promise<T>;

type PendingPreset =
  | { readonly type: "resolve"; readonly value: AgentResolverValue }
  | { readonly type: "reject"; readonly reason: unknown };

interface ControlledDeferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  readonly settled: boolean;
}

function createControlledDeferred<T>(): ControlledDeferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  const deferred = {
    promise,
    settled: false,
    resolve: (value: T) => {
      if (deferred.settled) return;
      deferred.settled = true;
      resolve(value);
    },
    reject: (reason: unknown) => {
      if (deferred.settled) return;
      deferred.settled = true;
      reject(reason);
    },
  };
  return deferred;
}
