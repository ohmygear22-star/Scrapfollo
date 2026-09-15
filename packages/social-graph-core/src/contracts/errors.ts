export type PublicCollectionErrorCategory =
  | "PROFILE_NOT_FOUND"
  | "PROFILE_UNAVAILABLE"
  | "PRIVATE_PROFILE_UNSUPPORTED"
  | "CAPABILITY_UNSUPPORTED"
  | "PROVIDER_UNAVAILABLE"
  | "RATE_LIMITED"
  | "SOURCE_TEMPORARILY_UNAVAILABLE"
  | "PAGINATION_FAILED"
  | "INVALID_INPUT"
  | "UNKNOWN_ERROR";

export type PublicCollectionError = {
  category: PublicCollectionErrorCategory;
  message: string;
  retryable: boolean;
  platform?: import("./provider.js").Platform;
  targetId?: string;
};
