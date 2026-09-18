import { describe, expect, it } from "vitest";
import { decideDiffAction, diffSnapshotMembership } from "../src/diff.js";

describe("diffSnapshotMembership (§10 set semantics)", () => {
  it("maps following additions and removals to NEW_FOLLOWING / UNFOLLOWED", () => {
    const diff = diffSnapshotMembership({
      direction: "following",
      previousMembership: ["a", "b", "c"],
      currentMembership: ["b", "c", "d"],
    });
    expect(diff.added).toEqual(["d"]);
    expect(diff.removed).toEqual(["a"]);
    expect(diff.changeTypes).toEqual({ added: "NEW_FOLLOWING", removed: "UNFOLLOWED" });
  });

  it("maps follower changes to NEW_FOLLOWER / LOST_FOLLOWER", () => {
    const diff = diffSnapshotMembership({
      direction: "followers",
      previousMembership: ["x"],
      currentMembership: ["y"],
    });
    expect(diff.changeTypes).toEqual({ added: "NEW_FOLLOWER", removed: "LOST_FOLLOWER" });
  });

  it("is order-insensitive and duplicate-tolerant on both sides", () => {
    const diff = diffSnapshotMembership({
      direction: "following",
      previousMembership: ["b", "a", "a"],
      currentMembership: ["a", "b", "a"],
    });
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("handles empty previous (everything added) and empty current (everything removed)", () => {
    expect(
      diffSnapshotMembership({ direction: "following", previousMembership: [], currentMembership: ["n1", "n2"] }).added,
    ).toEqual(["n1", "n2"]);
    expect(
      diffSnapshotMembership({ direction: "following", previousMembership: ["o1"], currentMembership: [] }).removed,
    ).toEqual(["o1"]);
  });
});

describe("decideDiffAction (§6 completeness governance)", () => {
  const base = {
    direction: "following" as const,
    currentComplete: true,
    currentTermination: "SOURCE_EXHAUSTED",
    previousSnapshotComplete: true,
    isBaseline: false,
  };

  it("full diff only for comparable complete observations", () => {
    expect(decideDiffAction(base)).toMatchObject({ action: "diff" });
  });

  it("first complete observation is the baseline (no changes, §10)", () => {
    expect(decideDiffAction({ ...base, isBaseline: true })).toMatchObject({ action: "baseline" });
  });

  it("incomplete current collection promotes nothing", () => {
    expect(decideDiffAction({ ...base, currentComplete: false, currentTermination: "ABORTED" }))
      .toMatchObject({ action: "skip" });
  });

  it("MAX_LIMIT_REACHED is complete but suppresses removals", () => {
    expect(decideDiffAction({ ...base, currentTermination: "MAX_LIMIT_REACHED" }))
      .toMatchObject({ action: "skip-removals" });
  });

  it("incomplete comparison snapshot suppresses removals", () => {
    expect(decideDiffAction({ ...base, previousSnapshotComplete: false }))
      .toMatchObject({ action: "skip-removals" });
  });
});
