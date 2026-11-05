/**
 * The office's business rules, in one place.
 *
 * Both the GUI (via the REST routes) and the managing agents (via the `hq` MCP
 * tools) change the office through these functions, so seat allocation, cycle
 * checks and room placement cannot drift apart between the two.
 *
 * Every function here either returns `{ ok: true, ... }` or `{ ok: false, error }`.
 */
import { store, newId, emptyStats } from './store.js';
import { bus } from './bus.js';

export function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

/** Would making `supervisorId` the boss of `agentId` close a loop? */
export function createsCycle(agentId, supervisorId) {
  const seen = new Set([agentId]);
  let cursor = store.agent(supervisorId);
  while (cursor) {
    if (seen.has(cursor.id)) return true;
    seen.add(cursor.id);
    cursor = cursor.supervisorId ? store.agent(cursor.supervisorId) : null;
  }
  return false;
}

/** The lowest unoccupied desk number in a department, or null if full. */
export function findFreeSeat(departmentId, { excludeAgentId = null } = {}) {
  const dept = store.department(departmentId);
  if (!dept) return null;

  const taken = new Set(
    store.state.agents
      .filter((a) => a.departmentId === departmentId && a.id !== excludeAgentId)
      .map((a) => a.seat)
  );

  for (let seat = 0; seat < dept.seats; seat++) {
    if (!taken.has(seat)) return seat;
  }
  return null;
}

/** Find an unoccupied patch of floor for a new department. */
export function placeDepartment({ x, y, w = 14, h = 10 } = {}) {
  if (Number.isFinite(x) && Number.isFinite(y)) return { x, y, w, h };
  const gap = 2;

  // Three rooms to a row keeps the floor plan compact enough to take in at a
  // glance, rather than stretching the office into one long corridor.
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 3; col++) {
      const nx = 2 + col * (w + gap);
      const ny = 2 + row * (h + gap);
      const clash = store.state.departments.some(
        (d) =>
          nx < d.x + d.w + gap &&
          nx + w + gap > d.x &&
          ny < d.y + d.h + gap &&
          ny + h + gap > d.y
      );
      if (!clash) return { x: nx, y: ny, w, h };
    }
  }
  return { x: 2, y: 2 + store.state.departments.length * (h + gap), w, h };
}

// --- departments ------------------------------------------------------------

export function createDepartment(body = {}) {
  if (!body.name?.trim()) return { ok: false, error: 'a department needs a name' };

  const dept = {
    id: newId('dep_'),
    name: body.name.trim(),
    context: body.context || '',
    seats: clamp(Number(body.seats) || 4, 1, 24),
    theme: body.theme || 'default',
    headAgentId: null,
    ...placeDepartment(body),
  };

  store.state.departments.push(dept);
  store.save();
  bus.emitEvent('department.created', dept);
  return { ok: true, department: dept };
}

export function deleteDepartment(id) {
  const dept = store.department(id);
  if (!dept) return { ok: false, error: 'no such department' };

  const staff = store.state.agents.filter((a) => a.departmentId === id);
  if (staff.length) {
    return {
      ok: false,
      error: `${dept.name} still has ${staff.length} member(s) of staff. Reassign or dismiss them first.`,
    };
  }

  store.state.departments = store.state.departments.filter((d) => d.id !== id);
  store.save();
  bus.emitEvent('department.deleted', { id });
  return { ok: true };
}

// --- agents -----------------------------------------------------------------

export function createAgent(body = {}) {
  if (!body.name?.trim()) return { ok: false, error: 'an agent needs a name' };

  const dept = store.department(body.departmentId);
  if (!dept) return { ok: false, error: 'assign the agent to a real department' };

  const seat = findFreeSeat(dept.id);
  if (seat === null) {
    return {
      ok: false,
      error: `${dept.name} has no free desks. Add seats to the department first.`,
    };
  }

  if (body.projectId && !store.project(body.projectId)) {
    return { ok: false, error: 'no such project' };
  }
  if (body.supervisorId && !store.agent(body.supervisorId)) {
    return { ok: false, error: 'no such supervisor' };
  }

  const agent = {
    id: newId('agt_'),
    name: body.name.trim(),
    title: body.title?.trim() || 'Associate',
    departmentId: dept.id,
    seat,
    supervisorId: body.supervisorId || store.state.office.ceoAgentId || null,
    isCeo: false,
    context: body.context || '',
    briefing: body.briefing || '',
    model: body.model || 'sonnet',
    effort: body.effort || 'medium',
    permissionMode: body.permissionMode || 'default',
    approvalPolicy: body.approvalPolicy || { tools: 'lord', decisions: 'ceo' },
    allowedTools: body.allowedTools || [],
    disallowedTools: body.disallowedTools || [],
    enabledSkills: body.enabledSkills || [],
    enabledMcpServers: body.enabledMcpServers || [],
    projectId: body.projectId || null,
    extraDirs: body.extraDirs || [],
    memoryEnabled: body.memoryEnabled !== false,
    canManageOffice: !!body.canManageOffice,
    loop: body.loop || { enabled: false, intervalMinutes: 30, prompt: '' },
    appearance: body.appearance || { seed: newId(), outfit: 'shirt' },
    stats: emptyStats(),
    createdAt: Date.now(),
    lastSessionId: null,
  };

  store.state.agents.push(agent);
  store.save();
  bus.emitEvent('agent.created', agent);
  return { ok: true, agent };
}

const PATCHABLE = [
  'name', 'title', 'departmentId', 'seat', 'supervisorId', 'context', 'briefing',
  'model', 'effort', 'permissionMode', 'approvalPolicy', 'allowedTools',
  'disallowedTools', 'enabledSkills', 'enabledMcpServers', 'projectId',
  'extraDirs', 'memoryEnabled', 'loop', 'appearance', 'canManageOffice',
];

export function updateAgent(id, patch = {}) {
  const agent = store.agent(id);
  if (!agent) return { ok: false, error: 'no such agent' };

  if (patch.supervisorId !== undefined) {
    if (patch.supervisorId === id) {
      return { ok: false, error: 'an agent cannot supervise themselves' };
    }
    if (patch.supervisorId && createsCycle(id, patch.supervisorId)) {
      return { ok: false, error: 'that would create a loop in the chain of command' };
    }
  }

  if (patch.departmentId && patch.departmentId !== agent.departmentId) {
    const dept = store.department(patch.departmentId);
    if (!dept) return { ok: false, error: 'no such department' };
    const seat = findFreeSeat(dept.id, { excludeAgentId: id });
    if (seat === null) return { ok: false, error: `${dept.name} has no free desks.` };
    agent.seat = seat;
  }

  if (patch.projectId && !store.project(patch.projectId)) {
    return { ok: false, error: 'no such project' };
  }

  for (const key of PATCHABLE) {
    if (patch[key] !== undefined) agent[key] = patch[key];
  }

  store.save();
  bus.emitEvent('agent.updated', agent);
  return { ok: true, agent };
}

/**
 * Staff a brand-new office so it opens as a working company rather than one
 * lonely CEO. Additive and idempotent by name: departments or staff that
 * already exist are left exactly as they are.
 */
export function seedOffice() {
  const created = { departments: [], agents: [] };

  const plan = [
    {
      name: 'Operations',
      theme: 'creative',
      seats: 4,
      context:
        'Operations runs the company itself rather than its products. It keeps the ' +
        'roster, watches what each member of staff costs against what they deliver, ' +
        'reports on the state of every project, and proposes how the office should be ' +
        'organised. It does not write product code.',
      staff: [
        {
          name: 'Prefect',
          title: 'Chief of Staff',
          canManageOffice: true,
          model: 'sonnet',
          context:
            'You run the office on the CEO\'s behalf. You know who works here, what ' +
            'they are doing, and whether the shape of the company still fits the work. ' +
            'When Lord Marcos asks what is going on, you answer from the management ' +
            'instruments, not from memory. When a project needs a hand the office does ' +
            'not have, you propose the hire — with a reason, not a hunch.',
          briefing:
            'Answer with facts drawn from the instruments. Name the number. Never pad.',
        },
        {
          name: 'Ledger',
          title: 'Office Accountant',
          canManageOffice: true,
          model: 'haiku',
          context:
            'You account for what this office spends. You watch the staff ledger and ' +
            'report plainly when someone is consuming more than their work is worth — ' +
            'and equally plainly when a large bill was money well spent. You compare ' +
            'cost against delivery, never cost alone.',
        },
      ],
    },
    {
      name: 'Engineering',
      theme: 'engineering',
      seats: 6,
      context:
        'Engineering builds and maintains Lord Marcos\'s software. It values working ' +
        'code over clever code, verifies before it claims, and reports failures as ' +
        'plainly as successes.',
      staff: [
        {
          name: 'Vulcan',
          title: 'Principal Engineer',
          model: 'opus',
          effort: 'high',
          head: true,
          context:
            'You are the senior engineering hand in this office. You take on the work ' +
            'that is genuinely hard, and you set the standard the others work to. You ' +
            'read before you write and you test before you report.',
          briefing:
            'Read the surrounding code before adding to it. Match its conventions. ' +
            'Run the thing before you tell me it works.',
        },
        {
          name: 'Faber',
          title: 'Build Engineer',
          model: 'sonnet',
          context:
            'You handle the everyday engineering work: features, fixes, refactors, ' +
            'build and tooling. You keep changes small and reversible, and you say so ' +
            'when something is beyond your remit.',
        },
        {
          name: 'Tessera',
          title: 'Quality Engineer',
          model: 'sonnet',
          context:
            'You test what the others build. You write and run tests, reproduce bugs ' +
            'precisely, and you are the one person in this office whose job it is to ' +
            'be unimpressed. A green suite you did not actually run is a lie.',
        },
      ],
    },
    {
      name: 'Research',
      theme: 'research',
      seats: 4,
      context:
        'Research investigates before the office commits. It reads documentation and ' +
        'source rather than guessing, and it reports what it actually found — ' +
        'including when the answer is "this will not work".',
      staff: [
        {
          name: 'Minerva',
          title: 'Head of Research',
          model: 'opus',
          effort: 'high',
          head: true,
          context:
            'You lead investigation for this office. Before the engineers commit to an ' +
            'approach, you establish whether it is sound. You cite what you read. You ' +
            'distinguish what you verified from what you inferred, every time.',
          briefing: 'Cite your sources. Separate what you verified from what you assumed.',
        },
        {
          name: 'Quill',
          title: 'Research Analyst',
          model: 'sonnet',
          context:
            'You do the legwork of investigation: reading documentation, tracing ' +
            'through source, summarising findings for the rest of the office. Brevity ' +
            'is a courtesy; accuracy is a duty.',
        },
      ],
    },
  ];

  const ceoId = store.state.office.ceoAgentId;

  for (const spec of plan) {
    let dept = store.state.departments.find(
      (d) => d.name.toLowerCase() === spec.name.toLowerCase()
    );

    if (!dept) {
      const result = createDepartment({
        name: spec.name,
        context: spec.context,
        seats: spec.seats,
        theme: spec.theme,
      });
      if (!result.ok) continue;
      dept = result.department;
      created.departments.push(dept.name);
    }

    let headId = dept.headAgentId;

    for (const person of spec.staff) {
      const exists = store.state.agents.some(
        (a) => a.name.toLowerCase() === person.name.toLowerCase()
      );
      if (exists) continue;

      const result = createAgent({
        name: person.name,
        title: person.title,
        departmentId: dept.id,
        context: person.context,
        briefing: person.briefing || '',
        model: person.model || 'sonnet',
        effort: person.effort || 'medium',
        canManageOffice: !!person.canManageOffice,
        // Department heads answer to the CEO; everyone else to their head.
        supervisorId: person.head || !headId ? ceoId : headId,
      });
      if (!result.ok) continue;

      created.agents.push(result.agent.name);
      if (person.head && !headId) {
        headId = result.agent.id;
        dept.headAgentId = headId;
      }
    }

    store.save();
  }

  return { ok: true, created };
}

export function deleteAgent(id) {
  const agent = store.agent(id);
  if (!agent) return { ok: false, error: 'no such agent' };
  if (agent.isCeo) {
    return { ok: false, error: 'the CEO cannot be dismissed; appoint a successor first' };
  }

  store.state.agents = store.state.agents.filter((a) => a.id !== id);
  // Anyone who reported to them now reports to the CEO.
  for (const other of store.state.agents) {
    if (other.supervisorId === id) other.supervisorId = store.state.office.ceoAgentId;
  }
  store.save();
  bus.emitEvent('agent.deleted', { id });
  return { ok: true };
}
