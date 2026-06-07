import { describe, expect, it } from "vitest";
import {
  agentTransitions,
  canTransitionAgent,
  canTransitionRun,
  isTerminalAgentState,
  isTerminalRunStatus,
  replayAgentEvents,
  replayRunEvents,
  runTransitions,
  transitionAgent,
  transitionRun,
} from "#src/workflows/run/state-machine.ts";
import type { WorkflowAgentEvent, WorkflowRunEvent } from "#src/workflows/run/state-machine.ts";
import type { WorkflowAgentProgress } from "#src/workflows/agent/model.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";

/**
 * These tests don't assert hand-picked paths. Instead they derive coverage from
 * the transition tables themselves — the hand-rolled equivalent of XState's
 * `getAdjacencyMap` / `getShortestPaths` graph utilities. Add a state or edge to
 * the table and these invariants automatically extend to it.
 */

type Table = Readonly<Record<string, Readonly<Partial<Record<string, string>>>>>;

interface Edge {
  readonly from: string;
  readonly event: string;
  readonly to: string;
}

function states(table: Table): string[] {
  return Object.keys(table);
}

function edges(table: Table): Edge[] {
  return states(table).flatMap((from) =>
    Object.entries(table[from] ?? {}).map(([event, to]) => ({ from, event, to: to as string })),
  );
}

function outgoing(table: Table, from: string): Edge[] {
  return Object.entries(table[from] ?? {}).map(([event, to]) => ({
    from,
    event,
    to: to as string,
  }));
}

/** BFS over the table following edges — the adjacency-map reachability walk. */
function reachableFrom(table: Table, initial: string): Set<string> {
  const seen = new Set<string>([initial]);
  const queue = [initial];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of outgoing(table, current)) {
      if (!seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return seen;
}

function terminalStates(table: Table): string[] {
  return states(table).filter((state) => outgoing(table, state).length === 0);
}

/** Can `from` reach any state with no outgoing edges? BFS until a terminal. */
function canReachTerminal(table: Table, from: string): boolean {
  const terminals = new Set(terminalStates(table));
  for (const state of reachableFrom(table, from)) {
    if (terminals.has(state)) return true;
  }
  return false;
}

/**
 * Enumerate simple paths (no repeated state) from `initial`. The run machine has
 * cycles (running → pausing → paused → resuming → running); refusing to revisit a
 * state on the current path keeps enumeration finite while still covering every
 * acyclic route to a terminal.
 */
function enumerateSimplePaths(table: Table, initial: string): string[][] {
  const paths: string[][] = [];
  const walk = (state: string, eventsSoFar: string[], visited: Set<string>): void => {
    const next = outgoing(table, state).filter((edge) => !visited.has(edge.to));
    if (next.length === 0) {
      paths.push(eventsSoFar);
      return;
    }
    for (const edge of next) {
      walk(edge.to, [...eventsSoFar, edge.event], new Set([...visited, edge.to]));
    }
  };
  walk(initial, [], new Set([initial]));
  return paths;
}

// String-indexable views: the production tables are exhaustively typed over
// their state/event unions and reject plain `string` indexing (the safety we
// just added), so the generic graph helpers read them through this alias.
const runTable: Table = runTransitions;
const agentTable: Table = agentTransitions;

const RUN_STATES = states(runTable);
const RUN_EVENT_TYPES = [...new Set(edges(runTable).map((edge) => edge.event))];
const AGENT_STATES = states(agentTable);
const AGENT_EVENT_TYPES = [...new Set(edges(agentTable).map((edge) => edge.event))];

function runEvent(type: string): WorkflowRunEvent {
  switch (type) {
    case "run_fail_requested":
    case "run_failed":
      return { type, now: 100, failure: { scope: "run", message: "boom" } } as WorkflowRunEvent;
    default:
      return { type, now: 100 } as WorkflowRunEvent;
  }
}

function agentEvent(type: string): WorkflowAgentEvent {
  if (type === "agent_restarted") {
    return { type, now: 100, agentId: "agent_next" } as WorkflowAgentEvent;
  }
  return { type, now: 100 } as WorkflowAgentEvent;
}

function runStateAt(status: string): WorkflowRunState {
  return {
    runId: "wf_test",
    taskId: "task_test",
    workflowName: "test-workflow",
    status: status as WorkflowRunState["status"],
    script: "return null;",
    scriptPath: "/tmp/wf_test/script.js",
    phases: [],
    logs: [],
    workflowProgress: [],
    agentCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    startTime: 50,
  };
}

function okValue<T>(result: { status: "ok"; value: T } | { status: "error"; error: unknown }): T {
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error("expected an ok Result");
  return result.value;
}

function agentStateAt(state: string): WorkflowAgentProgress {
  return {
    type: "workflow_agent",
    index: 0,
    label: "scan",
    agentId: "agent_test",
    agentType: "general-purpose",
    model: "default",
    state: state as WorkflowAgentProgress["state"],
    queuedAt: 50,
    attempt: 1,
    promptPreview: "Scan the repo",
  };
}

describe("run transition graph", () => {
  it("should declare an entry for every status in the union (no orphaned states)", () => {
    // The type already forces this; the runtime check guards against `as` casts.
    expect(RUN_STATES).toEqual(
      expect.arrayContaining([
        "created",
        "starting",
        "running",
        "pausing",
        "paused",
        "resuming",
        "completing",
        "completed",
        "failing",
        "failed",
        "stopping",
        "stopped",
      ]),
    );
  });

  it("should reach every state from the initial 'created' state", () => {
    const reachable = reachableFrom(runTable, "created");
    for (const state of RUN_STATES) {
      expect(reachable, `state '${state}' is unreachable from 'created'`).toContain(state);
    }
  });

  it("should reach a terminal from every non-terminal state (no dead ends)", () => {
    for (const state of RUN_STATES) {
      if (isTerminalRunStatus(state as WorkflowRunState["status"])) continue;
      expect(canReachTerminal(runTable, state), `'${state}' cannot reach a terminal`).toBe(true);
    }
  });

  it("should keep the table's terminal states in sync with isTerminalRunStatus", () => {
    const tableTerminals = new Set(terminalStates(runTable));
    for (const state of RUN_STATES) {
      expect(
        tableTerminals.has(state),
        `terminal mismatch for '${state}' between table and isTerminalRunStatus`,
      ).toBe(isTerminalRunStatus(state as WorkflowRunState["status"]));
    }
  });

  it("should apply every declared edge without error and land on the declared target", () => {
    for (const edge of edges(runTable)) {
      const value = okValue(transitionRun(runStateAt(edge.from), runEvent(edge.event)));
      expect(value.status, `${edge.from} --${edge.event}--> ${edge.to}`).toBe(edge.to);
    }
  });

  it("should reject every (state, event) pair absent from the table", () => {
    for (const from of RUN_STATES) {
      for (const eventType of RUN_EVENT_TYPES) {
        const declared = eventType in (runTable[from] ?? {});
        if (declared) continue;
        const state = runStateAt(from);
        const event = runEvent(eventType);
        expect(canTransitionRun(state, event)).toBe(false);
        expect(transitionRun(state, event)).toMatchObject({ status: "error" });
      }
    }
  });

  it("should replay every simple path identically to a step-by-step fold", () => {
    const paths = enumerateSimplePaths(runTable, "created");
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const events = path.map(runEvent);
      const replayed = okValue(replayRunEvents(runStateAt("created"), events));

      let folded = runStateAt("created");
      for (const event of events) {
        folded = okValue(transitionRun(folded, event));
      }
      expect(replayed, `path [${path.join(", ")}] diverged from step-by-step fold`).toEqual(folded);
    }
  });
});

describe("agent transition graph", () => {
  it("should reach every state from the initial 'queued' state", () => {
    const reachable = reachableFrom(agentTable, "queued");
    for (const state of AGENT_STATES) {
      expect(reachable, `state '${state}' is unreachable from 'queued'`).toContain(state);
    }
  });

  it("should keep the table's terminal states in sync with isTerminalAgentState", () => {
    // failed/stopped restart back to queued, so they have outgoing edges and are
    // not graph-terminal even though isTerminalAgentState treats them as terminal.
    const graphTerminals = new Set(terminalStates(agentTable));
    expect(graphTerminals).toEqual(new Set(["done"]));
    expect(isTerminalAgentState("done")).toBe(true);
    expect(isTerminalAgentState("failed")).toBe(true);
    expect(isTerminalAgentState("stopped")).toBe(true);
  });

  it("should apply every declared edge without error and land on the declared target", () => {
    for (const edge of edges(agentTable)) {
      const value = okValue(transitionAgent(agentStateAt(edge.from), agentEvent(edge.event)));
      expect(value.state, `${edge.from} --${edge.event}--> ${edge.to}`).toBe(edge.to);
    }
  });

  it("should reject every (state, event) pair absent from the table", () => {
    for (const from of AGENT_STATES) {
      for (const eventType of AGENT_EVENT_TYPES) {
        if (eventType in (agentTable[from] ?? {})) continue;
        const agent = agentStateAt(from);
        const event = agentEvent(eventType);
        expect(canTransitionAgent(agent, event)).toBe(false);
        expect(transitionAgent(agent, event)).toMatchObject({ status: "error" });
      }
    }
  });

  it("should replay every simple path identically to a step-by-step fold", () => {
    const paths = enumerateSimplePaths(agentTable, "queued");
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const events = path.map(agentEvent);
      const replayed = okValue(replayAgentEvents(agentStateAt("queued"), events));

      let folded = agentStateAt("queued");
      for (const event of events) {
        folded = okValue(transitionAgent(folded, event));
      }
      expect(replayed, `path [${path.join(", ")}] diverged from step-by-step fold`).toEqual(folded);
    }
  });
});
