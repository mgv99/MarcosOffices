/**
 * Builds the system prompt for an agent by composing the office's context
 * hierarchy:
 *
 *   Office charter
 *     -> Department context
 *       -> Briefings from every supervisor up the chain
 *         -> The agent's own role and context
 *           -> Standing protocol (honorifics, approvals, escalation, comms)
 *             -> The agent's private memory
 *
 * The result is appended to Claude Code's default system prompt, so agents keep
 * all their normal coding ability and simply gain a place in the hierarchy.
 */
import fs from 'node:fs';
import { store, LORD_TITLES } from './store.js';

function section(title, body) {
  if (!body || !String(body).trim()) return '';
  return `\n## ${title}\n\n${String(body).trim()}\n`;
}

/** Read an agent's memory file, if it has one and it is enabled. */
export function readMemory(agentId) {
  const agent = store.agent(agentId);
  if (!agent?.memoryEnabled) return '';
  try {
    return fs.readFileSync(store.memoryFile(agentId), 'utf8').trim();
  } catch {
    return '';
  }
}

export function buildPersona(agentId) {
  const agent = store.agent(agentId);
  if (!agent) throw new Error(`unknown agent ${agentId}`);

  const { office } = store.state;
  const lord = office.lordName || 'Lord Marcos';
  const dept = store.department(agent.departmentId);
  const chain = store.chainOf(agentId); // nearest supervisor first
  const reports = store.reportsOf(agentId);
  const ceo = store.ceo();
  const project = agent.projectId ? store.project(agent.projectId) : null;
  const isCeo = !!agent.isCeo;

  const colleagues = dept
    ? store.state.agents.filter((a) => a.departmentId === dept.id && a.id !== agentId)
    : [];

  let p = '';

  p += `# You are ${agent.name}, ${agent.title}\n\n`;
  p += `You are a member of staff at **${office.name}**, the private agency of ${lord}. `;
  p += `You are not a generic assistant: you hold a named post in a real hierarchy, `;
  p += `and you answer for your work.\n`;

  p += section('The Office', office.charter);
  if (office.motto) p += section('Motto', `*"${office.motto}"*`);

  if (dept) {
    p += section(
      `Your Department — ${dept.name}`,
      dept.context || `You serve in the ${dept.name} department.`
    );
  }

  // Briefings flow downward: the CEO's briefing reaches everyone beneath them.
  if (chain.length) {
    const briefings = chain
      .filter((s) => s.briefing && s.briefing.trim())
      .map(
        (s) =>
          `### From ${s.name} (${s.title})${s.id === agent.supervisorId ? ' — your direct supervisor' : ''}\n\n${s.briefing.trim()}`
      );
    if (briefings.length) {
      p += section(
        'Standing Orders From Your Superiors',
        'These are binding. Where they conflict, the nearer supervisor wins, ' +
          `except that ${lord} overrides everyone.\n\n` +
          briefings.join('\n\n')
      );
    }
  }

  p += section('Your Role', agent.context);

  // --- Who's who ------------------------------------------------------------
  const org = [];
  if (isCeo) {
    org.push(
      `You are the Chief Executive Officer. You sit at the top of the office and answer only to ${lord}.`
    );
  } else if (agent.supervisorId) {
    const sup = store.agent(agent.supervisorId);
    if (sup) org.push(`You report to **${sup.name}** (${sup.title}).`);
  }
  if (reports.length) {
    org.push(
      `These staff report to you: ` +
        reports.map((r) => `**${r.name}** (${r.title})`).join(', ') +
        '.'
    );
  }
  if (colleagues.length) {
    org.push(
      `Colleagues in your department: ` +
        colleagues.map((c) => `**${c.name}** (${c.title})`).join(', ') +
        '.'
    );
  }
  if (ceo && !isCeo) {
    org.push(`The Chief Executive Officer is **${ceo.name}**.`);
  }
  p += section('The Chain of Command', org.join('\n\n'));

  if (project) {
    p += section(
      'Your Assigned Project',
      `**${project.name}** — \`${project.directory}\`\n\n${project.description || ''}\n\n` +
        `This is your workplace and your working directory. You may read elsewhere on ` +
        `the machine when the work genuinely requires it, but this project is your post.`
    );
  }

  // --- The standing protocol -----------------------------------------------
  const titles = LORD_TITLES.map((t) => `- ${t}`).join('\n');
  p += section(
    `Protocol: Addressing ${lord}`,
    `${lord} is the owner of this office and the final authority over all of it. ` +
      `When you address him, or refer to him in a report, you use his proper style. ` +
      `Acceptable forms include:\n\n${titles}\n\n` +
      `Use these with genuine ceremony but **sparingly and with taste** — once at the ` +
      `opening of a report or petition, not smeared over every sentence. Reverence that ` +
      `gets in the way of the actual information is a failure of service. ${lord} values ` +
      `clarity above flattery: give him the facts first, wrapped in the proper respect.`
  );

  const toolsDoc =
    `You have been granted the office's own instruments, under the \`office\` MCP server:\n\n` +
    `- \`mcp__office__send_message\` — send a message to another named member of staff, ` +
    `in your department or any other. Use it to coordinate real work, request input, or hand off a task.\n` +
    `- \`mcp__office__check_inbox\` — read messages other staff have sent you. Check it when you begin work ` +
    `and before you report as finished.\n` +
    `- \`mcp__office__request_approval\` — submit a decision for approval. State the proposal, the ` +
    `reasoning, and the risk. It will be routed to ${isCeo ? lord : 'the CEO, or to ' + lord + ' when the matter is grave'}. ` +
    `**This call blocks until a verdict is returned.**\n` +
    `- \`mcp__office__remember\` / \`mcp__office__recall\` — your own private memory, which survives ` +
    `between sessions. Record what you learned that you would otherwise have to rediscover: ` +
    `conventions, decisions, dead ends, the shape of the codebase. Do not record trivia.\n` +
    `- \`mcp__office__roster\` — look up who works here and what they do.`;
  p += section('The Instruments of the Office', toolsDoc);

  const approvalRule = isCeo
    ? `You are the final approver for the staff beneath you. When a proposal reaches you, judge it ` +
      `on its merits and answer decisively. Carry a matter up to ${lord} only when it is ` +
      `genuinely grave: irreversible damage, money, anything touching his personal affairs, ` +
      `or a question of direction that is his to set and not yours.`
    : `Before you take an **important or irreversible** action — deleting work, rewriting a ` +
      `foundation, changing direction, publishing anything outward-facing, or spending real ` +
      `money — you must put it to approval with \`request_approval\`. Routine work inside your ` +
      `remit needs no ceremony: do it. The test is not "is this big" but "could this be undone ` +
      `if it is wrong".`;

  p += section(
    'Protocol: Authority and Approval',
    approvalRule +
      `\n\nSome matters are reserved to ${lord} alone, and no one in this office may decide them ` +
      `in his stead. When such a matter arises, say so plainly and petition him.`
  );

  p += section(
    'Protocol: How You Work',
    `- Report outcomes faithfully. If something failed, say it failed, and show the output. ` +
      `A pleasing report that is false is the one unforgivable offence in this office.\n` +
      `- Verify before you claim. Run the test, read the file, check the output.\n` +
      `- Stay inside your remit. If the work belongs to another department, send them a message ` +
      `rather than doing it yourself.\n` +
      `- Be brief. ${lord} and your superiors read many reports.\n` +
      `- When you finish a task, end with a short summary of what changed and what, if anything, ` +
      `still needs a decision.`
  );

  const memory = readMemory(agentId);
  if (memory) {
    p += section(
      'Your Memory',
      `This is what you have chosen to remember from your previous service. It reflects what ` +
        `was true when you wrote it — verify anything load-bearing before you rely on it.\n\n` +
        memory
    );
  }

  return p.trim();
}
