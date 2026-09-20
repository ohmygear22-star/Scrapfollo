/**
 * Daily execution loop. Executors are injected per platform so the loop is
 * unit-testable: the IG executor runs the provider in-process on the droplet;
 * the TikTok executor triggers the actor run and processes its captures. An
 * executor throwing a captcha signal flips the platform into captcha-skip
 * for the rest of the day (and is recorded, never bypassed).
 */

import type { PlanAction, PlatformName, PlanInput } from "./plan.js";
import { planDailyScan } from "./plan.js";

export type ExecutorResult =
  | { outcome: "ok"; followers?: number; following?: number }
  | { outcome: "captcha" }
  | { outcome: "failed"; message: string };

export type PlatformExecutor = (action: PlanAction) => Promise<ExecutorResult>;

export type DailyRunResult = {
  executed: number;
  skipped: number;
  failed: number;
  captchaDays: PlatformName[];
  perTarget: Array<{ targetId: string; kind: PlanAction["kind"]; outcome: string }>;
};

export async function runDailyScan(input: PlanInput & {
  executors: Partial<Record<PlatformName, PlatformExecutor>>;
}): Promise<DailyRunResult> {
  const plan = planDailyScan(input);
  const result: DailyRunResult = {
    executed: 0,
    skipped: 0,
    failed: 0,
    captchaDays: [],
    perTarget: [],
  };
  const muted = new Set<PlatformName>();

  for (const action of plan) {
    const entry = { targetId: action.target.targetId, kind: action.kind, outcome: "" };
    if (action.kind === "skip") {
      entry.outcome = action.reason;
      result.skipped += 1;
      result.perTarget.push(entry);
      continue;
    }
    const executor = input.executors[action.target.platform];
    if (executor === undefined || muted.has(action.target.platform)) {
      entry.outcome = "no-executor";
      result.skipped += 1;
      result.perTarget.push(entry);
      continue;
    }
    try {
      const outcome = await executor(action);
      if (outcome.outcome === "captcha") {
        muted.add(action.target.platform);
        result.captchaDays.push(action.target.platform);
        entry.outcome = "captcha-day";
        result.skipped += 1;
      } else if (outcome.outcome === "failed") {
        entry.outcome = "failed";
        result.failed += 1;
      } else {
        entry.outcome = "ok";
        result.executed += 1;
      }
    } catch (error) {
      entry.outcome = `error: ${error instanceof Error ? error.name : "unknown"}`;
      result.failed += 1;
    }
    result.perTarget.push(entry);
  }
  return result;
}
