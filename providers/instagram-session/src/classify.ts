/**
 * Maps an Instagram private-API failure to the core public error taxonomy.
 *
 * Session-compromise signals (challenge / login_required / feedback_required)
 * are permanent for this run: the owned session must be refreshed by a human
 * before collection continues, so they are never retryable.
 */

import type { PublicCollectionErrorCategory } from "@social-graph/core";

export type InstagramFailureClassification = {
  category: PublicCollectionErrorCategory;
  retryable: boolean;
  /** Safe, secret-free explanation. */
  message: string;
};

const SESSION_COMPROMISED_SIGNALS =
  /login_required|feedback_required|checkpoint_required|checkpoint\/|challenge\/|two_factor_required/i;

export function classifyInstagramFailure(
  status: number,
  bodyMessage: string | undefined,
): InstagramFailureClassification {
  const message = bodyMessage === undefined || bodyMessage.trim() === ""
    ? undefined
    : bodyMessage.trim();

  if (message !== undefined && SESSION_COMPROMISED_SIGNALS.test(message)) {
    return {
      category: "PROVIDER_UNAVAILABLE",
      retryable: false,
      message: "Instagram challenged the owned session; collection must stop until the session is refreshed",
    };
  }

  if (status === 404) {
    return {
      category: "PROFILE_NOT_FOUND",
      retryable: false,
      message: "Instagram reported the target as not found",
    };
  }

  if (status === 401 || status === 403) {
    return {
      category: "PROVIDER_UNAVAILABLE",
      retryable: false,
      message: "Instagram rejected the owned session as unauthorized",
    };
  }

  if (status === 429) {
    return {
      category: "RATE_LIMITED",
      retryable: true,
      message: "Instagram rate-limited the request",
    };
  }

  if (status >= 500) {
    return {
      category: "SOURCE_TEMPORARILY_UNAVAILABLE",
      retryable: true,
      message: "Instagram returned a server error",
    };
  }

  if (status === 400) {
    return {
      category: "INVALID_INPUT",
      retryable: false,
      message: "Instagram rejected the request as invalid",
    };
  }

  return {
    category: "UNKNOWN_ERROR",
    retryable: false,
    message: "Instagram returned an unexpected failure",
  };
}
