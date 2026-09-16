const CAUGHT_STATUS = new Set([401, 403]);
const LOGIN_LOCATION_PATTERN = /login|accounts\/login|signin/i;
const LOGIN_WALL_PATTERN = /<html[^>]*>[\s\S]{0,400}(login|log in|sign in|challenge|captcha|are you a human)/i;
const IDENTITY_LIST_PATTERN = /"(users|uniqueId|secUid|followerCount|nickname)"/;
const BLOCK_SIGNATURE_PATTERN = /blocked|forbidden|too many requests|rate limit/i;

/**
 * Classifies one probe response exactly once. Ambiguous successes default
 * to CAUGHT — the spike prefers a false stop over a false pass.
 */
export type ProbeStep = "resolve" | "list";

export type SpikeVerdict = {
  verdict: "OK" | "CAUGHT" | "SOFT_LIMITED" | "NOT_FOUND" | "NETWORK_ERROR";
  reason: string;
};

export type ClassifiableResponse = {
  step: ProbeStep;
  status?: number;
  headers?: Record<string, string | undefined>;
  bodySnippet?: string;
  networkError?: unknown;
};

export function classifyResponse(input: ClassifiableResponse): SpikeVerdict {
  if (input.networkError !== undefined) {
    return { verdict: "NETWORK_ERROR", reason: String(input.networkError) };
  }
  const { step, headers, bodySnippet } = input;
  const status = input.status ?? 0;
  const location = headers?.location ?? "";
  const body = bodySnippet ?? "";

  if (status === 404) return { verdict: "NOT_FOUND", reason: "profile missing" };

  if (CAUGHT_STATUS.has(status as 401 | 403)) {
    return { verdict: "CAUGHT", reason: `HTTP ${status}` };
  }
  if ((status === 301 || status === 302) && LOGIN_LOCATION_PATTERN.test(location)) {
    return { verdict: "CAUGHT", reason: `redirect to ${location}` };
  }
  if (status === 429) {
    return { verdict: "CAUGHT", reason: "rate limit 429" };
  }
  if (LOGIN_WALL_PATTERN.test(body)) {
    return { verdict: "CAUGHT", reason: "login/challenge wall in body" };
  }
  if (status >= 500) {
    if (headers?.["retry-after"] !== undefined && !BLOCK_SIGNATURE_PATTERN.test(body)) {
      return { verdict: "SOFT_LIMITED", reason: `HTTP ${status} with retry-after` };
    }
    return { verdict: "CAUGHT", reason: `HTTP ${status}` };
  }
  if (status === 200 || (status >= 300 && status < 400)) {
    const ok =
      step === "list"
        ? IDENTITY_LIST_PATTERN.test(body) && !LOGIN_WALL_PATTERN.test(body)
        : /"(secUid|followerCount|edge_followed_by|followers)"/.test(body) || IDENTITY_LIST_PATTERN.test(body);
    if (ok) return { verdict: "OK", reason: `${step} signals present` };
    return { verdict: "CAUGHT", reason: "200 without expected signals (ambiguous defaults to caught)" };
  }
  return { verdict: "CAUGHT", reason: `unexpected status ${status}` };
}

/**
 * Hard budget enforcement per platform and rung. The probe refuses to send
 * once a rung's budget is exhausted, regardless of caller intent.
 */
export type RungBudgets = Record<string, Record<number, number>>;

export class BudgetGuard {
  readonly #budgets: RungBudgets;
  readonly #consumed = new Map<string, number>();

  constructor(budgets: RungBudgets) {
    this.#budgets = budgets;
  }

  tryConsume(platform: string, rung: number): boolean {
    const limit = this.#budgets[platform]?.[rung];
    if (limit === undefined) return false;
    const used = this.#consumed.get(`${platform}:${rung}`) ?? 0;
    if (used >= limit) return false;
    this.#consumed.set(`${platform}:${rung}`, used + 1);
    return true;
  }

  consumed(platform: string, rung: number): number {
    return this.#consumed.get(`${platform}:${rung}`) ?? 0;
  }
}

const SECRET_KEY_PATTERN = /token|password|secret|authorization|cookie|api[-_]?key/i;
const EXCERPT_LIMIT = 300;

/**
 * In-memory evidence log; the caller persists entries. Secrets are redacted
 * and body excerpts truncated before storage.
 */
export type EvidenceEntry = Record<string, unknown> & { recordedAt?: string };

export function createEvidenceLog(filePath: string): {
  filePath: string;
  record(entry: EvidenceEntry): void;
  entries(): EvidenceEntry[];
} {
  const entries: EvidenceEntry[] = [];
  return {
    filePath,
    record(entry: EvidenceEntry): void {
      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(entry)) {
        if (SECRET_KEY_PATTERN.test(key)) {
          sanitized[key] = "[REDACTED]";
        } else if (key === "bodyExcerpt" && typeof value === "string") {
          sanitized[key] = value.slice(0, EXCERPT_LIMIT);
        } else {
          sanitized[key] = value;
        }
      }
      sanitized.recordedAt = new Date().toISOString();
      entries.push(sanitized);
    },
    entries: () => [...entries],
  };
}
