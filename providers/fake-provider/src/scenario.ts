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
  /** Fails every call to the operation (deterministic provider failure). */
  errors?: Partial<Record<FakeProviderOperation, FakeProviderErrorDefinition>>;
  /**
   * Fails the Nth call to an operation when schedule entry N-1 is defined,
   * then behaves normally afterwards. Enables transient-failure testing.
   */
  failureSchedules?: Partial<Record<FakeProviderOperation, ReadonlyArray<FakeProviderErrorDefinition | undefined>>>;
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
