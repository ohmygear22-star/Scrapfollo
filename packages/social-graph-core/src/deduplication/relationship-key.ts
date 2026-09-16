import type { RelationshipType } from "../contracts/collection.js";
import type { Platform } from "../contracts/provider.js";

export type RelationshipDedupeKeyInput = {
  platform: Platform;
  sourceUserId: string;
  relationship: RelationshipType;
  platformUserId?: string;
  username: string;
  stableUserIds: boolean;
};

export function relationshipDedupeKey(input: RelationshipDedupeKeyInput): string {
  if (input.stableUserIds && input.platformUserId !== undefined) {
    return JSON.stringify(["stable", input.platform, input.relationship, input.platformUserId]);
  }

  return JSON.stringify([
    "fallback",
    input.platform,
    input.sourceUserId,
    input.relationship,
    input.username.toLocaleLowerCase("en-US").trim(),
  ]);
}
