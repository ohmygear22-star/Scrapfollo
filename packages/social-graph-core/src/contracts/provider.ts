export type Platform = "instagram" | "x" | "tiktok";

export type SocialGraphProviderCapabilities = {
  profileLookup: boolean;
  followerCount: boolean;
  followingCount: boolean;
  followerIdentities: boolean;
  followingIdentities: boolean;
  pagination: boolean;
  stableUserIds: boolean;
};

export type ResolveProfileInput = {
  platform: Platform;
  username: string;
};

export type FetchRelationshipPageInput = {
  profileId: string;
  cursor?: string;
  limit: number;
};

export type ProviderRequestContext = {
  runId: string;
  targetId: string;
  signal?: AbortSignal;
};

export type ProviderProfile = {
  platform: Platform;
  platformUserId: string;
  username: string;
  followerCount?: number;
  followingCount?: number;
  fullName?: string;
  isPrivate?: boolean;
  isVerified?: boolean;
  profilePicUrl?: string;
};

export type ProviderRelationshipItem = {
  platform: Platform;
  platformUserId?: string;
  username: string;
  fullName?: string;
  isPrivate?: boolean;
  isVerified?: boolean;
  profilePicUrl?: string;
};

export type ProviderRelationshipPage = {
  items: ProviderRelationshipItem[];
  nextCursor?: string;
  hasMore: boolean;
  requestMetadata: {
    requestId?: string;
    statusCode?: number;
    /** Provider diagnostic metadata only; never added to authoritative core requestsMade, requestsFailed, or requestsRetried counters. */
    attempts: number;
    bytesTransferred?: number;
    durationMs: number;
    proxyBytes?: number;
  };
};

export interface SocialGraphProvider {
  readonly providerName: string;
  readonly platform: Platform;
  readonly capabilities: SocialGraphProviderCapabilities;

  resolveProfile(
    input: ResolveProfileInput,
    context: ProviderRequestContext,
  ): Promise<ProviderProfile>;

  fetchFollowersPage(
    input: FetchRelationshipPageInput,
    context: ProviderRequestContext,
  ): Promise<ProviderRelationshipPage>;

  fetchFollowingPage(
    input: FetchRelationshipPageInput,
    context: ProviderRequestContext,
  ): Promise<ProviderRelationshipPage>;
}

export type SocialGraphProviderRegistry = ReadonlyMap<Platform, SocialGraphProvider>;
