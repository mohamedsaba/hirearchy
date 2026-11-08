export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface StructuredLogEntry {
  timestamp: string;
  level: LogLevel;
  event: string;
  context?: Record<string, unknown>;
}

export declare function redactSensitiveData(
  value: unknown,
  seen?: WeakSet<object>,
): unknown;

export declare function sanitizeError(error: unknown): {
  name: string;
  message: string;
  code?: string;
};

export declare class OperationalLogger {
  log(
    level: LogLevel,
    event: string,
    context?: Record<string, unknown>,
  ): StructuredLogEntry;
  info(event: string, context?: Record<string, unknown>): StructuredLogEntry;
  warn(event: string, context?: Record<string, unknown>): StructuredLogEntry;
  error(event: string, context?: Record<string, unknown>): StructuredLogEntry;
}

export declare const operationalLogger: OperationalLogger;
