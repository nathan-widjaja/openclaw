---
summary: "Telegram DM live task control: flow handles, waiting states, retries, and interruption behavior"
read_when:
  - You want the Telegram DM task controller behavior
  - You are implementing or debugging flow-first operator state
  - You need the restart and interruption contract for managed DM work
title: "Live Task Control"
---

# Live Task Control

Live Task Control is the foreground controller for **Telegram direct messages**. It replaces the old lane-style "queued behind earlier work" UX with a flow-first model:

- every long-running request gets a stable **flow handle**
- the DM answers immediately, even when work must wait
- `/tasks` and `/status` show **flow state**, not flattened `queued|running`
- operator controls stay in the DM instead of forcing thread-binding commands

The controller is operator-facing. The low-level followup queue still exists underneath it, but it is an internal worker detail.

## Getting started: first Telegram task

<Steps>
  <Step title="Send a normal task in a Telegram DM">
    Ask in plain language, for example: `Reply to these X mentions and keep the browser warm.`
  </Step>

  <Step title="Read the immediate controller reply">
    If the agent can start now, the flow becomes the foreground flow.

    If another flow is already active, OpenClaw replies immediately with a stable flow handle such as `Queued as flow 7c4a1b2e`.

  </Step>

  <Step title="Use /tasks for the control board">
    Run `/tasks` to see:

    - foreground flow
    - browser holder
    - blocked flows
    - waiting flows, with reason and owner
    - recent completions
    - exact next phrases

  </Step>

  <Step title="Steer the flow instead of using /focus">
    Use the flow controls directly in the DM:

    - `continue <flow>`
    - `cancel <flow>`
    - `retry <flow>`
    - `/tasks <flow>`

    `/focus` and `/unfocus` stay reserved for thread/conversation binding and are not part of live task control.

  </Step>
</Steps>

## What `/tasks` means now

`/tasks` is a **flow board** for the current Telegram DM.

- **Foreground flow**: the flow currently holding the conversation
- **Browser holder**: the flow currently holding the warm browser lease
- **Waiting flow**: a flow waiting on either capacity or a browser lease
- **Blocked flow**: a flow that needs user input before it can continue
- **Recent**: recently completed, failed, cancelled, or lost flows

`/tasks <flow>` shows the detail view for one flow, including the current state and the exact next phrases you can send.

## Wait and blocked states

Waiting and blocked messaging is shared across DM replies, `/tasks`, and `/status`.

- `capacity`: another foreground flow is already active
- `browser_lease`: another flow is holding the warm browser/browser-tab state
- `blocked`: the flow needs user input; `blockedSummary` is the user-facing reason

This is why the controller can answer questions like "what is blocking?" immediately instead of repeating a generic queue notice.

## Flow controls

Use these from the same Telegram DM:

- `/tasks`
- `/tasks <flow>`
- `continue <flow>`
- `cancel <flow>`
- `retry <flow>`

Natural-language steering while a foreground flow is active also works for warm-browser cases, for example: `continue replies now while the browser state is warm`.

## Runtime model

Live Task Control is flow-first at the operator surface, but execution still happens underneath the flow:

- default long-running worker runtime is **subagent**
- use **ACP** only when ACP session continuity is actually required
- retries reuse the same managed flow handle whenever the flow continues

## Restart and interruption contract

This is the contract to rely on when operating the controller:

- A queued or waiting request gets one stable managed flow handle.
- `retry <flow>` and `continue <flow>` keep using that handle instead of minting a new operator-visible task id.
- Controller acknowledgements bypass the old queued-followup lifecycle notices. You should not see lane-style "queued behind earlier work" spam for managed Telegram DM flows.
- If the gateway or runtime disappears before the flow finishes, the flow is marked `lost`.
- A `lost` flow does not auto-resume silently. Use `retry <flow>` to restart it explicitly.
- `cancel <flow>` clears queued work for that flow and aborts the foreground run when that flow currently owns the conversation.

## Sub-agents

Live Task Control is compatible with OpenClaw sub-agents:

- use the DM controller as the conversational front door
- let sub-agents handle the slow/background work
- keep `/tasks` as the operator board for the foreground DM

For sub-agent-specific controls and thread binding, see [Sub-Agents](/tools/subagents).
