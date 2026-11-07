export type LogLevel = 'silent' | 'error' | 'info' | 'debug';
export type LogSink = (line: string, level: Exclude<LogLevel, 'silent'>) => void;

const rank: Record<LogLevel, number> = { silent: 0, error: 1, info: 2, debug: 3 };

/** Small, failure-proof logger. Callers should pass only already-sanitized fields. */
export class ManagerLogger {
  constructor(private readonly level: LogLevel = 'info', private readonly sink: LogSink = line => process.stderr.write(`${line}\n`)) {}
  log(level: Exclude<LogLevel, 'silent'>, message: string): void {
    if (this.level === 'silent' || rank[level] > rank[this.level]) return;
    const singleLine = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 1000);
    try { this.sink(`${new Date().toISOString()} ${level.toUpperCase()} ${singleLine}`, level); } catch { /* logging must never affect the manager */ }
  }
}

export function safeEndpoint(value: string): string {
  try { const url = new URL(value); return url.origin; }
  catch { return '<endpoint>'; }
}

export function errorCode(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  const code = (error as { code?: unknown } | null)?.code ?? cause?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : error instanceof Error ? error.name : 'Error';
}
