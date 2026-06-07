# ADR 0006: Use a Terminal Notification Hook Before Pi Message Wiring

Status: accepted

## Context

`spec.md` requires every terminal workflow run to notify the main conversation and
point at the full output file. Pi documents `pi.sendMessage()` for injecting
custom displayable messages, while `pi.sendUserMessage()` sends an actual user
turn and triggers the agent.

The current launcher is still a pure workflow module using fake agents. Wiring it
directly to Pi session APIs would make filesystem integration tests depend on a
live extension runtime before the fake vertical slice is complete.

## Decision

Expose a `notifyTerminal` launch hook as the first notification dispatcher seam.
The launcher writes `output.json`, persists the terminal `manifest.json` with
`outputPath`, and only then calls `notifyTerminal` with a
`workflow-task-notification` payload.

The payload carries both XML `content` matching the task-notification contract and
structured `details` for future Pi integration. When the extension runtime wires
this into Pi, prefer `pi.sendMessage()` with the custom notification payload over
`pi.sendUserMessage()`, because terminal workflow notifications should be status
messages rather than new user prompts.

## Consequences

- Tests can assert notification ordering and payload shape without a live Pi
  session.
- The fake launcher already satisfies the output-file and notification contract
  at the module boundary.
- Real Pi message injection and custom rendering remain a later extension
  integration slice.
- Notification callback failures surface as background errors after terminal
  artifacts are already persisted.
