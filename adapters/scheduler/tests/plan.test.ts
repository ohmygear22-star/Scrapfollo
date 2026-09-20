import { describe, expect, it } from "vitest";
import { planDailyScan, type TargetState } from "../src/plan.js";

const NOW = new Date("2026-09-20T03:00:00Z"); // Sunday
const STATE: TargetState = {
  targetId: "t1",
  platform: "instagram",
  username: "idol",
  lastFollowerCount: 1_000,
  lastFollowingCount: 300,
  lastFullPullAt: new Date("2026-09-19T03:00:00Z"),
};

describe("planDailyScan discipline rules", () => {
  it("first target gets a full baseline pull", () => {
    const actions = planDailyScan({
      targets: [{ ...STATE, lastFullPullAt: null, lastFollowingCount: null }],
      todayCounts: {},
      now: NOW,
      freezes: {},
      captchaSkipUntil: {},
      weeklyFullDay: 0,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "full", reason: "first-baseline" });
  });

  it("unchanged counts on a non-forced day stay counts-only", () => {
    const actions = planDailyScan({
      targets: [STATE],
      todayCounts: { t1: { followers: 1_000, following: 300 } },
      now: new Date("2026-09-18T03:00:00Z"), // Friday
      freezes: {},
      captchaSkipUntil: {},
      weeklyFullDay: 0,
    });
    expect(actions[0]).toMatchObject({ kind: "counts" });
  });

  it("changed counts trigger a full pull the same day", () => {
    const actions = planDailyScan({
      targets: [STATE],
      todayCounts: { t1: { followers: 1_000, following: 301 } },
      now: new Date("2026-09-18T03:00:00Z"),
      freezes: {},
      captchaSkipUntil: {},
      weeklyFullDay: 0,
    });
    expect(actions[0]).toMatchObject({ kind: "full", reason: "count-changed" });
  });

  it("weekly window forces a full pull even with unchanged counts", () => {
    const actions = planDailyScan({
      targets: [{ ...STATE, lastFullPullAt: new Date("2026-09-12T03:00:00Z") }],
      todayCounts: { t1: { followers: 1_000, following: 300 } },
      now: NOW,
      freezes: {},
      captchaSkipUntil: {},
      weeklyFullDay: 0,
    });
    expect(actions[0]).toMatchObject({ kind: "full", reason: "weekly-forced" });
  });

  it("a recent full pull suppresses the weekly force", () => {
    const actions = planDailyScan({
      targets: [STATE], // pulled yesterday
      todayCounts: { t1: { followers: 1_000, following: 300 } },
      now: NOW,
      freezes: {},
      captchaSkipUntil: {},
      weeklyFullDay: 0,
    });
    expect(actions[0]).toMatchObject({ kind: "counts", reason: "after-full" });
  });

  it("missing counts probe falls back to counts-only", () => {
    const actions = planDailyScan({
      targets: [STATE],
      todayCounts: {},
      now: NOW,
      freezes: {},
      captchaSkipUntil: {},
      weeklyFullDay: 3,
    });
    expect(actions[0]).toMatchObject({ kind: "counts", reason: "routine-counts" });
  });

  it("frozen platforms are skipped entirely until the freeze lifts", () => {
    const actions = planDailyScan({
      targets: [STATE, { ...STATE, targetId: "t2", platform: "tiktok", username: "idol2" }],
      todayCounts: {},
      now: NOW,
      freezes: { instagram: new Date("2026-10-01T00:00:00Z") },
      captchaSkipUntil: {},
      weeklyFullDay: 0,
    });
    expect(actions[0]).toMatchObject({ kind: "skip", reason: "platform-frozen" });
    expect(actions[1]).not.toMatchObject({ kind: "skip" });
  });

  it("captcha-day skips the whole platform", () => {
    const actions = planDailyScan({
      targets: [{ ...STATE, platform: "tiktok", targetId: "t2" }],
      todayCounts: {},
      now: NOW,
      freezes: {},
      captchaSkipUntil: { tiktok: new Date("2026-09-20T23:59:00Z") },
      weeklyFullDay: 0,
    });
    expect(actions[0]).toMatchObject({ kind: "skip", reason: "captcha-day" });
  });
});
