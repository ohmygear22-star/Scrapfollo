import type {
  Platform,
  PublicCollectionErrorCategory,
  ProviderProfile,
  ProviderRelationshipItem,
  SocialGraphProviderCapabilities,
} from "@social-graph/core";

export type FakeProfileScenario = Readonly<{
  profile: ProviderProfile;
  followers: ReadonlyArray<ReadonlyArray<ProviderRelationshipItem>>;
  following: ReadonlyArray<ReadonlyArray<ProviderRelationshipItem>>;
}>;

export type FakeProviderScenario = Readonly<{
  platform: Platform;
  capabilities: SocialGraphProviderCapabilities;
  errors?: Partial<Record<FakeProviderOperation, FakeProviderErrorDefinition>>;
  profiles: Readonly<Record<string, FakeProfileScenario>>;
}>;

export type FakeProviderOperation =
  | "resolveProfile"
  | "fetchFollowersPage"
  | "fetchFollowingPage";

export type FakeProviderCall = Readonly<{
  operation: FakeProviderOperation;
  runId: string;
  targetId: string;
  username?: string;
  profileId?: string;
  cursor?: string;
}>;

export type FakeProviderErrorDefinition = Readonly<{
  category: PublicCollectionErrorCategory;
  message: string;
  retryable: boolean;
}>;
