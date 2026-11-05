# Marcos Offices

A pixel-art office for monitoring, managing and commanding your local Claude agents.

Your agents are staff. They sit at desks, in departments, under supervisors, with a
CEO at the top — and above the CEO, you: **Lord Marcos**, whose sanction is required
for anything that matters.

```
npx marcosoffices
```

That is the whole install. A local server starts, your browser opens, and the office
is in session.

---

## What it does

- **Watches every agent.** Agents the office employs are spawned and driven by it
  directly. Claude sessions you started yourself in a terminal show up too, as
  *visitors* — watched, never commanded.
- **Gives every agent its own context,** layered: the office charter → their
  department's context → standing orders inherited from each supervisor above them →
  their own role → their private memory.
- **Puts you in the approval chain.** Every tool call and every proposal can be routed
  to the CEO (who rules on it automatically, and may escalate) or straight to you.
  Nothing important happens without sanction.
- **Lets agents talk to each other.** Internal mail, within a department and across
  departments. A message to someone on duty is placed in front of them immediately.
- **Gives agents a memory** they manage themselves and that survives between sessions.
- **Hands out skills and MCP servers** per agent, toggled individually.
- **Puts agents on shift.** A standing task they pick up on an interval, like a real
  employee — or call them on demand.

---

## The office

Departments are rooms on a tile grid; each has a seat count, its own decor, and its
own context inherited by everyone who serves there. Agents sit at desks with a status
bubble over their head:

| Bubble | Meaning |
| --- | --- |
| `⋯` green | working |
| `!` amber | stopped, awaiting your word |
| `z` blue | idle at their desk |
| `✕` red | in trouble |
| *(none)* | off duty |

Drag to pan, scroll to zoom, click an agent to open their panel. Every sprite is drawn
in code from a hash of the agent's id — there are no image files, and each member of
staff looks like themselves permanently.

---

## Architecture

One runtime dependency that matters: the Claude Agent SDK.

```
src/
  cli.js                 npx entry point
  server/
    server.js            HTTP + JSON API + SSE event stream
    store.js             the whole office, one atomic JSON document
    runtime.js           one long-lived SDK session per employed agent
    persona.js           composes the context hierarchy into a system prompt
    office-tools.js      in-process MCP server: the agents' own instruments
    approvals.js         the sanction pipeline (CEO -> Lord Marcos)
    discovery.js         external sessions, auth, skills, MCP servers
    scheduler.js         standing shifts
    bus.js               pub/sub -> SSE
public/
  js/sprites.js          every pixel, drawn procedurally
  js/office.js           the map: camera, rendering, hit-testing
  js/app.js              panels and wiring
```

- **No build step.** The browser loads the ES modules as written.
- **No frontend framework.** Vanilla JS and a Canvas 2D tile renderer.
- **No WebSocket dependency.** Live updates ride on Server-Sent Events.
- **State** lives in `~/.marcosoffices/` — `office.json`, plus a memory file and an
  activity log per agent.

### The agents' own instruments

Every agent gets an in-process MCP server, `mcp__office__*`:

| Tool | What it does |
| --- | --- |
| `send_message` | write to a colleague, in any department |
| `check_inbox` | read what colleagues have sent |
| `request_approval` | submit a decision — **blocks** until a verdict comes back |
| `remember` / `recall` | their private, persistent memory |
| `roster` | who works here and what they do |
| `petition_lord` | send word directly to you |

### The management instruments

Agents flagged **may manage the office** get a second toolset, `mcp__hq__*` — the
office can run itself. Ask the Chief of Staff how the company is doing and they
answer from the instruments, not from memory:

| Tool | What it does |
| --- | --- |
| `office_report` | the whole company: departments, staff, spend, projects, outstanding business |
| `staff_ledger` | what each agent has cost, their share of the budget, cost per task |
| `project_status` | how a project stands, who is posted to it, what the directory holds |
| `describe_staff` | one agent in full — context, permissions, chain of command |
| `propose_hire` | engage someone new for a task or project |
| `propose_department` | open a department |
| `propose_reassignment` | move someone between projects, departments or supervisors |
| `propose_shift` | put someone on a standing shift, or take them off |
| `propose_dismissal` | let someone go — grave, always goes to you |

Every `propose_` instrument raises an approval and **blocks until it is answered**.
An agent may propose to hire; it may not hire unsanctioned.

Cost is recorded per agent as each task completes, so "is anyone consuming too much"
is a question the office can actually answer. Their standing instruction is to weigh
cost against what was delivered, and to say which they mean.

### How the approval gate actually works

This is the one genuinely subtle thing in the codebase, and it is worth knowing before
you change it.

`canUseTool` is **not** sufficient to gate an agent. Claude Code consults the user's own
permission rules (`~/.claude/settings.json`) *first*, and anything already allowlisted
there never reaches the callback — so an office policy of "the Lord sanctions every
tool" would silently do nothing on a machine with a permissive allowlist.

The office therefore gates with a **`PreToolUse` hook**, which fires for every tool call
before permission rules are consulted. `canUseTool` is kept only as a second line of
defence.

Three things are exempt, deliberately:

- `mcp__office__*` — gating `request_approval` behind an approval would deadlock the
  agent against itself.
- `mcp__hq__*` — the mutating ones already raise their own proposal, so gating them
  here would ask you twice for the same change.
- `ToolSearch` and `TodoWrite` — they reach nothing outside the session, and asking
  you to sanction them spends your attention for nothing.

---

## Configuration per agent

Each agent carries its own: model and effort, `permissionMode`, allowed and disallowed
tools, enabled skills, enabled MCP servers, assigned project (its working directory),
supervisor, department, memory on/off, and a standing shift.

Two separate approval policies:

- **who sanctions their tools** — nobody / the CEO / you
- **who sanctions their decisions** — nobody / the CEO / you

The CEO cannot sanction their own work; it goes to you. Anything an agent marks `grave`
goes to you regardless.

---

## Projects

A project is a directory on this machine. Staff posted to one work there — it becomes
their session's working directory. They may still read elsewhere when the work
genuinely requires it.

---

## Staffing a new office

A fresh office opens with nothing but a CEO. **Staff → "Staff the office"** opens three
departments, each with its own context and staff:

- **Operations** — Prefect (Chief of Staff) and Ledger (Accountant), both holding the
  management instruments. This is who you ask about the company itself.
- **Engineering** — Vulcan (Principal), Faber (Build), Tessera (Quality).
- **Research** — Minerva (Head of Research), Quill (Analyst).

It is additive and idempotent by name: anything already there is left alone.

## Requirements

- Node 20+
- Claude Code installed and signed in (`claude auth login`). The office reads your
  existing login; it never asks for credentials itself. The Office panel shows your
  status and can open a terminal for you.

---

## Roadmap

The first release is deliberately an MVP. Still to come:

- Drag-and-drop seating and department placement on the map
- Richer agent-to-agent protocols (delegation, hand-back, shared goals)
- Walking animation and pathfinding between desks
- A department-level view with its own context editor inline on the map
- Per-agent cost and token accounting

---

## Licence

MIT
