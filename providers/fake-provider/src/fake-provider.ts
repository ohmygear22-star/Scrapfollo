import type {
  FetchRelationshipPageInput,
  Platform,
  PublicCollectionErrorCategory,
  ProviderProfile,
  ProviderRelationshipPage,
  ProviderRequestContext,
  ResolveProfileInput,
  SocialGraphProvider,
  SocialGraphProviderCapabilities,
} from "@social-graph/core";
import type {
  FakeProfileScenario,
  FakeProviderCall,
  FakeProviderOperation,
  FakeProviderScenario,
} from "./scenario.js";

export class FakeProviderError extends Error {
  readonly category: PublicCollectionErrorCategory;
  readonly retryable: boolean;

  constructor(
    category: PublicCollectionErrorCategory,
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = "FakeProviderError";
    this.category = category;
    this.retryable = retryable;
  }
}

export class FakeProvider implements SocialGraphProvider {
  readonly providerName = "fake";
  readonly platform: Platform;
  readonly capabilities: SocialGraphProviderCapabilities;

  readonly #scenario: FakeProviderScenario;
  readonly #calls: FakeProviderCall[] = [];

  private constructor(scenario: FakeProviderScenario) {
    validateScenario(scenario);
    this.#scenario = scenario;
    this.platform = scenario.platform;
    this.capabilities = Object.freeze({ ...scenario.capabilities });
  }

  static fromScenario(scenario: FakeProviderScenario): FakeProvider {
    return new FakeProvider(scenario);
  }

  get calls(): ReadonlyArray<FakeProviderCall> {
    return this.#calls;
  }

  async resolveProfile(
    input: ResolveProfileInput,
    context: ProviderRequestContext,
  ): Promise<ProviderProfile> {
    throwIfAborted(context);
    this.#record("resolveProfile", context, { username: input.username });
    this.#throwConfiguredError("resolveProfile");
    if (input.platform !== this.platform) {
      throw new FakeProviderError(
        "INVALID_INPUT",
        `Expected platform ${this.platform}, received ${input.platform}`,
      );
    }

    const profile = this.#scenario.profiles[input.username];
    if (profile === undefined) {
      throw new FakeProviderError(
        "PROFILE_NOT_FOUND",
        `Profile ${input.username} was not found`,
      );
    }

    return { ...profile.profile };
  }

  async fetchFollowersPage(
    input: FetchRelationshipPageInput,
    context: ProviderRequestContext,
  ): Promise<ProviderRelationshipPage> {
    return this.#fetchPage("fetchFollowersPage", "followers", input, context);
  }

  async fetchFollowingPage(
    input: FetchRelationshipPageInput,
    context: ProviderRequestContext,
  ): Promise<ProviderRelationshipPage> {
    return this.#fetchPage("fetchFollowingPage", "following", input, context);
  }

  async #fetchPage(
    operation: Exclude<FakeProviderOperation, "resolveProfile">,
    relationship: "followers" | "following",
    input: FetchRelationshipPageInput,
    context: ProviderRequestContext,
  ): Promise<ProviderRelationshipPage> {
    throwIfAborted(context);
    this.#record(operation, context, {
      profileId: input.profileId,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
    this.#throwConfiguredError(operation);
    const profile = findProfileById(this.#scenario.profiles, input.profileId);
    if (profile === undefined) {
      throw new FakeProviderError(
        "PROFILE_NOT_FOUND",
        `Profile ID ${input.profileId} was not found`,
      );
    }

    const pages = profile[relationship];
    const pageIndex = input.cursor === undefined
      ? 0
      : this.#pageIndexFromCursor(input.cursor, input.profileId, relationship);
    const items = pages[pageIndex] ?? [];
    const hasMore = pageIndex + 1 < pages.length;

    return {
      items: items.map((item) => ({ ...item })),
      ...(hasMore
        ? { nextCursor: cursorFor(input.profileId, relationship, pageIndex + 1) }
        : {}),
      hasMore,
      requestMetadata: {
        attempts: 1,
        durationMs: 0,
      },
    };
  }

  #pageIndexFromCursor(
    cursor: string,
    profileId: string,
    relationship: "followers" | "following",
  ): number {
    const pages = findProfileById(this.#scenario.profiles, profileId)?.[relationship] ?? [];

    for (let pageIndex = 1; pageIndex < pages.length; pageIndex += 1) {
      if (cursor === cursorFor(profileId, relationship, pageIndex)) {
        return pageIndex;
      }
    }

    throw new FakeProviderError("INVALID_INPUT", "Unknown or mismatched fake cursor");
  }

  #record(
    operation: FakeProviderOperation,
    context: ProviderRequestContext,
    details: Pick<FakeProviderCall, "username" | "profileId" | "cursor">,
  ): void {
    this.#calls.push({
      operation,
      runId: context.runId,
      targetId: context.targetId,
      ...details,
    });
  }

  #throwConfiguredError(operation: FakeProviderOperation): void {
    const error = this.#scenario.errors?.[operation];
    if (error !== undefined) {
      throw new FakeProviderError(error.category, error.message, error.retryable);
    }
  }
}

function cursorFor(
  profileId: string,
  relationship: "followers" | "following",
  pageIndex: number,
): string {
  return `fake:${profileId}:${relationship}:${pageIndex}`;
}

function findProfileById(
  profiles: FakeProviderScenario["profiles"],
  profileId: string,
): FakeProfileScenario | undefined {
  return Object.values(profiles).find(
    ({ profile }) => profile.platformUserId === profileId,
  );
}

function throwIfAborted(context: ProviderRequestContext): void {
  context.signal?.throwIfAborted();
}

function validateScenario(scenario: FakeProviderScenario): void {
  for (const [username, profileScenario] of Object.entries(scenario.profiles)) {
    if (profileScenario.profile.platform !== scenario.platform) {
      throw new TypeError(`Profile ${username} has a mismatched platform`);
    }

    for (const pages of [profileScenario.followers, profileScenario.following]) {
      for (const page of pages) {
        for (const item of page) {
          if (item.platform !== scenario.platform) {
            throw new TypeError(`Relationship item for ${username} has a mismatched platform`);
          }
        }
      }
    }
  }
}
