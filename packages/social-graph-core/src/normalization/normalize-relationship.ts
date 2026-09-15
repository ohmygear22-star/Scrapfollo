import type {
  NormalizedRelationship,
  RelationshipType,
} from "../contracts/collection.js";
import type {
  ProviderProfile,
  ProviderRelationshipItem,
} from "../contracts/provider.js";

export type NormalizeRelationshipInput = {
  sourceProfile: ProviderProfile;
  relationship: RelationshipType;
  item: ProviderRelationshipItem;
  position: number;
  scrapedAt: string;
};

export function normalizeRelationship(
  input: NormalizeRelationshipInput,
): NormalizedRelationship {
  const { sourceProfile, relationship, item, position, scrapedAt } = input;

  return {
    platform: item.platform,
    sourceUserId: sourceProfile.platformUserId,
    sourceUsername: sourceProfile.username,
    relationship,
    ...(item.platformUserId === undefined ? {} : { userId: item.platformUserId }),
    username: item.username,
    ...(item.fullName === undefined ? {} : { fullName: item.fullName }),
    ...(item.isPrivate === undefined ? {} : { isPrivate: item.isPrivate }),
    ...(item.isVerified === undefined ? {} : { isVerified: item.isVerified }),
    ...(item.profilePicUrl === undefined ? {} : { profilePicUrl: item.profilePicUrl }),
    position,
    scrapedAt,
  };
}
