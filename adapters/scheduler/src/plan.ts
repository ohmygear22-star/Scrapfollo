/**
 * Daily collection planner — production discipline as pure code.
 *
 * Rules (owner decisions 2026-09-17/18):
 *   - frozen platforms produce skip actions until their freeze lifts
 *     (IG automated-behaviour warning, 2026-09-17);
 *   - counts-first: a target gets a full pull only when its counts changed,
 *     when it has never been pulled, or when the weekly forced window
 *     arrived (same-day follow+unfollow pairs must surface within a week);
 *   - captcha-skip: a platform that hit a challenge yesterday is skipped
 *     for the whole day; never solved, never bypassed.
 */

export type PlatformName = "instagram" | "tiktok";

export type TargetState = {
  targetId: string;
  platform: PlatformName;
  username: string;
  lastFollowerCount: number | null;
  lastFollowingCount: number | null;
  lastFullPullAt: Date | null;
};

export type PlanInput = {
  targets: TargetState[];
  todayCounts: Partial<Record<string, { followers: number; following: number }>>;
  now: Date;
  freezes: Partial<Record<PlatformName, Date>>;
  captchaSkipUntil: Partial<Record<PlatformName, Date>>;
  weeklyFullDay: number;
};

export type PlanAction =
  | { kind: "counts"; target: TargetState; reason: "routine-counts" | "after-full" }
  | { kind: "full"; target: TargetState; reason: "first-baseline" | "count-changed" | "weekly-forced" }
  | { kind: "skip"; target: TargetState; reason: "platform-frozen" | "captcha-day" };

const DAY_MS = 24 * 60 * 60 * 1_000;

export function planDailyScan(input: PlanInput): PlanAction[] {
  const actions: PlanAction[] = [];
  const weekday = input.now.getUTCDay();
  const weeklyWindow = weekday === input.weeklyFullDay;

  for (const target of input.targets) {
    const freezeUntil = input.freezes[target.platform];
    if (freezeUntil !== undefined && input.now < freezeUntil) {
      actions.push({ kind: "skip", target, reason: "platform-frozen" });
      continue;
    }
    const captchaUntil = input.captchaSkipUntil[target.platform];
    if (captchaUntil !== undefined && input.now < captchaUntil) {
      actions.push({ kind: "skip", target, reason: "captcha-day" });
      continue;
    }

    const counts = input.todayCounts[target.targetId];
    const neverPulled = target.lastFullPullAt === null || target.lastFollowingCount === null;
    if (neverPulled) {
      actions.push({ kind: "full", target, reason: "first-baseline" });
      continue;
    }
    if (counts === undefined) {
      // The counts probe itself failed or has not run; nothing to compare.
      actions.push({ kind: "counts", target, reason: "routine-counts" });
      continue;
    }
    const countChanged =
      (target.lastFollowerCount !== null && counts.followers !== target.lastFollowerCount)
      || counts.following !== target.lastFollowingCount;
    if (countChanged) {
      actions.push({ kind: "full", target, reason: "count-changed" });
      continue;
    }
    const daysSinceFull = (input.now.getTime() - (target.lastFullPullAt?.getTime() ?? 0)) / DAY_MS;
    if (weeklyWindow && daysSinceFull >= 6) {
      actions.push({ kind: "full", target, reason: "weekly-forced" });
      continue;
    }
    actions.push({ kind: "counts", target, reason: "after-full" });
  }
  return actions;
}
