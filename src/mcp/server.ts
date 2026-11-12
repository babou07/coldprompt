import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { CommandRequest, CommandResponse } from '../orchestrator.js';
import type { Store } from '../store.js';
import { formatPersistedState, sendOnce } from '../console/client.js';

/**
 * MCP server (stdio, JSON-RPC 2.0, one message per line) that gives a Claude
 * Code session the console's commands on a running plan. It is a client of
 * the orchestrator's console socket, like `coldprompt console`: it holds no
 * state, and every state change goes through the orchestrator. Commands that
 * change the worker's course are separate tools, so the user's Claude Code
 * permission settings decide which ones need a confirmation.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const MAX_TEXT = 20_000;

export interface McpDeps {
  store: Store;
  /** One console command; `waitMs` > 0 waits for the supervisor's answer (ask). */
  send: (request: CommandRequest, waitMs: number) => Promise<{ response: CommandResponse; text: string }>;
}

type Json = Record<string, any>;
interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  readOnly: boolean;
  run: (args: Json, deps: McpDeps) => Promise<string>;
}

const str = (description: string) => ({ type: 'string', description });
const schema = (properties: Json = {}, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

function clip(text: string, max = MAX_TEXT): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}

/** A console command; a refusal becomes a tool error. */
async function command(deps: McpDeps, request: CommandRequest, waitMs = 0): Promise<string> {
  let result: { response: CommandResponse; text: string };
  try {
    result = await deps.send(request, waitMs);
  } catch (error) {
    throw new Error(`ColdPrompt is not running (no orchestrator on its console socket): ${(error as Error).message}`);
  }
  if (!result.response.ok) throw new Error(result.response.error ?? 'refused');
  return result.text;
}

async function status(_args: Json, deps: McpDeps): Promise<string> {
  try {
    return await command(deps, { command: 'status' });
  } catch {
    return formatPersistedState(await deps.store.load());
  }
}

async function events(args: Json, deps: McpDeps): Promise<string> {
  const count = Math.min(Math.max(Number(args.count ?? 30), 1), 500);
  const types: string[] | undefined = Array.isArray(args.types) && args.types.length ? args.types : undefined;
  const all = await deps.store.readEvents();
  const picked = (types ? all.filter((e) => types.some((t) => e.type === t || e.type.startsWith(`${t}.`))) : all).slice(-count);
  if (!picked.length) return '(no events)';
  return picked.map((e) => `${e.timestamp} ${e.type} ${clip(JSON.stringify(e.data), 2_000)}`).join('\n');
}

const TURN_PARTS = ['worker', 'review', 'verification', 'completion'] as const;

async function turn(args: Json, deps: McpDeps): Promise<string> {
  const files = await deps.store.listArtifacts();
  const ids = [...new Set(files.map((f) => f.split('.')[0]))].sort();
  if (!ids.length) return '(no turns in this run)';
  const id = args.turnId ? ids.find((t) => t === args.turnId || t.startsWith(String(args.turnId))) : ids.at(-1);
  if (!id) return `Unknown turn "${args.turnId}". Turns: ${ids.join(', ')}`;
  const wanted = args.part && args.part !== 'all' ? [args.part] : TURN_PARTS;
  const out = [`turn ${id} (turns in this run: ${ids.length}, last ${ids.at(-1)})`];
  for (const part of wanted) {
    let value: any;
    try {
      value = JSON.parse(await readFile(join(deps.store.directory, 'turns', `${id}.${part}.json`), 'utf8'));
    } catch {
      continue;
    }
    if (part === 'worker') {
      // The mission prompt is long and known from the plan: shown on request only.
      const r = value.result ?? {};
      const commands = (r.commands ?? []).map((c: any) => `  [${c.exitCode ?? c.status}] ${clip(String(c.command), 300)}`);
      out.push(`## worker (mission ${value.missionId})`, ...(args.includePrompt ? ['### prompt', clip(String(value.prompt ?? ''))] : []),
        '### final response', clip(String(r.finalResponse ?? '')), `### commands (${commands.length})`, ...commands.slice(-60));
    } else {
      out.push(`## ${part}`, clip(JSON.stringify(value, null, 1)));
    }
  }
  return out.join('\n');
}

export const TOOLS: Tool[] = [
  {
    name: 'status', readOnly: true, run: status, inputSchema: schema(),
    description: 'Current state of the ColdPrompt run: status (RUNNING, BLOCKED, ...), session, mission, turns, block reason, last supervisor decision, proposed and approved directives, git.'
  },
  {
    name: 'events', readOnly: true, run: events,
    inputSchema: schema({
      count: { type: 'integer', description: 'How many of the last events (default 30, max 500)' },
      types: { type: 'array', items: { type: 'string' }, description: 'Only these event types or prefixes, e.g. ["runtime", "review.completed", "hot_prompt"]' }
    }),
    description: 'Last events of the run (events.jsonl): turns, reviews, blocks, hot prompts and answers, missions.'
  },
  {
    name: 'turn', readOnly: true, run: turn,
    inputSchema: schema({
      turnId: str('Turn id or prefix, e.g. "t0004" (default: the last turn)'),
      part: { type: 'string', enum: ['all', ...TURN_PARTS], description: 'Which record (default all)' },
      includePrompt: { type: 'boolean', description: 'Also show the prompt sent to the worker' }
    }),
    description: "One turn's records: the worker's final response and commands, the supervisor's review, the verification outputs (e.g. branch gate) and completion checks."
  },
  {
    name: 'directives', readOnly: true, inputSchema: schema(),
    run: async (_a, d) => command(d, { command: 'directives' }),
    description: 'Directives of the run with their status (PROPOSED needs approve).'
  },
  {
    name: 'ask_supervisor', readOnly: false, inputSchema: schema({ question: str('The question') }, ['question']),
    run: async (a, d) => command(d, { command: 'ask', text: a.question }, 600_000),
    description: 'Ask the supervisor a question about the run and wait for its answer. Never changes the worker and never resumes a blocked run; the supervisor cannot propose a directive from a question.'
  },
  {
    name: 'resume', readOnly: false, inputSchema: schema({ resolution: str('The human resolution, sent to the worker with its next turn') }, ['resolution']),
    run: async (a, d) => command(d, { command: 'resume', text: a.resolution }),
    description: "Resume a BLOCKED or FAILED run with a resolution (the worker receives it), or a PAUSED run. This is the user's decision on a block: use it only with the user's agreement."
  },
  {
    name: 'tell', readOnly: false,
    inputSchema: schema({ directive: str('The directive'), raw: { type: 'boolean', description: 'true: delivered verbatim to the worker at its next turn; false (default): the supervisor prepares a proposal that needs approve' } }, ['directive']),
    run: async (a, d) => command(d, { command: 'tell', text: a.directive, raw: Boolean(a.raw) }),
    description: 'Give the worker a directive on a running (not blocked) run: verbatim (raw) or prepared by the supervisor as a proposal to approve.'
  },
  {
    name: 'approve', readOnly: false, inputSchema: schema({ id: str('A PROPOSED directive id, or "mission" to approve a pending mission transition') }, ['id']),
    run: async (a, d) => command(d, { command: 'approve', text: a.id }),
    description: 'Approve a proposed directive (delivered at the next turn boundary), or "mission" to approve a mission transition or accept a blocked read-only mission.'
  },
  {
    name: 'reject', readOnly: false, inputSchema: schema({ id: str('A PROPOSED directive id') }, ['id']),
    run: async (a, d) => command(d, { command: 'reject', text: a.id }),
    description: 'Reject a proposed directive.'
  },
  {
    name: 'extend', readOnly: false, inputSchema: schema({ turns: { type: 'integer', minimum: 1, maximum: 100, description: 'Turns to add' } }, ['turns']),
    run: async (a, d) => command(d, { command: 'extend', text: String(a.turns) }),
    description: "Add turns to the current mission's limit; resumes a run blocked at that limit."
  },
  {
    name: 'complete', readOnly: false, inputSchema: schema(),
    run: async (_a, d) => command(d, { command: 'complete' }),
    description: 'End the current mission now if its completion checks pass (run stopped by a block or a pause).'
  },
  {
    name: 'skip', readOnly: false, inputSchema: schema(),
    run: async (_a, d) => command(d, { command: 'skip' }),
    description: 'End the current mission WITHOUT completion checks; it is marked skipped. Only on an explicit user request.'
  },
  {
    name: 'pause', readOnly: false, inputSchema: schema(),
    run: async (_a, d) => command(d, { command: 'pause' }),
    description: 'Pause the run at the next safe boundary.'
  },
  {
    name: 'stop', readOnly: false, inputSchema: schema(),
    run: async (_a, d) => command(d, { command: 'stop' }),
    description: 'Stop the orchestrator gracefully after the current turn. Only on an explicit user request.'
  }
];

const INSTRUCTIONS = 'ColdPrompt runs a plan of missions: a worker (Codex or Claude) does each turn, a supervisor reviews it. '
  + 'Read with status, events and turn. A BLOCKED run waits for a human: diagnose, propose a resolution to the user, and call resume only with their agreement. '
  + 'ask_supervisor is a question only: it never unblocks the run.';

/** Handles one JSON-RPC message; returns the reply, or undefined for a notification. */
export async function handleMessage(message: Json, deps: McpDeps): Promise<Json | undefined> {
  const { id, method, params } = message ?? {};
  const reply = (result: Json) => ({ jsonrpc: '2.0', id, result });
  const failure = (code: number, text: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message: text } });
  if (typeof method !== 'string') return failure(-32600, 'Invalid request');
  if (id === undefined) return undefined; // notifications (initialized, cancelled): nothing to do
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'coldprompt', version: '0.1.0' },
        instructions: INSTRUCTIONS
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({
        tools: TOOLS.map((t) => ({
          name: t.name, description: t.description, inputSchema: t.inputSchema,
          annotations: { readOnlyHint: t.readOnly, destructiveHint: ['skip', 'stop'].includes(t.name), openWorldHint: false }
        }))
      });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return failure(-32602, `Unknown tool: ${params?.name}`);
      const args = params?.arguments ?? {};
      for (const key of tool.inputSchema.required ?? []) {
        if (args[key] === undefined || args[key] === '') return reply({ content: [{ type: 'text', text: `Missing argument "${key}"` }], isError: true });
      }
      try {
        return reply({ content: [{ type: 'text', text: await tool.run(args, deps) }] });
      } catch (error) {
        return reply({ content: [{ type: 'text', text: (error as Error).message }], isError: true });
      }
    }
    default:
      return failure(-32601, `Method not found: ${method}`);
  }
}

/** Serves MCP on stdin/stdout until stdin closes. Logs go to stderr only. */
export async function runMcpServer(store: Store, io: { input?: Readable; output?: Writable } = {}): Promise<void> {
  const output = io.output ?? process.stdout;
  const deps: McpDeps = { store, send: (request, waitMs) => sendOnce(store.socketPath, request, waitMs) };
  const lines = createInterface({ input: io.input ?? process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: Json;
    try {
      message = JSON.parse(line);
    } catch {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      continue;
    }
    // Calls run concurrently: a long ask_supervisor must not hold up status.
    const job = handleMessage(message, deps)
      .then((reply) => { if (reply) output.write(JSON.stringify(reply) + '\n'); })
      .catch((error) => { process.stderr.write(`coldprompt mcp: ${(error as Error).message}\n`); });
    pending.add(job);
    void job.finally(() => pending.delete(job));
  }
  await Promise.all(pending);
}
