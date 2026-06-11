export const meta = {
  name: "hello-workflow",
  description: "Run a tiny one-agent dynamic workflow smoke test.",
  whenToUse: "Verify that the Pi dynamic workflow extension is installed and can launch a background subagent.",
  phases: [
    {
      title: "Greet",
      detail: "Ask one subagent for a short success greeting.",
      agentCount: 1,
      agents: [{ label: "greet:hello" }],
    },
  ],
};

phase("Greet");

const topic =
  typeof args === "string" && args.trim().length > 0
    ? args.trim()
    : "the Pi dynamic workflow extension";

const greeting = await agent(
  `Write a concise, friendly one-paragraph greeting that confirms this dynamic workflow demo ran successfully. Topic: ${topic}`,
  {
    label: "greet:hello",
    phase: "Greet",
    thinkingLevel: "minimal",
  },
);

return {
  ok: greeting !== null,
  greeting,
};
