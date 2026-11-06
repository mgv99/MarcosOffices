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

Two views of the same company, switched at the top left:

- **Office** — the floor plan. The CEO has a one-desk suite centred above the floor;
  the departments sit in rows of three beneath it.
- **Hierarchy** — the chain of command as an org chart, the CEO at the top and each
  agent hanging under their supervisor. Cards are tinted with their department's
  colour, so the two readings of the office agree rather than compete.

Departments are rooms on a tile grid; each has a seat count, its own decor, and its
own context inherited by everyone who serves there.

Each department has a **head of department**, who sits alone at the desk at the front
of the room. The head answers to the CEO; everyone else in the department answers to
the head. Behind them, staff fill rows of four.

Agents sit at desks with a status bubble over their head:

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

### The three desks at the top

- **Sanctions** — everything waiting on your word, with **Sanction all** for the
  routine ones. Questions are never swept up by it: they need a real answer.
- **Inbox** — what the staff have written to *you*. Reports, petitions, findings.
  Reply to the sender, pass it on to someone else, or **Archive** it. **Archive all**
  clears the lot in one stroke, and **Archive (n)** switches to what you have filed
  away, where anything can be taken back out. Archiving is your own filing and
  nothing more: the message stays in the record, the agent keeps their copy, and
  they are never told.
- **Dispatches** — the office's event log: tasks that finished, shifts that ran on
  their own, agents that failed. Things that happened while you were looking
  elsewhere. Click one to go to the agent it concerns.

Every pending item carries an **→ Open chat** button, and toasts in the bottom-left
take you to the agent they name.

### Watching an agent

Each agent has five tabs, and the first two are deliberately different things:

- **Orders** — the full terminal, as the CLI shows it: your orders, their prose, every
  tool call with its arguments, and what each one returned. Long output and tool
  arguments fold away; markdown is rendered.
- **Activity** — the milestone view: their current plan, which steps are done, and the
  notable events (leave requested, task finished, failures). No raw tool traffic.
- **Mail** — everything they have received and sent, with the same archiving as your
  own inbox: file a letter out of your view per message, or sweep a whole section
  with **Archive all**. The agent still has it — archiving hides a letter from you,
  not from them.
- **Configuration** — model, permissions, skills, MCP servers, shift, supervisor.
- **Memory** — their memory, one file per topic, editable.

Their panel also shows which **project** they are posted to (changeable in place),
which **session** they are on — an agent keeps every conversation they have held, and
you can switch between them or start a new one — and the `claude --resume` command.

New staff are hired on `bypassPermissions` with tools auto-approved, so they get on
with the work; decisions still go to the CEO, and anything grave still reaches you.

### Taking an agent into a real terminal

Each agent's panel shows a copyable `claude --resume <sessionId>` command (with a `cd`
into their project). The office drives agents through the SDK — that is what makes the
approval gate and the office tools work — but the conversation underneath is an
ordinary Claude Code session, so you can always pick it up by hand.

Send them home in the office first. A session the office is not driving gets no
approval gating and none of the `mcp__office__*` instruments, and two drivers on one
conversation will talk over each other.

### Slash commands

Type `/` in the order box and the session's own commands are offered — `/compact`,
`/context`, `/model`, `/usage`, your installed skills, plugin commands. The list is
read from what the live session advertises in its `system/init` message (76 of them
on a typical setup), so it is always what that agent actually accepts rather than a
hard-coded guess. Commands the SDK flags as terminal-only are hidden, since they are
bound to a real TTY.

**Pop out** opens a floating console on the map. Drag it by its title bar, resize it
from any corner, and open as many as you like — the right-hand panel only ever shows
one agent, so this is how you watch several at once. The panel itself can be dragged
wider or narrower from its left edge.

### Visiting sessions

Claude sessions you started yourself in a terminal appear in the lobby below the
office. Click one to read its transcript. **Take onto the payroll** hires it as
staff, keeping its session id — so calling them to duty resumes that very
conversation rather than starting a new one.

Sessions the office spawned itself are filtered out of the lobby by session id, so
staff never appear twice.

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
| `ask_lord` | ask you a question, offering options — **blocks** until you answer |
| `remember` / `recall` | their private, persistent memory |
| `roster` | who works here and what they do |
| `report_progress` | record a milestone — this is what fills the Activity tab |
| `petition_lord` | send word directly to you |

When an agent calls `ask_lord`, the question appears **inline in that agent's own
console**, at the foot of the conversation, with its options as buttons — clicking one
sends it straight back as the tool's result and the agent carries on. Agents can mark
a question `multiSelect` when several answers could apply, and the options become
tick-boxes with a confirm button. The same question also appears in HQ, where each
pending item has an **→ Open chat** button that takes you to the agent.
Claude Code's own `AskUserQuestion` cannot be answered from a hook (there is no way to
hand a tool its result), so the office intercepts it and routes it through the same
queue, telling the agent to use `ask_lord` next time.

Memory is kept per topic, at `~/.marcosoffices/agents/<id>/memory/<topic>.md`. Agents
file notes under a topic they choose (`codebase`, `build-system`, `lord-preferences`,
`dead-ends`), list what they already hold so they file alongside it rather than
scattering, and **prune** with `forget` — stale memory is worse than none, because it
is believed. An older flat `MEMORY.md` is folded in as `general` on first start.

Milestones come from `report_progress` rather than from Claude Code's own todo list:
the Agent SDK does not expose `TodoWrite` to a session, so agents are instructed to
report their own steps instead. The upside is that a milestone is a deliberate
statement with substance, not a checkbox.

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

Dismissal moves someone to **Unemployment**, at the foot of the Staff panel. They
give up their desk, their place in the chain of command and any standing shift, but
their record is kept whole — so every message they ever sent still carries their
name instead of turning into "unknown". From there you may take them back on, or
remove them from the record for good. Only the second is irreversible.

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
