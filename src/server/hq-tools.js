/**
 * The management instruments (`mcp__hq__*`).
 *
 * Granted only to agents Lord Marcos has trusted with running the company.
 * They can inspect the whole office — who works here, what each of them costs,
 * how projects stand — and they can reshape it: hire staff, open departments,
 * reassign people, put them on shift, or let them go.
 *
 * Every instrument that *changes* the office goes through the approval
 * pipeline first. An agent may propose to hire; it may not hire unsanctioned.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

import { store } from './store.js';
import { requestApproval } from './approvals.js';
import {
  createAgent,
  createDepartment,
  updateAgent,
  deleteAgent,
} from './operations.js';

const text = (s) => ({ content: [{ type: 'text', text: s }] });

const mins = (ms) => `${Math.round((Number(ms) || 0) / 60000)}m`;

/** Everything an agent has read and written, as one number. */
const totalTokens = (stats = {}) =>
  (Number(stats.inputTokens) || 0) + (Number(stats.outputTokens) || 0);

/** Lord Marcos reads usage in tokens, so the office reports it in tokens. */
const tokens = (n) => {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M tokens`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k tokens`;
  return `${v} tokens`;
};

function findAgent(ref) {
  if (!ref) return null;
  const agents = store.state.agents;
  return (
    agents.find((a) => a.id === ref) ||
    agents.find((a) => a.name === ref) ||
    agents.find((a) => a.name.toLowerCase() === String(ref).toLowerCase()) ||
    null
  );
}

function findDepartment(ref) {
  if (!ref) return null;
  const depts = store.state.departments;
  return (
    depts.find((d) => d.id === ref) ||
    depts.find((d) => d.name.toLowerCase() === String(ref).toLowerCase()) ||
    null
  );
}

function findProject(ref) {
  if (!ref) return null;
  const projects = store.state.projects;
  return (
    projects.find((p) => p.id === ref) ||
    projects.find((p) => p.name.toLowerCase() === String(ref).toLowerCase()) ||
    null
  );
}

/**
 * Put a proposed change to the office in front of whoever must sanction it,
 * and only carry it out if the answer is yes.
 */
async function propose(agentId, { title, detail, risk, severity = 'normal' }, apply) {
  const verdict = await requestApproval({
    agentId,
    kind: 'decision',
    title,
    detail,
    risk,
    severity,
  });

  if (verdict.decision !== 'approved') {
    return text(
      `REFUSED${verdict.note ? ` — ${verdict.note}` : ''}. The office is unchanged. ` +
        `Do not attempt it again; report back instead.`
    );
  }

  const result = apply();
  if (result?.ok === false) {
    return text(`Sanctioned, but it could not be carried out: ${result.error}`);
  }
  return text(
    `SANCTIONED and done.${verdict.note ? ` Remarks: ${verdict.note}` : ''}\n\n${result.summary || ''}`
  );
}

/**
 * The management instruments.
 *
 * `scope` decides how far they reach. An agent trusted to run the company gets
 * the whole office; a head of department gets their own department and nothing
 * else — they can staff and run their own floor without being handed authority
 * over everybody else's.
 */
export function buildHqServer(
  agentId,
  { workerStates = () => ({}), scope = 'office', departmentId = null } = {}
) {
  const officeWide = scope === 'office';
  const myDepartment = () =>
    officeWide || !store.state ? null : store.department(departmentId);
  const remit = () => (officeWide ? 'this office' : myDepartment()?.name || 'your department');

  /** The staff this agent may look at and act on. */
  const staffInRemit = () => {
    const all = store.state?.agents || [];
    return officeWide ? all : all.filter((a) => a.departmentId === departmentId);
  };

  /** Refuse, in words, when something falls outside the remit. */
  const outOfRemit = (who) =>
    text(
      `${who} is not in ${remit()}, and your authority does not reach them. ` +
        `Put it to the CEO instead — send_message or request_approval.`
    );

  const canAct = (agent) =>
    !!agent && (officeWide || agent.departmentId === departmentId);

  return createSdkMcpServer({
    name: 'hq',
    version: '0.1.0',
    instructions: officeWide
      ? 'The management instruments of Marcos Offices. Inspect the whole company, ' +
        'account for what each member of staff costs, and propose changes to the ' +
        'organisation itself. Changes require sanction before they take effect.'
      : `The management instruments for ${remit()}, which you head. They reach ` +
        `your own department and no further: you may account for your staff, ` +
        `propose hiring into your department, moving your people between ` +
        `projects, putting them on shift, and letting them go. Changes require ` +
        `sanction before they take effect. Anything beyond your department is ` +
        `the CEO's to decide — write to them.`,
    tools: [
      // --- inspection ------------------------------------------------------

      tool(
        'office_report',
        'A complete picture of the company: departments, staff, who is working, ' +
          'what has been spent, projects, and anything awaiting sanction. Start here.',
        {},
        async () => {
          const live = workerStates();
          const s = store.state;

          const mine = staffInRemit();
          const departments = officeWide
            ? s.departments
            : s.departments.filter((d) => d.id === departmentId);

          const totalUsed = mine.reduce((n, a) => n + totalTokens(a.stats), 0);
          const pending = s.approvals.filter(
            (a) => a.status === 'pending' && (officeWide || mine.some((m) => m.id === a.agentId))
          );

          const lines = [`# ${officeWide ? s.office.name : remit()}`, ''];
          if (!officeWide) {
            lines.push(`You head this department. The rest of the office is not yours to run.`);
          }
          lines.push(
            `Staff: ${mine.length} · Departments: ${departments.length} · ` +
              `Projects: ${s.projects.length}`
          );
          lines.push(`Used to date: ${tokens(totalUsed)}`);
          lines.push(`Awaiting sanction: ${pending.length}`);
          lines.push('');

          for (const dept of departments) {
            const staff = s.agents.filter((a) => a.departmentId === dept.id);
            const deptUsed = staff.reduce((n, a) => n + totalTokens(a.stats), 0);
            lines.push(
              `## ${dept.name} — ${staff.length}/${dept.seats} desks · ${tokens(deptUsed)}`
            );
            for (const a of staff) {
              const project = a.projectId ? store.project(a.projectId) : null;
              lines.push(
                `  - ${a.name} (${a.title}) · ${live[a.id]?.status || 'offline'} · ` +
                  `${a.model} · ${tokens(totalTokens(a.stats))} over ${a.stats?.tasks || 0} task(s)` +
                  `${project ? ` · on ${project.name}` : ''}` +
                  `${a.loop?.enabled ? ` · on shift every ${a.loop.intervalMinutes}m` : ''}`
              );
            }
            if (!staff.length) lines.push('  (empty)');
            lines.push('');
          }

          if (s.projects.length) {
            lines.push('## Projects');
            for (const p of s.projects) {
              const staff = s.agents.filter((a) => a.projectId === p.id);
              lines.push(
                `  - ${p.name} (${p.directory}) — ${staff.length ? staff.map((a) => a.name).join(', ') : 'unstaffed'}`
              );
            }
          }

          return text(lines.join('\n'));
        }
      ),

      tool(
        'staff_ledger',
        'What each member of staff has cost, and how hard they are working. Use this ' +
          'to answer whether someone is consuming too much. Sorted by spend.',
        {
          agent: z
            .string()
            .optional()
            .describe('Limit to one member of staff, by name or id.'),
        },
        async ({ agent: ref }) => {
          const live = workerStates();
          let staff = staffInRemit();

          if (ref) {
            const one = findAgent(ref);
            if (!one) return text(`There is no one here called "${ref}".`);
            if (!canAct(one)) return outOfRemit(one.name);
            staff = [one];
          }

          const rows = [...staff].sort(
            (a, b) => totalTokens(b.stats) - totalTokens(a.stats)
          );

          const total = staffInRemit().reduce((n, a) => n + totalTokens(a.stats), 0);

          const lines = rows.map((a) => {
            const st = a.stats || {};
            const used = totalTokens(st);
            const share = total > 0 ? (used / total) * 100 : 0;
            const perTask = st.tasks ? Math.round(used / st.tasks) : 0;
            return (
              `${a.name} (${a.title}) · ${a.model}\n` +
              `  used ${tokens(used)} (${share.toFixed(1)}% of office) · ` +
              `${st.tasks || 0} task(s) at ${tokens(perTask)} each\n` +
              `  in ${tokens(st.inputTokens)} / out ${tokens(st.outputTokens)} · ` +
              `${st.turns || 0} turns · ${mins(st.durationMs)} of work · ` +
              `${st.errors || 0} failure(s)\n` +
              `  status ${live[a.id]?.status || 'offline'}` +
              `${st.lastActiveAt ? ` · last active ${new Date(st.lastActiveAt).toLocaleString()}` : ' · never worked'}`
            );
          });

          return text(
            `Office total: ${tokens(total)}\n\n${lines.join('\n\n')}\n\n` +
              `Note: a high spend is only a problem next to what the work was worth. ` +
              `Say what they produced for it before you call it waste.`
          );
        }
      ),

      tool(
        'project_status',
        'How a project stands: where it lives, who is posted to it, what they have ' +
          'spent on it, and what the directory actually contains.',
        {
          project: z.string().optional().describe('Project name or id. Omit for all.'),
        },
        async ({ project: ref }) => {
          let projects = store.state.projects;
          if (ref) {
            const one = findProject(ref);
            if (!one) return text(`There is no project called "${ref}".`);
            projects = [one];
          }
          if (!projects.length) return text('This office has no projects yet.');

          const out = [];
          for (const p of projects) {
            const staff = store.state.agents.filter((a) => a.projectId === p.id);
            const used = staff.reduce((n, a) => n + totalTokens(a.stats), 0);

            out.push(`## ${p.name}\n${p.directory}\n${p.description || ''}`);
            out.push(
              `Staffed by: ${staff.length ? staff.map((a) => `${a.name} (${a.title})`).join(', ') : 'nobody'}`
            );
            out.push(`Used by posted staff: ${tokens(used)}`);

            try {
              const entries = await fsp.readdir(p.directory, { withFileTypes: true });
              const visible = entries.filter((e) => !e.name.startsWith('.')).slice(0, 25);
              out.push(
                `Contents (${entries.length} entries): ` +
                  visible.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join(', ')
              );
              const hasGit = entries.some((e) => e.name === '.git');
              out.push(hasGit ? 'Under git.' : 'Not a git repository.');
            } catch (err) {
              out.push(`The directory could not be read: ${err.message}`);
            }
            out.push('');
          }
          return text(out.join('\n'));
        }
      ),

      tool(
        'describe_staff',
        'Read one member of staff in full: their context, their standing orders, ' +
          'their permissions, their skills, and where they sit in the chain of command.',
        { agent: z.string().describe('Name or id.') },
        async ({ agent: ref }) => {
          const a = findAgent(ref);
          if (!a) return text(`There is no one here called "${ref}".`);
          if (!canAct(a)) return outOfRemit(a.name);

          const dept = store.department(a.departmentId);
          const sup = a.supervisorId ? store.agent(a.supervisorId) : null;
          const reports = store.reportsOf(a.id);
          const project = a.projectId ? store.project(a.projectId) : null;

          return text(
            [
              `# ${a.name} — ${a.title}${a.isCeo ? ' (CEO)' : ''}`,
              `Department: ${dept?.name || 'none'} · desk ${a.seat}`,
              `Reports to: ${sup ? `${sup.name} (${sup.title})` : 'Lord Marcos directly'}`,
              `Supervises: ${reports.map((r) => r.name).join(', ') || 'nobody'}`,
              `Project: ${project ? `${project.name} (${project.directory})` : 'none'}`,
              `Model: ${a.model} · effort ${a.effort} · permission mode ${a.permissionMode}`,
              `Sanction needed — tools: ${a.approvalPolicy?.tools}, decisions: ${a.approvalPolicy?.decisions}`,
              `Skills: ${a.enabledSkills?.length ? a.enabledSkills.join(', ') : 'all installed'}`,
              `MCP servers: ${a.enabledMcpServers?.length ? a.enabledMcpServers.join(', ') : 'none beyond the office'}`,
              `Memory: ${a.memoryEnabled ? 'enabled' : 'disabled'} · May manage the office: ${a.canManageOffice ? 'yes' : 'no'}`,
              `Shift: ${a.loop?.enabled ? `every ${a.loop.intervalMinutes}m — ${a.loop.prompt}` : 'none'}`,
              '',
              `## Their context`,
              a.context || '(none)',
              '',
              `## What they pass down to their reports`,
              a.briefing || '(nothing)',
            ].join('\n')
          );
        }
      ),

      // --- changes, each requiring sanction --------------------------------

      tool(
        'propose_hire',
        'Propose hiring a new member of staff for a task or project. Requires ' +
          'sanction. Think about what the office actually lacks before you ask — ' +
          'every hire costs Lord Marcos money.',
        {
          name: z.string().describe('A proper name for them, e.g. "Cassia".'),
          title: z.string().describe('Their post, e.g. "Build Engineer".'),
          department: z.string().describe('Department name or id they will serve in.'),
          context: z
            .string()
            .describe('Their charge: what they are for and how they should behave.'),
          model: z
            .enum(['opus', 'sonnet', 'haiku'])
            .optional()
            .describe('Default sonnet. Reserve opus for genuinely hard work.'),
          supervisor: z.string().optional().describe('Who they report to. Defaults to the CEO.'),
          project: z.string().optional().describe('Project to post them to.'),
          justification: z.string().describe('Why this hire is needed, in one or two sentences.'),
        },
        async (args) => {
          // A head of department hires into their own department, whatever
          // they named — there is nowhere else they could put someone.
          const dept = officeWide ? findDepartment(args.department) : myDepartment();
          if (!dept) return text(`There is no department called "${args.department}".`);
          if (!officeWide && args.department && findDepartment(args.department)?.id !== dept.id) {
            return text(
              `You head ${dept.name}, and may only hire into it. Hiring for another ` +
                `department is the CEO's to propose.`
            );
          }

          const sup = args.supervisor ? findAgent(args.supervisor) : null;
          if (args.supervisor && !sup) {
            return text(`There is no one called "${args.supervisor}" to supervise them.`);
          }
          if (sup && !canAct(sup)) return outOfRemit(sup.name);

          const project = args.project ? findProject(args.project) : null;
          if (args.project && !project) {
            return text(`There is no project called "${args.project}".`);
          }

          return propose(
            agentId,
            {
              title: `Hire ${args.name} as ${args.title} in ${dept.name}`,
              detail:
                `**Justification**\n${args.justification}\n\n` +
                `**Their charge**\n${args.context}\n\n` +
                `Model: ${args.model || 'sonnet'} · Department: ${dept.name}` +
                `${sup ? ` · Reports to: ${sup.name}` : ''}` +
                `${project ? ` · Posted to: ${project.name}` : ''}`,
              risk: 'A new member of staff adds ongoing cost and another hand on the work.',
            },
            () => {
              const result = createAgent({
                name: args.name,
                title: args.title,
                departmentId: dept.id,
                context: args.context,
                model: args.model || 'sonnet',
                supervisorId: sup?.id || null,
                projectId: project?.id || null,
              });
              if (!result.ok) return result;
              return {
                ok: true,
                summary:
                  `${result.agent.name} has joined ${dept.name} at desk ${result.agent.seat}. ` +
                  `They are off duty until called.`,
              };
            }
          );
        }
      ),

      tool(
        'propose_department',
        'Propose opening a new department. Requires sanction.',
        {
          name: z.string(),
          context: z.string().describe('What this department is responsible for.'),
          seats: z.number().optional().describe('Number of desks. Default 6.'),
          justification: z.string(),
        },
        async (args) => {
          if (!officeWide) {
            return text(
              `Opening a department is not yours to propose — you head ${remit()}. ` +
                `Put it to the CEO.`
            );
          }
          return propose(
            agentId,
            {
              title: `Open a new department: ${args.name}`,
              detail: `**Justification**\n${args.justification}\n\n**Remit**\n${args.context}`,
              risk: 'A new department divides responsibility; it should earn its existence.',
            },
            () => {
              const result = createDepartment({
                name: args.name,
                context: args.context,
                seats: args.seats || 6,
              });
              if (!result.ok) return result;
              return { ok: true, summary: `${result.department.name} is open.` };
            }
          );
        }
      ),

      tool(
        'propose_reassignment',
        'Propose moving a member of staff: to a different project, a different ' +
          'department, or under a different supervisor. Requires sanction.',
        {
          agent: z.string().describe('Who to move.'),
          project: z.string().optional(),
          department: z.string().optional(),
          supervisor: z.string().optional(),
          justification: z.string(),
        },
        async (args) => {
          const who = findAgent(args.agent);
          if (!who) return text(`There is no one here called "${args.agent}".`);
          if (!canAct(who)) return outOfRemit(who.name);

          const patch = {};
          const changes = [];

          if (args.project) {
            const p = findProject(args.project);
            if (!p) return text(`There is no project called "${args.project}".`);
            patch.projectId = p.id;
            changes.push(`posted to ${p.name}`);
          }
          if (args.department) {
            const d = findDepartment(args.department);
            if (!d) return text(`There is no department called "${args.department}".`);
            // Moving someone out lands them on another head's floor, which is
            // that head's business and the CEO's to settle.
            if (!officeWide && d.id !== departmentId) {
              return text(
                `Moving ${who.name} out of ${remit()} is not yours to propose — it ` +
                  `puts them under another head. Put it to the CEO.`
              );
            }
            patch.departmentId = d.id;
            changes.push(`moved to ${d.name}`);
          }
          if (args.supervisor) {
            const s = findAgent(args.supervisor);
            if (!s) return text(`There is no one called "${args.supervisor}".`);
            if (!canAct(s)) return outOfRemit(s.name);
            patch.supervisorId = s.id;
            changes.push(`now reports to ${s.name}`);
          }
          if (!changes.length) return text('You proposed no actual change.');

          return propose(
            agentId,
            {
              title: `Reassign ${who.name}: ${changes.join(', ')}`,
              detail: `**Justification**\n${args.justification}`,
              risk: 'Reassignment interrupts whatever they were doing.',
            },
            () => {
              const result = updateAgent(who.id, patch);
              if (!result.ok) return result;
              return {
                ok: true,
                summary:
                  `${who.name} ${changes.join(', ')}. If they are on duty they must be ` +
                  `sent home and recalled for it to take effect.`,
              };
            }
          );
        }
      ),

      tool(
        'propose_shift',
        'Propose putting a member of staff on a standing shift, or taking them off ' +
          'one. On shift they pick up the same task on an interval. Requires sanction.',
        {
          agent: z.string(),
          enabled: z.boolean(),
          intervalMinutes: z.number().optional().describe('Default 30.'),
          task: z.string().optional().describe('The standing task. Required when enabling.'),
          justification: z.string(),
        },
        async (args) => {
          const who = findAgent(args.agent);
          if (!who) return text(`There is no one here called "${args.agent}".`);
          if (!canAct(who)) return outOfRemit(who.name);
          if (args.enabled && !args.task?.trim()) {
            return text('A standing shift needs a task.');
          }

          const interval = args.intervalMinutes || 30;

          return propose(
            agentId,
            {
              title: args.enabled
                ? `Put ${who.name} on shift every ${interval} minutes`
                : `Take ${who.name} off their standing shift`,
              detail:
                `**Justification**\n${args.justification}` +
                (args.enabled ? `\n\n**Standing task**\n${args.task}` : ''),
              risk: args.enabled
                ? 'A standing shift spends money on its own schedule, unattended.'
                : 'Work that was being picked up automatically will stop.',
            },
            () => {
              const result = updateAgent(who.id, {
                loop: {
                  enabled: args.enabled,
                  intervalMinutes: interval,
                  prompt: args.enabled ? args.task : who.loop?.prompt || '',
                  lastRunAt: who.loop?.lastRunAt || 0,
                },
              });
              if (!result.ok) return result;
              return {
                ok: true,
                summary: args.enabled
                  ? `${who.name} is on shift every ${interval} minutes.`
                  : `${who.name} is off shift.`,
              };
            }
          );
        }
      ),

      tool(
        'propose_dismissal',
        'Propose letting staff go — one person, several, or the whole roster when ' +
          'Lord Marcos wants to start afresh. This is grave and goes to him himself. ' +
          'Their memory and record are destroyed with them.',
        {
          agent: z
            .string()
            .optional()
            .describe('A single member of staff, by name or id.'),
          agents: z
            .array(z.string())
            .optional()
            .describe(
              'Several at once, by name or id. Use "all" as the only entry to mean ' +
                'every member of staff except yourself and the CEO. One proposal ' +
                'covers the whole list, so he answers once rather than fourteen times.'
            ),
          justification: z.string().describe('Why they should go. Be specific and fair.'),
        },
        async (args) => {
          // Accept either shape: a resumed session may still hold the older
          // single-agent schema.
          const refs = args.agents?.length ? args.agents : args.agent ? [args.agent] : [];
          if (!refs.length) return text('Name who should go.');

          const everyone =
            refs.length === 1 && /^(all|everyone|all staff)$/i.test(refs[0].trim());

          // "all" means everyone within this agent's remit — the whole office
          // for the CEO, this department for the head who runs it.
          const targets = everyone
            ? staffInRemit().filter((a) => !a.isCeo && a.id !== agentId)
            : refs.map((r) => ({ ref: r, agent: findAgent(r) }));

          if (!everyone) {
            const missing = targets.filter((t) => !t.agent).map((t) => t.ref);
            if (missing.length) {
              return text(`There is no one here called: ${missing.join(', ')}.`);
            }
            const beyond = targets.filter((t) => !canAct(t.agent)).map((t) => t.agent.name);
            if (beyond.length) return outOfRemit(beyond.join(', '));
          }

          const list = everyone ? targets : targets.map((t) => t.agent);
          const keep = list.filter((a) => a.isCeo || a.id === agentId);
          const going = list.filter((a) => !a.isCeo && a.id !== agentId);

          if (!going.length) {
            return text(
              'That leaves nobody to dismiss. The CEO cannot be dismissed by a ' +
                'subordinate, and you may not dismiss yourself.'
            );
          }

          const used = going.reduce((n, a) => n + totalTokens(a.stats), 0);
          const roll = going.map((a) => `- ${a.name} (${a.title})`).join('\n');

          return propose(
            agentId,
            {
              title:
                going.length === 1
                  ? `Dismiss ${going[0].name} (${going[0].title})`
                  : `Dismiss ${going.length} members of staff`,
              detail:
                `**Justification**\n${args.justification}\n\n` +
                `**Who would go**\n${roll}\n\n` +
                `Between them they have used ${tokens(used)}.` +
                (keep.length
                  ? `\n\nNot included: ${keep.map((a) => a.name).join(', ')} ` +
                    `(the CEO cannot be dismissed by a subordinate, and nobody may ` +
                    `dismiss themselves).`
                  : ''),
              risk:
                going.length === 1
                  ? 'Irreversible. Their memory and record go with them.'
                  : `Irreversible. ${going.length} records and memories are destroyed, ` +
                    `and every department is left empty of them.`,
              severity: 'grave',
            },
            () => {
              const gone = [];
              const refused = [];
              for (const a of going) {
                const result = deleteAgent(a.id);
                if (result.ok) gone.push(a.name);
                else refused.push(`${a.name}: ${result.error}`);
              }
              return {
                ok: true,
                summary:
                  `${gone.length} have left the office: ${gone.join(', ') || 'nobody'}.` +
                  (refused.length ? `\nCould not dismiss — ${refused.join('; ')}.` : ''),
              };
            }
          );
        }
      ),
    ],
  });
}
