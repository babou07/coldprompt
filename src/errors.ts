export type ErrorKind =
  | 'TRANSIENT_CAPACITY'
  | 'SESSION_LOCK'
  | 'INVALID_CONFIG'
  | 'AUTHENTICATION'
  | 'UNSAFE_REPOSITORY'
  | 'CANCELLED'
  | 'PERMANENT';

export class ColdPromptError extends Error {
  constructor(readonly kind: ErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ColdPromptError';
  }
}

const CAPACITY = /\b(429|500|502|503|504|529)\b|rate.?limit|overloaded|capacity|too many requests|temporarily unavailable|service unavailable|try again later|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|stream disconnected/i;
const SESSION_LOCK = /active[ _-]?writer|another (codex )?(process|writer|instance)|already (in use|being written|running)|thread[^\n]*(locked|in use|busy)|lock(ed)? by|could not acquire[^\n]*lock|EBUSY/i;
const AUTH = /\b(401|403)\b|unauthori[sz]ed|authenticat|not logged in|login required|invalid api key|invalid_api_key|forbidden|credential/i;

/** Classifies an arbitrary provider error. Explicit ColdPromptError kinds win. */
export function classifyError(error: unknown): ErrorKind {
  if (error instanceof ColdPromptError) return error.kind;
  if (error instanceof Error && error.name === 'AbortError') return 'CANCELLED';
  const message = errorMessage(error);
  if (SESSION_LOCK.test(message)) return 'SESSION_LOCK';
  if (AUTH.test(message)) return 'AUTHENTICATION';
  if (CAPACITY.test(message)) return 'TRANSIENT_CAPACITY';
  return 'PERMANENT';
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const SECRET_KEY = /(api_?key|_key$|^key$|token|secret|password|passwd|credential|authorization|cookie)/i;

/** Values of secret-looking environment variables, masked from all logs. */
function secretValues(): string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => SECRET_KEY.test(name) && typeof value === 'string' && value.length >= 8)
    .map(([, value]) => value as string);
}

export function redact(text: string): string {
  let out = text;
  for (const value of secretValues()) out = out.split(value).join('[REDACTED]');
  return out
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/(authorization:\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED]');
}

/** Deep-redacts a JSON-compatible value (keys that look secret are masked entirely). */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) && typeof v === 'string' ? '[REDACTED]' : redactValue(v);
    }
    return out;
  }
  return value;
}
