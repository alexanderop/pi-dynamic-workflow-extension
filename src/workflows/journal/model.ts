// Journal event and key types; the deterministic key is computed in key.ts.
export type WorkflowJournalKey = `v2:${string}`;

export type WorkflowJournalEvent =
  | WorkflowJournalStartedEvent
  | WorkflowJournalResultEvent
  | WorkflowJournalFailedEvent
  | WorkflowJournalStoppedEvent
  | WorkflowJournalInvalidatedEvent;

export interface WorkflowJournalStartedEvent {
  readonly type: "started";
  readonly key: WorkflowJournalKey;
  readonly agentId: string;
}

export interface WorkflowJournalResultEvent {
  readonly type: "result";
  readonly key: WorkflowJournalKey;
  readonly agentId: string;
  readonly result: unknown;
}

export interface WorkflowJournalFailedEvent {
  readonly type: "failed";
  readonly key: WorkflowJournalKey;
  readonly agentId: string;
  readonly error: {
    readonly message: string;
    readonly name?: string;
    readonly stack?: string;
  };
}

export interface WorkflowJournalStoppedEvent {
  readonly type: "stopped";
  readonly key: WorkflowJournalKey;
  readonly agentId: string;
  readonly reason?: string;
}

export interface WorkflowJournalInvalidatedEvent {
  readonly type: "invalidated";
  readonly key: WorkflowJournalKey;
  readonly previousAgentId: string;
  readonly reason: "restart-agent";
  readonly at: number;
}

export interface WorkflowAgentKeyInput {
  readonly prompt: string;
  readonly schema?: unknown;
  readonly label?: string;
  readonly phase?: string;
  readonly agentType: string;
  readonly model: string;
  readonly thinkingLevel?: string;
  readonly cwd: string;
}

export interface WorkflowAgentJournal {
  append(event: WorkflowJournalEvent): Promise<void>;
}
