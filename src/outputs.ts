/**
 * Structured mission outputs (execution.output): the worker ends its final
 * answer with one fenced block
 *
 *   ```coldprompt-output <name>
 *   { ...JSON... }
 *   ```
 *
 * This is data handed to a later step, never a control decision: the
 * supervisor still decides on the mission from the evidence.
 */

export const OUTPUT_FENCE = 'coldprompt-output';

/** Upper bound for one output (the block is copied into later prompts). */
export const MAX_OUTPUT_CHARS = 200_000;

export function outputInstruction(name: string): string {
  return [
    `This mission delivers the structured output "${name}". In the turn where you deliver it, end your final answer with exactly one block:`,
    '```' + `${OUTPUT_FENCE} ${name}`,
    '<one JSON value, as specified in the mission>',
    '```',
    'Only strict JSON inside the block (no comments, no trailing commas). The mission cannot complete without a valid block.'
  ].join('\n');
}

export type ExtractedOutput =
  | { found: false }
  | { found: true; ok: true; value: unknown }
  | { found: true; ok: false; error: string };

/** The last `coldprompt-output <name>` block of a worker answer. */
export function extractOutput(text: string, name: string): ExtractedOutput {
  const fence = new RegExp('^```' + OUTPUT_FENCE + '[ \\t]+' + name.replace(/[-]/g, '\\-') + '[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```[ \\t]*$', 'gm');
  let last: string | undefined;
  for (const match of text.matchAll(fence)) last = match[1];
  if (last === undefined) return { found: false };
  if (last.length > MAX_OUTPUT_CHARS) return { found: true, ok: false, error: `the block is larger than ${MAX_OUTPUT_CHARS} characters` };
  try {
    return { found: true, ok: true, value: JSON.parse(last) };
  } catch (error) {
    return { found: true, ok: false, error: `invalid JSON: ${(error as Error).message}` };
  }
}
