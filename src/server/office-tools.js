/**
 * The office's own instruments, exposed to every agent as an in-process MCP
 * server (`mcp__office__*`). This is how staff talk to each other, submit
 * proposals for approval, and keep a memory of their own.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { store, newId } from './store.js';
import { bus } from './bus.js';
import { requestApproval, notify } from './approvals.js';

/**
 * Late-bound hook into the runtime, so a message sent to a colleague who is
 * currently on duty can be delivered into their live session.
 */
let messageDeliverer = null;
export function setMessageDeliverer(fn) {
  messageDeliverer = fn;
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });

/** Find a colleague by id, exact name, or case-insensitive name. */
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

export function postMessage({ fromAgentId, toAgentId, subject, body }) {
  const message = {
    id: newId('msg_'),
    fromAgentId,
    toAgentId,
    subject,
    body,
    at: Date.now(),
    read: false,
  };
  store.state.messages.unshift(message);
  if (store.state.messages.length > 2000) store.state.messages.length = 2000;
  store.save();
  bus.emitEvent('message.new', message);
  return message;
}

export function buildOfficeServer(agentId) {
  const self = () => store.agent(agentId);

  return createSdkMcpServer({
    name: 'office',
    version: '0.1.0',
    instructions:
      'The instruments of Marcos Offices: internal mail, the approval pipeline, ' +
      'your private memory, and the staff roster.',
    tools: [
      tool(
        'send_message',
        'Send a message to another member of staff. Use this to coordinate work, ' +
          'request information, hand off a task, or report to your supervisor. ' +
          'The recipient receives it in their inbox, and immediately if they are on duty.',
        {
          to: z
            .string()
            .describe('The name (or id) of the colleague to write to, e.g. "Aurelius".'),
          subject: z.string().describe('A short subject line.'),
          body: z.string().describe('The message itself. Be specific and brief.'),
        },
        async ({ to, subject, body }) => {
          const recipient = findAgent(to);
          if (!recipient) {
            const names = store.state.agents.map((a) => a.name).join(', ');
            return text(
              `There is no one by the name "${to}" in this office. The staff are: ${names}.`
            );
          }
          if (recipient.id === agentId) {
            return text('You cannot send a message to yourself.');
          }

          const message = postMessage({
            fromAgentId: agentId,
            toAgentId: recipient.id,
            subject,
            body,
          });

          let delivered = false;
          if (messageDeliverer) {
            try {
              delivered = await messageDeliverer(recipient.id, message);
            } catch {
              delivered = false;
            }
          }

          return text(
            `Message sent to ${recipient.name} (${recipient.title}).` +
              (delivered
                ? ' They are on duty and it was placed in front of them.'
                : ' They are not currently at their desk; it is waiting in their inbox.')
          );
        }
      ),

      tool(
        'check_inbox',
        'Read the messages your colleagues have sent you. Check this when you begin ' +
          'work, and again before you report a task as finished.',
        {
          includeRead: z
            .boolean()
            .optional()
            .describe('Include messages you have already read. Defaults to false.'),
        },
        async ({ includeRead = false }) => {
          const inbox = store.state.messages.filter(
            (m) => m.toAgentId === agentId && (includeRead || !m.read)
          );
          if (!inbox.length) return text('Your inbox is empty.');

          const lines = inbox.slice(0, 30).map((m) => {
            const from = store.agent(m.fromAgentId);
            return (
              `--- ${new Date(m.at).toLocaleString()} — from ${from ? from.name : 'unknown'}` +
              `\nSubject: ${m.subject}\n${m.body}`
            );
          });

          for (const m of inbox) m.read = true;
          store.save();
          bus.emitEvent('message.read', { agentId });

          return text(`You have ${inbox.length} message(s):\n\n${lines.join('\n\n')}`);
        }
      ),

      tool(
        'request_approval',
        'Submit a decision for approval before you act on it. Use this for anything ' +
          'important or hard to undo: deleting work, rewriting a foundation, changing ' +
          'direction, publishing outward, or spending money. This call BLOCKS until a ' +
          'verdict comes back. Routine work inside your remit does not need it.',
        {
          title: z.string().describe('A one-line statement of what you propose to do.'),
          proposal: z
            .string()
            .describe('Exactly what you intend to do, concretely enough to be judged.'),
          reasoning: z.string().describe('Why you believe this is the right course.'),
          risk: z
            .string()
            .describe('What could go wrong, and whether it could be undone if it did.'),
          severity: z
            .enum(['normal', 'grave'])
            .optional()
            .describe(
              'Use "grave" only for matters reserved to Lord Marcos himself: ' +
                'irreversible destruction, money, his personal affairs, or a change of direction.'
            ),
        },
        async ({ title, proposal, reasoning, risk, severity = 'normal' }) => {
          const verdict = await requestApproval({
            agentId,
            kind: 'decision',
            title,
            detail: `**Proposal**\n${proposal}\n\n**Reasoning**\n${reasoning}`,
            risk,
            severity,
          });

          const who =
            verdict.by === 'lord'
              ? store.state.office.lordName || 'Lord Marcos'
              : verdict.by === 'ceo'
                ? 'the Chief Executive Officer'
                : verdict.by;

          return text(
            verdict.decision === 'approved'
              ? `APPROVED by ${who}.${verdict.note ? ` Remarks: ${verdict.note}` : ''}\n\n` +
                  `You may proceed as proposed.`
              : `REJECTED by ${who}.${verdict.note ? ` Remarks: ${verdict.note}` : ''}\n\n` +
                  `You must not proceed. Reconsider, or report back for direction.`
          );
        }
      ),

      tool(
        'remember',
        'Write something to your private memory, which survives between sessions. ' +
          'Record what you would otherwise have to rediscover: conventions, decisions ' +
          'and why they were made, dead ends, the shape of a codebase. Do not record ' +
          'trivia or anything the code itself already says.',
        {
          note: z.string().describe('The fact to remember, in one or two sentences.'),
        },
        async ({ note }) => {
          const agent = self();
          if (!agent?.memoryEnabled) {
            return text('Your memory has been disabled by Lord Marcos. Nothing was written.');
          }
          const file = store.memoryFile(agentId);
          await fsp.mkdir(path.dirname(file), { recursive: true });
          const stamp = new Date().toISOString().slice(0, 10);
          await fsp.appendFile(file, `- (${stamp}) ${note.trim()}\n`, 'utf8');
          bus.emitEvent('agent.memory', { agentId });
          return text('Committed to memory.');
        }
      ),

      tool(
        'recall',
        'Read back your private memory from previous service.',
        {},
        async () => {
          const agent = self();
          if (!agent?.memoryEnabled) return text('Your memory has been disabled.');
          try {
            const content = await fsp.readFile(store.memoryFile(agentId), 'utf8');
            return text(content.trim() || 'Your memory is empty.');
          } catch {
            return text('Your memory is empty.');
          }
        }
      ),

      tool(
        'roster',
        'Look up who works at this office, their posts, and which department they serve in.',
        {},
        async () => {
          const lines = store.state.departments.map((d) => {
            const staff = store.state.agents
              .filter((a) => a.departmentId === d.id)
              .map(
                (a) =>
                  `  - ${a.name} — ${a.title}${a.isCeo ? ' (CEO)' : ''}` +
                  `${a.id === agentId ? '  <- you' : ''}`
              );
            return `${d.name}\n${staff.join('\n') || '  (no staff assigned)'}`;
          });
          return text(lines.join('\n\n'));
        }
      ),

      tool(
        'petition_lord',
        'Send word directly to Lord Marcos. Use this to report something he must know, ' +
          'or to ask a question only he can answer. This does not block — he will answer ' +
          'in his own time. Do not use it for matters your supervisor could settle.',
        {
          subject: z.string().describe('A short subject line.'),
          body: z.string().describe('What you wish to tell or ask him.'),
        },
        async ({ subject, body }) => {
          const agent = self();
          notify({
            kind: 'petition',
            title: `${agent.name} petitions you: ${subject}`,
            body,
            agentId,
          });
          return text('Your petition has been laid before Lord Marcos.');
        }
      ),
    ],
  });
}
