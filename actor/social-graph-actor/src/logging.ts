const REDACTED = "[REDACTED]";

const FORBIDDEN_KEY_PATTERN = /authorization|cookie|token|password|passphrase|api[-_]?key|secret|credential/i;
const RAW_PAYLOAD_KEY_PATTERN = /raw.*response|response.*body|html|payload/i;

export type LogTraceFields = {
  run_id: string;
  target_id?: string;
  relationship?: "followers" | "following";
  page_ordinal?: number;
  request_id?: string;
  retry_ordinal?: number;
  outcome: string;
  details?: Record<string, unknown>;
};

export type LogSink = {
  write(entry: unknown): void;
};

export function redactDetails(details: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) {
      result[key] = REDACTED;
      continue;
    }
    if (RAW_PAYLOAD_KEY_PATTERN.test(key)) {
      result[key] = REDACTED;
      continue;
    }
    result[key] = redactValue(value);
  }
  return result;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 2_000 ? `${value.slice(0, 2_000)}…[truncated]` : value;
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (isPlainObject(value)) {
    return redactDetails(value);
  }
  return value;
}

export function createRunLogger(sink: LogSink) {
  return {
    event(fields: LogTraceFields): void {
      sink.write({
        ...fields,
        ...(fields.details === undefined ? {} : { details: redactDetails(fields.details) }),
      });
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}
