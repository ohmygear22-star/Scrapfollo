/**
 * Snapshot diff semantics (V1 design §10 + §6 completeness rules).
 *
 * Diff keys are stable platform IDs. Removals are produced ONLY when both
 * the current collection is complete (SOURCE_EXHAUSTED) and the comparison
 * snapshot for that relationship type was also complete — the caller passes
 * both facts in, this engine never inspects counts, cursors, or provider
 * metadata (§6: consumers must not override completeness by inspection).
 */

export type RelationshipDirection = "followers" | "following";

export type DiffChangeType = "NEW_FOLLOWING" | "UNFOLLOWED" | "NEW_FOLLOWER" | "LOST_FOLLOWER";

export type MembershipDiff = {
  added: string[];
  removed: string[];
  changeTypes: { added: DiffChangeType; removed: DiffChangeType };
};

const CHANGE_TYPES: Record<RelationshipDirection, { added: DiffChangeType; removed: DiffChangeType }> = {
  followers: { added: "NEW_FOLLOWER", removed: "LOST_FOLLOWER" },
  following: { added: "NEW_FOLLOWING", removed: "UNFOLLOWED" },
};

export function diffSnapshotMembership(input: {
  direction: RelationshipDirection;
  previousMembership: Iterable<string>;
  currentMembership: Iterable<string>;
}): MembershipDiff {
  const previous = new Set(input.previousMembership);
  const current = new Set(input.currentMembership);
  const added: string[] = [];
  const removed: string[] = [];
  for (const id of current) {
    if (!previous.has(id)) added.push(id);
  }
  for (const id of previous) {
    if (!current.has(id)) removed.push(id);
  }
  return {
    added,
    removed,
    changeTypes: CHANGE_TYPES[input.direction],
  };
}

export type DiffDecisionInput = {
  direction: RelationshipDirection;
  currentComplete: boolean;
  currentTermination: string;
  previousSnapshotComplete: boolean;
  isBaseline: boolean;
};

export type DiffDecision =
  | { action: "baseline"; reason: string }
  | { action: "diff"; reason: string }
  | { action: "skip-removals"; reason: string }
  | { action: "skip"; reason: string };

/**
 * Decides what a completed collection may do against its comparison
 * snapshot: first complete observation marks the baseline (no changes),
 * later comparable complete observations diff fully, incomplete current
 * collections may surface additions only via staging but never removals,
 * and incomplete comparison snapshots suppress removals entirely.
 */
export function decideDiffAction(input: DiffDecisionInput): DiffDecision {
  if (!input.currentComplete) {
    return {
      action: "skip",
      reason: "current collection incomplete; staging retained, nothing promoted",
    };
  }
  if (input.isBaseline) {
    return { action: "baseline", reason: "first complete observation for this relationship type" };
  }
  if (!input.previousSnapshotComplete) {
    return {
      action: "skip-removals",
      reason: "comparison snapshot was incomplete; additions promoted, removals suppressed",
    };
  }
  if (input.currentTermination !== "SOURCE_EXHAUSTED") {
    return {
      action: "skip-removals",
      reason: `current termination ${input.currentTermination} is not SOURCE_EXHAUSTED; removals suppressed`,
    };
  }
  return { action: "diff", reason: "comparable complete observations; full diff" };
}
