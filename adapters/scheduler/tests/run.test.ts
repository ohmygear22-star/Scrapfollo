import { describe, expect, it } from "vitest";
import { runDailyScan, type PlatformExecutor } from "../src/run.js";
import type { PlanInput, TargetState } from "../src/plan.js";

const STATE: TargetState = {
  targetId: "t1",
  platform: "tiktok",
  username: "idol",
  lastFollowerCount: null,
  lastFollowingCount: null,
  lastFullPullAt: null,
};

const INPUT: Omit<PlanInput, "targets"> = {
  todayCounts: {},
  now: new Date("2026-09-20T03:00:00Z"),
  freezes: {},
  captchaSkipUntil: {},
  weeklyFullDay: 0,
};

describe("runDailyScan loop", () => {
  it("executes planned actions through the platform executor", async () => {
    const calls: string[] = [];
    const executor: PlatformExecutor = async (action) => {
      calls.push(`${action.target.targetId}:${action.kind}`);
      return { outcome: "ok", followers: 10, following: 2 };
    };
    const result = await runDailyScan({
      ...INPUT,
      targets: [STATE, { ...STATE, targetId: "t2" }],
      executors: { tiktok: executor },
    });
    expect(result.executed).toBe(2);
    expect(result.failed).toBe(0);
    expect(calls).toEqual(["t1:full", "t2:full"]);
  });

  it("a captcha outcome mutes the platform for the rest of the day", async () => {
    let call = 0;
    const executor: PlatformExecutor = async () => {
      call += 1;
      return call === 1 ? { outcome: "captcha" } : { outcome: "ok" };
    };
    const result = await runDailyScan({
      ...INPUT,
      targets: [STATE, { ...STATE, targetId: "t2" }, { ...STATE, targetId: "t3" }],
      executors: { tiktok: executor },
    });
    expect(result.executed).toBe(0);
    expect(result.captchaDays).toEqual(["tiktok"]);
    expect(result.perTarget.map((p) => p.outcome)).toEqual(["captcha-day", "no-executor", "no-executor"]);
  });

  it("failures are isolated per target", async () => {
    const executor: PlatformExecutor = async (action) =>
      action.target.targetId === "t1" ? { outcome: "failed", message: "boom" } : { outcome: "ok" };
    const result = await runDailyScan({
      ...INPUT,
      targets: [STATE, { ...STATE, targetId: "t2" }],
      executors: { tiktok: executor },
    });
    expect(result.failed).toBe(1);
    expect(result.executed).toBe(1);
  });

  it("executor crashes are recorded, never crash the loop", async () => {
    const executor: PlatformExecutor = async () => {
      throw new Error("exploded");
    };
    const result = await runDailyScan({
      ...INPUT,
      targets: [STATE],
      executors: { tiktok: executor },
    });
    expect(result.failed).toBe(1);
    expect(result.perTarget[0]?.outcome).toContain("error");
  });

  it("platforms without an executor are skipped (dormant deployment)", async () => {
    const result = await runDailyScan({ ...INPUT, targets: [STATE], executors: {} });
    expect(result.skipped).toBe(1);
    expect(result.perTarget[0]?.outcome).toBe("no-executor");
  });
});
