import type { CollectRelationshipRequest } from "../contracts/collection.js";
import type { ProviderProfile, SocialGraphProvider } from "../contracts/provider.js";
import { CollectionError } from "../errors/collection-error.js";
import { normalizeProviderError } from "../errors/normalize-error.js";

export async function resolveProfile(
  request: Pick<
    CollectRelationshipRequest,
    "runId" | "targetId" | "platform" | "username" | "signal"
  >,
  provider: SocialGraphProvider,
): Promise<ProviderProfile> {
  const context = { platform: request.platform, targetId: request.targetId };

  if (request.platform !== provider.platform) {
    throw new CollectionError({
      category: "INVALID_INPUT",
      message: "Request platform does not match provider platform",
      retryable: false,
      ...context,
    });
  }

  if (!provider.capabilities.profileLookup) {
    throw new CollectionError({
      category: "CAPABILITY_UNSUPPORTED",
      message: "Provider does not support profile lookup",
      retryable: false,
      ...context,
    });
  }

  let profile: ProviderProfile;
  try {
    profile = await provider.resolveProfile(
      { platform: request.platform, username: request.username },
      {
        runId: request.runId,
        targetId: request.targetId,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
    );
  } catch (error) {
    throw normalizeProviderError(error, context);
  }

  if (profile.platform !== provider.platform) {
    throw new CollectionError({
      category: "INVALID_INPUT",
      message: "Resolved profile platform does not match provider platform",
      retryable: false,
      ...context,
    });
  }

  return {
    platform: profile.platform,
    platformUserId: profile.platformUserId,
    username: profile.username,
    ...(profile.fullName === undefined ? {} : { fullName: profile.fullName }),
    ...(profile.isPrivate === undefined ? {} : { isPrivate: profile.isPrivate }),
    ...(profile.isVerified === undefined ? {} : { isVerified: profile.isVerified }),
    ...(profile.profilePicUrl === undefined ? {} : { profilePicUrl: profile.profilePicUrl }),
    ...(!provider.capabilities.followerCount || profile.followerCount === undefined
      ? {}
      : { followerCount: profile.followerCount }),
    ...(!provider.capabilities.followingCount || profile.followingCount === undefined
      ? {}
      : { followingCount: profile.followingCount }),
  };
}
