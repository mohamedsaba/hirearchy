/**
 * Structured secret-redacted operational logging for staging and production readiness.
 */

const SENSITIVE_KEY_PATTERNS = [
  /passw(or)?d/i,
  /secret/i,
  /private.*key/i,
  /token/i,
  /authorization/i,
  /cookie/i,
  /credential/i,
  /signature/i,
  /ciphertext/i,
];

const DATABASE_URL_REGEX =
  /(postgres(?:ql)?:\/\/)([^:@\s]+):([^@\s]+)@([^\s/]+)(?:\/([^\s?#]+))?/gi;
const BEARER_AUTH_REGEX = /Bearer\s+([A-Za-z0-9._~+/-]+=*)/gi;
const BASE64_KEY_REGEX = /\b[A-Za-z0-9+/]{43,88}={0,2}\b/g;

/**
 * Redact sensitive fields, patterns, and credentials from arbitrary data structures.
 */
export function redactSensitiveData(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    let sanitized = value;
    sanitized = sanitized.replace(
      DATABASE_URL_REGEX,
      '$1[REDACTED_USER]:[REDACTED_SECRET]@$4/$5',
    );
    sanitized = sanitized.replace(BEARER_AUTH_REGEX, 'Bearer [REDACTED_TOKEN]');
    if (
      sanitized.length > 40 &&
      !sanitized.includes(' ') &&
      BASE64_KEY_REGEX.test(sanitized)
    ) {
      return '[REDACTED_KEY]';
    }
    return sanitized;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Error) {
    return sanitizeError(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[CIRCULAR]';
    }
    seen.add(value);

    const result = {};
    for (const [key, val] of Object.entries(value)) {
      const isSensitiveKey = SENSITIVE_KEY_PATTERNS.some((pat) =>
        pat.test(key),
      );
      if (isSensitiveKey) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = redactSensitiveData(val, seen);
      }
    }
    return result;
  }

  return String(value);
}

/**
 * Sanitize error objects to prevent leaking stack traces or sensitive credentials.
 */
export function sanitizeError(error) {
  if (!error || typeof error !== 'object') {
    return {
      name: 'UnknownError',
      message: redactSensitiveData(String(error)),
    };
  }

  const rawMessage =
    typeof error.message === 'string' ? error.message : 'An error occurred';
  const cleanMessage = redactSensitiveData(rawMessage);

  return {
    name: error.name || 'Error',
    message: cleanMessage,
    ...(typeof error.code === 'string' ? { code: error.code } : {}),
  };
}

export class OperationalLogger {
  constructor() {
    this.isTest = process.env.NODE_ENV === 'test';
  }

  log(level, event, context) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...(context ? { context: redactSensitiveData(context) } : {}),
    };

    if (!this.isTest || process.env.HIREARCHY_LOG_VERBOSE === 'true') {
      const output = JSON.stringify(entry);
      if (level === 'error') {
        console.error(output);
      } else if (level === 'warn') {
        console.warn(output);
      } else {
        console.log(output);
      }
    }

    return entry;
  }

  info(event, context) {
    return this.log('info', event, context);
  }

  warn(event, context) {
    return this.log('warn', event, context);
  }

  error(event, context) {
    return this.log('error', event, context);
  }
}

export const operationalLogger = new OperationalLogger();
