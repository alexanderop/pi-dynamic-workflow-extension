# Product Plan: Native-Feeling Dynamic Workflows for Pi

## Product intent

Make this extension feel like a first-class dynamic workflow system: users should be able to ask for complex work, have Pi slice it into safe TDD-driven subagent tasks, watch progress natively, resume interrupted runs, save successful harnesses, and finish with a simplification/refactor pass.

The goal is not to copy Claude Code verbatim. The goal is to make Pi's workflow extension feel native to Pi while matching the user expectation set by Claude Code dynamic workflows.

## Success criteria

- Users can trigger workflow mode naturally with phrases like `use a workflow`, `quick workflow`, or `ultracode`.
- Workflow runs are visible, resumable, cancellable, and saveable from `/workflows`.
- Subagents work in vertical TDD slices: red → green → local refactor.
- A final simplifier/refactor agent reviews all changed code after tests pass.
- Saved workflows become reusable slash commands.
- The dashboard explains what is happening without requiring the user to inspect raw JSON.

---

## 1. Native workflow trigger UX

### Why improve it

Today the extension exposes a powerful `workflow` tool, but users need to know that the tool exists and prompt carefully. Native workflow systems feel better because the user can simply say what they want: “use a workflow,” “run a quick workflow,” or “ultracode this.”

This reduces friction and makes workflows feel like a mode, not a hidden implementation detail.

### How to improve it

Add an `input` event handler in `extensions/workflow.ts` that transforms natural trigger phrases into workflow-oriented prompts.

Examples:

- `ultracode improve the workflow dashboard`
- `quick workflow review this PR`
- `use a workflow to rename User to Account everywhere`

The transform should instruct the main agent to:

1. decide whether workflow use is appropriate,
2. generate a deterministic JavaScript workflow,
3. slice the work into subagent tasks,
4. require phases,
5. include test-first instructions for implementation tasks,
6. finish with a simplification/refactor phase.

### Acceptance criteria

- Typing `ultracode <task>` causes the main agent to use the workflow tool unless clearly inappropriate.
- Typing `quick workflow <task>` biases toward fewer agents and lower budget.
- Extension-injected messages are ignored to avoid recursive transforms.
- Existing slash commands still take precedence.

---

## 2. Productized TDD workflow template

### Why improve it

The strongest version of this extension should not merely run many agents in parallel. It should run better engineering loops. For code changes, that means vertical TDD slices: one behavior, one failing test, minimal implementation, then repeat.

A reusable TDD workflow gives the main agent a proven structure instead of forcing it to invent the process every time.

### How to improve it

Ship a saved workflow template called `tdd_improvement_harness.workflow.js`.

The workflow should use these phases:

1. **Product slicing** — identify independently deliverable improvements.
2. **Test planning** — define public behaviors to test for each slice.
3. **TDD implementation** — run one subagent per slice with strict red-green-refactor instructions.
4. **Adversarial verification** — verify tests prove behavior and avoid implementation coupling.
5. **Integration check** — run the relevant project test suite.
6. **Simplify/refactor** — remove duplication, deepen modules, and clean interfaces after green.
7. **Final report** — summarize shipped behavior, tests, risks, and next steps.

Each implementation subagent should receive explicit TDD constraints:

- Write one failing test first.
- Run the test and confirm RED.
- Implement only enough code to pass.
- Run tests and confirm GREEN.
- Refactor only while GREEN.
- Prefer public-interface tests over implementation-detail tests.

### Acceptance criteria

- The template can be selected from a workflow picker or run as `/tdd-improvement-harness` after saving.
- The script calls `phase()` before each major phase.
- The script calls `agent()` at least once.
- Parallel implementation agents receive isolated, complete prompts.
- Final output includes changed files, tests run, risks, and simplification notes.

---

## 3. Task slicing before implementation

### Why improve it

Large “improve everything” prompts fail when the agent tries to hold all goals in one context. Slicing turns an ambiguous product goal into independently testable vertical improvements.

This prevents agentic laziness and makes progress auditable.

### How to improve it

Add a planner subagent that reads the product goal and repository context, then returns structured slices:

```json
{
  "slices": [
    {
      "id": "native-trigger-ux",
      "userValue": "Users can start workflows naturally",
      "filesLikelyTouched": ["extensions/workflow.ts"],
      "publicBehavior": "ultracode prompts are transformed into workflow instructions",
      "testStrategy": "integration-style input transform test"
    }
  ]
}
```

The main workflow then fans out implementation agents from this list.

### Acceptance criteria

- Every implementation task has a user-facing behavior.
- Every slice has a test strategy before code is changed.
- Slices are small enough for one subagent to complete independently.
- The workflow rejects vague slices like “improve code quality” unless tied to observable behavior.

---

## 4. Subagent TDD implementation loop

### Why improve it

Parallel subagents are only useful if they produce trustworthy work. TDD gives each agent a local correctness loop and leaves behind regression protection.

Without this, workflow agents can create broad changes that look plausible but are hard to verify.

### How to improve it

Each implementation subagent should be instructed to produce a concise TDD report:

```md
## Slice
<name>

## RED
- Test added: <file>
- Command run: <command>
- Failure observed: <summary>

## GREEN
- Implementation files: <files>
- Command run: <command>
- Passing result: <summary>

## REFACTOR
- Simplifications made while green
- Tests rerun

## Risks
- Remaining concerns
```

The parent workflow should collect these reports and pass them to verification agents.

### Acceptance criteria

- Each implementation report includes RED evidence and GREEN evidence.
- Each slice has at least one behavior-level test unless explicitly documented as docs-only.
- Agents do not perform speculative changes outside their slice.
- Failed slices are reported rather than hidden.

---

## 5. Adversarial test verification

### Why improve it

A subagent can fool itself. A separate verifier reduces self-preferential bias by checking whether the tests genuinely prove the behavior and whether the implementation is overfit.

This is especially important when multiple agents modify adjacent areas.

### How to improve it

After implementation, spawn verifier agents that review each slice independently.

Verifier rubric:

- Does the test verify public behavior?
- Would the test survive an internal refactor?
- Did the implementation satisfy only the intended slice?
- Are there missing edge cases that matter for user value?
- Did the agent actually run the stated commands?

### Acceptance criteria

- Every code-changing slice receives an independent verification result.
- Verification findings are marked as blocking or non-blocking.
- Blocking findings are either fixed by a follow-up TDD loop or included in final risks.

---

## 6. Final simplify/refactor phase

### Why improve it

Parallel implementation can leave seams: duplicated helpers, inconsistent naming, unnecessary abstractions, and overly broad interfaces. A final simplification phase makes the result feel intentionally designed rather than stitched together.

This is the “make it native” polish pass.

### How to improve it

After all tests are green, run a simplifier agent with this mandate:

- Do not add features.
- Do not weaken tests.
- Prefer deleting code over adding abstractions.
- Consolidate duplicated formatting, workflow prompts, or state transitions.
- Deepen modules where a small public interface can hide complexity.
- Rerun the full relevant test suite after each refactor step.

### Acceptance criteria

- Simplifier only runs after implementation tests are green.
- Any refactor is covered by existing tests.
- Final code has fewer duplicated concepts or clearer module boundaries.
- Final report lists what was simplified and why.

---

## 7. Dashboard save/rerun controls

### Why improve it

Native workflow systems make successful workflows reusable. Our extension already supports `/workflow-save`, but users should not have to memorize a command while looking at a dashboard.

### How to improve it

Enhance `/workflows` keyboard controls:

- `s` save selected workflow as a command.
- `r` rerun selected workflow.
- `R` resume interrupted workflow.
- `o` open/copy saved script path.
- `d` delete saved workflow after confirmation.

The UI should show saved status:

```text
Saved as /tdd-improvement-harness · ~/.pi/agent/workflows/tdd-improvement-harness.workflow.js
```

### Acceptance criteria

- Users can save from the dashboard without leaving it.
- Saved workflows appear as slash commands after reload or immediate registration.
- Save collisions are handled clearly.
- Rerun starts a fresh job with the same script and optional new args.

---

## 8. Resume and interruption recovery

### Why improve it

Long workflows are valuable but vulnerable to terminal exits, aborts, and restarts. Native workflow systems feel reliable because interrupted runs are visible and resumable.

### How to improve it

On session start:

- load `.pi/workflows` manifests,
- detect interrupted jobs,
- show a status widget or notification,
- allow one-key resume from `/workflows`.

Resume should reuse the journal so completed subagent calls are cached and not repeated unnecessarily.

### Acceptance criteria

- Interrupted workflows appear in `/workflows` after restart.
- Resume continues with cached completed agents when possible.
- Completion notifications are not duplicated after resume.
- Users can distinguish cancelled, interrupted, failed, and completed runs.

---

## 9. Model and isolation routing

### Why improve it

A native workflow harness should choose the right execution mode for the task. Some agents only need cheap reasoning. Others need stronger models or filesystem isolation.

The workflow API already accepts `model` and `isolation` hints, but those hints should become real behavior.

### How to improve it

Support:

```js
await agent("Implement this slice", {
  label: "native trigger implementation",
  model: "sonnet",
  isolation: "worktree"
})
```

Implementation direction:

- pass model hints into subagent session creation where Pi supports it,
- implement `isolation: "memory"` as current behavior,
- implement `isolation: "worktree"` for mutating tasks,
- record model and isolation in workflow snapshots.

### Acceptance criteria

- Dashboard shows requested/actual model when available.
- Worktree-isolated agents cannot silently overwrite each other.
- Final integration phase reconciles worktree changes intentionally.
- Unsupported model/isolation options fail clearly or degrade with a warning.

---

## 10. Budget and concurrency controls

### Why improve it

Workflows can spend many tokens and spawn many agents. Users need predictable controls so workflow mode feels powerful but safe.

### How to improve it

Expose budget and concurrency in both prompt UX and workflow API:

- `quick workflow` uses a smaller default budget.
- `ultracode` uses a larger default budget.
- Dashboard shows budget usage.
- Workflow scripts can check `budget.remaining`.

Example user prompt:

```text
ultracode this with 40k tokens and max 4 agents in parallel
```

### Acceptance criteria

- Users can set budget in natural language or tool args.
- Workflow stops before exceeding configured budget.
- Dashboard displays estimated usage.
- Parallelism defaults are safe for local machines.

---

## 11. Human-in-the-loop rubric prompts

### Why improve it

Many workflows need user judgment: ranking candidates, selecting a design direction, defining severity, or approving a migration boundary. Native systems ask at the right moment instead of guessing.

### How to improve it

Add workflow-safe user interaction helpers:

```js
const rubric = await askUser("What matters most for this review?")
const choice = await selectUser("Which approach should win?", options)
```

These helpers should delegate to Pi extension UI, not run inside the VM directly.

### Acceptance criteria

- Workflow can pause for a user answer.
- The dashboard shows that the workflow is waiting for input.
- User answers are captured in the workflow report.
- Non-interactive mode fails with a clear message or uses provided args.

---

## 12. Security and quarantine mode

### Why improve it

Workflows often process untrusted content: issues, resumes, logs, Slack exports, or support tickets. Reader agents should not automatically get write or shell powers.

A native workflow system should make safe patterns easy.

### How to improve it

Support agent trust/tool modes:

```js
await agent("Classify these public bug reports", {
  label: "untrusted triage reader",
  trust: "untrusted",
  tools: "readOnly"
})
```

Then separate reader agents from actor agents.

### Acceptance criteria

- Read-only agents cannot write files or execute risky shell commands.
- Prompts explain quarantine boundaries.
- Actor agents receive sanitized findings, not raw untrusted instructions when possible.
- The final report identifies which agents handled untrusted content.

---

## Proposed reusable workflow script

This is the target workflow shape the extension should make easy to generate and save. It is intentionally a template: the main agent should adapt file paths, test commands, and slice count to the actual task.

```js
export const meta = {
  name: 'tdd_improvement_harness',
  description: 'Slice a product improvement into TDD subagent tasks, verify them, then simplify after green.',
  phases: [
    { title: 'Product slicing' },
    { title: 'TDD implementation' },
    { title: 'Adversarial verification' },
    { title: 'Integration check' },
    { title: 'Simplify and refactor' },
    { title: 'Final report' }
  ]
}

phase('Product slicing')
const plan = await agent(`
Act as a product-minded technical lead.

Task:
${args?.task ?? args ?? 'Improve the workflow extension so it feels native.'}

Inspect the repository and produce 3-7 vertical slices. Each slice must have:
- id
- user value
- public behavior to test
- likely files
- test strategy
- risk level

Prefer small independently shippable improvements. Do not propose vague cleanup slices.
Return JSON-like markdown that another agent can follow.
`, { label: 'product slicer' })

phase('TDD implementation')
const implementationReports = await parallel([
  () => agent(`
Use TDD for the highest-priority slice from this plan:

${plan}

Rules:
- Pick one slice only.
- Write one behavior-level failing test first.
- Run the test and capture RED evidence.
- Implement the minimum code to pass.
- Run tests and capture GREEN evidence.
- Refactor only while green.
- Do not work on unrelated slices.

Return a TDD report with RED, GREEN, REFACTOR, files changed, commands run, and risks.
`, { label: 'tdd slice 1' }),
  () => agent(`
Use TDD for a different high-priority slice from this plan:

${plan}

Rules:
- Pick one slice not chosen by slice 1 if possible.
- Write one behavior-level failing test first.
- Run the test and capture RED evidence.
- Implement the minimum code to pass.
- Run tests and capture GREEN evidence.
- Refactor only while green.
- Do not work on unrelated slices.

Return a TDD report with RED, GREEN, REFACTOR, files changed, commands run, and risks.
`, { label: 'tdd slice 2' }),
  () => agent(`
Use TDD for a third independently shippable slice from this plan:

${plan}

Rules:
- Pick one slice not chosen by other agents if possible.
- Write one behavior-level failing test first.
- Run the test and capture RED evidence.
- Implement the minimum code to pass.
- Run tests and capture GREEN evidence.
- Refactor only while green.
- Do not work on unrelated slices.

Return a TDD report with RED, GREEN, REFACTOR, files changed, commands run, and risks.
`, { label: 'tdd slice 3' })
])

phase('Adversarial verification')
const verificationReports = await parallel(implementationReports.map((report, index) => () => agent(`
Adversarially verify this TDD implementation report:

${report}

Rubric:
- Did the test verify public behavior rather than implementation details?
- Was RED evidence real and specific?
- Was GREEN evidence real and specific?
- Did the implementation stay within slice scope?
- Are there blocking issues before integration?

Return: PASS, PASS_WITH_NOTES, or BLOCKED, with reasons.
`, { label: `verifier ${index + 1}` })))

phase('Integration check')
const integration = await agent(`
Run the relevant full validation for the repository after these TDD slices:

Implementation reports:
${implementationReports.join('\n\n---\n\n')}

Verification reports:
${verificationReports.join('\n\n---\n\n')}

Run lint/build/tests as appropriate. Fix only integration breakages caused by the slices.
Return commands run, results, fixes made, and remaining risks.
`, { label: 'integration checker' })

phase('Simplify and refactor')
const simplification = await agent(`
The implementation is now expected to be green. Perform a final simplification pass.

Constraints:
- Do not add features.
- Do not weaken or delete useful tests.
- Prefer deleting duplication and clarifying interfaces.
- Refactor only while tests are green.
- Rerun relevant tests after each meaningful refactor.

Inputs:
Plan:
${plan}

Implementation reports:
${implementationReports.join('\n\n---\n\n')}

Integration:
${integration}

Return what you simplified, why it improves maintainability, commands run, and risks.
`, { label: 'simplifier' })

phase('Final report')
const finalReport = await agent(`
Create a concise product-owner final report for the user.

Include:
- What improved and why it matters
- Which slices shipped
- Tests/commands run
- Verification status
- Simplifications performed
- Risks or follow-up issues

Inputs:
Plan:
${plan}

Implementation reports:
${implementationReports.join('\n\n---\n\n')}

Verification:
${verificationReports.join('\n\n---\n\n')}

Integration:
${integration}

Simplification:
${simplification}
`, { label: 'final reporter' })

return {
  plan,
  implementationReports,
  verificationReports,
  integration,
  simplification,
  finalReport
}
```

---

## Recommended delivery order

1. Add native trigger UX.
2. Add bundled TDD workflow template.
3. Add save/rerun controls in `/workflows`.
4. Improve interrupted workflow resume UX.
5. Add richer dashboard data.
6. Add model/isolation routing.
7. Add human-in-the-loop workflow helpers.
8. Add quarantine/read-only agent modes.

This sequence gives users the native feeling early, then makes the system more powerful and safer over time.
