import type { CommandRequest, CommandResponse, OrchestratorEvent } from '../orchestrator.js';

export const MAX_LINE_BYTES = 1024 * 1024;

export type ClientMessage = CommandRequest & { id: string };

export type ServerMessage =
  | { type: 'hello'; version: 1; status: unknown }
  | ({ type: 'response'; id: string } & CommandResponse)
  | { type: 'event'; event: OrchestratorEvent };

/** "tell --raw do X" -> { command: 'tell', raw: true, text: 'do X' } */
export function parseCommandLine(line: string): CommandRequest | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/^(\S+)\s*([\s\S]*)$/)!;
  const command = match[1].toLowerCase();
  let text = match[2];
  let raw = false;
  if (command === 'tell' && /^--raw(\s|$)/.test(text)) {
    raw = true;
    text = text.replace(/^--raw\s*/, '');
  }
  return { command, text, raw };
}
