import { describe, expect, it, vi } from "vitest";
import { collectTargets } from "../src/index.js";
import type {
  CollectTargetsRequest,
  Platform,
  ProviderProfile,
  ProviderRelationshipItem,
  ProviderRelationshipPage,
  ProviderRequestContext,
  SocialGraphProvider,
  SocialGraphProviderCapabilities,
  SocialGraphProviderRegistry,
  TargetStreamEvent,
} from "../src/index.js";

const capabilities: SocialGraphProviderCapabilities = {
  profileLookup: true,
  followerCount: false,
  followingCount: false,
  followerIdentities: true,
  followingIdentities: true,
  pagination: true,
  stableUserIds: true,
};

const baseRequest: Omit<CollectTargetsRequest, "targets" | "concurrency"> = {
  runId: "run-1",
  scrapeType: "followers",
};

type ProviderState = {
  pageCalls: number;
  rowsProduced: number;
  inFlightFetches: number;
  maxInFlightFetches: number;
  observedSignals: AbortSignal[];
  failProfile: boolean;
  gate: (() => Promise<void>) | undefined;
};

function registryProvider(
  platform: Platform,
  overrides: Partial<Pick<ProviderState, "failProfile" | "gate">> & {
    pages?: ReadonlyArray<ReadonlyArray<ProviderRelationshipItem>>;
  } = {},
): SocialGraphProvider & { state: ProviderState } {
  const pages = overrides.pages ?? [[
    { platform, platformUserId: `${platform}-u1`, username: `${platform}u1` },
    { platform, platformUserId: `${platform}-u2`, username: `${platform}u2` },
  ]];
  const state: ProviderState = {
    pageCalls: 0,
    rowsProduced: 0,
    inFlightFetches: 0,
    maxInFlightFetches: 0,
    observedSignals: [],
    failProfile: overrides.failProfile ?? false,
    gate: overrides.gate,
  };
  const profile: ProviderProfile = {
    platform,
    platformUserId: `${platform}-source`,
    username: `${platform}source`,
  };
  const provider = {
    providerName: `registry-${platform}`,
    platform,
    capabilities: { ...capabilities },
    state,
    resolveProfile: vi.fn(async (_input: unknown, context: ProviderRequestContext) => {
      state.observedSignals.push(context.signal ?? new AbortController().signal);
      if (state.failProfile) {
        throw Object.assign(new Error("not found"), {
          category: "PROFILE_NOT_FOUND",
          retryable: false,
        });
      }
      return profile;
    }),
    fetchFollowersPage: vi.fn(async (_input: unknown, context: ProviderRequestContext): Promise<ProviderRelationshipPage> => {
      state.pageCalls += 1;
      state.inFlightFetches += 1;
      state.maxInFlightFetches = Math.max(state.maxInFlightFetches, state.inFlightFetches);
      state.observedSignals.push(context.signal ?? new AbortController().signal);
      try {
        if (state.gate !== undefined) {
          await Promise.race([
            state.gate(),
            new Promise<never>((_, reject) => {
              const signal = context.signal;
              if (signal === undefined) return;
              const abortError = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
              if (signal.aborted) abortError();
              else signal.addEventListener("abort", abortError, { once: true });
            }),
          ]);
        }
        if (context.signal?.aborted) {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
        const spec = pages[state.pageCalls - 1] ?? [];
        state.rowsProduced += spec.length;
        return {
          items: [...spec],
          hasMore: state.pageCalls < pages.length,
          ...(state.pageCalls < pages.length ? { nextCursor: `c${state.pageCalls}` } : {}),
          requestMetadata: { attempts: 1, durationMs: 1 },
        };
      } finally {
        state.inFlightFetches -= 1;
      }
    }),
    fetchFollowingPage: vi.fn(async (): Promise<ProviderRelationshipPage> => {
      throw new Error("following not requested in this suite");
    }),
  };
  return provider;
}

function registryOf(
  entries: ReadonlyArray<[Platform, SocialGraphProvider]>,
): SocialGraphProviderRegistry {
  return new Map(entries);
}

async function consume(stream: AsyncIterable<TargetStreamEvent>) {
  const events: TargetStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function targetStatuses(events: ReadonlyArray<TargetStreamEvent>) {
  return new Map(events
    .filter((event): event is Extract<TargetStreamEvent, { type: "targetSummary" }> =>
      event.type === "targetSummary")
    .map((event) => [`${event.value.platform}:${event.value.username}`, event.value.status]));
}

function targetError(events: ReadonlyArray<TargetStreamEvent>, key: string) {
  const summary = events.find((event): event is Extract<TargetStreamEvent, { type: "targetSummary" }> =>
    event.type === "targetSummary"
    && `${event.value.platform}:${event.value.username}` === key);
  if (summary === undefined) throw new Error(`target summary missing for ${key}`);
  return summary.value.error;
}

const threeTargets = [
  { targetId: "t1", platform: "instagram" as const, username: "alpha" },
  { targetId: "t2", platform: "x" as const, username: "beta" },
  { targetId: "t3", platform: "tiktok" as const, username: "gamma" },
];

describe("collectTargets multi-target orchestration", () => {
  it("continues two successful targets when a third fails", async () => {
    const instagram = registryProvider("instagram");
    const x = registryProvider("x", { failProfile: true });
    const tiktok = registryProvider("tiktok");
    const events = await consume(collectTargets(
      { ...baseRequest, targets: threeTargets, concurrency: 2 },
      registryOf([["instagram", instagram], ["x", x], ["tiktok", tiktok]]),
    ));

    expect(targetStatuses(events)).toEqual(new Map([
      ["instagram:alpha", "SUCCESS"],
      ["x:beta", "FAILED"],
      ["tiktok:gamma", "SUCCESS"],
    ]));
    const failedEvents = events.filter((event) =>
      event.type === "targetSummary" && event.value.status === "FAILED");
    expect(failedEvents).toHaveLength(1);
    expect(targetError(events, "x:beta")).toMatchObject({ category: "PROFILE_NOT_FOUND" });
  });

  it("fails only a target whose platform has no registered provider", async () => {
    const instagram = registryProvider("instagram");
    const tiktok = registryProvider("tiktok");
    const events = await consume(collectTargets(
      { ...baseRequest, targets: threeTargets, concurrency: 2 },
      registryOf([["instagram", instagram], ["tiktok", tiktok]]),
    ));

    expect(targetError(events, "x:beta")).toMatchObject({ category: "PROVIDER_UNAVAILABLE" });
    expect(targetStatuses(events).get("instagram:alpha")).toBe("SUCCESS");
    expect(targetStatuses(events).get("tiktok:gamma")).toBe("SUCCESS");
    expect(instagram.state.pageCalls).toBe(1);
    expect(tiktok.state.pageCalls).toBe(1);
  });

  it("fails a target whose registry key does not match the provider platform", async () => {
    const mismatched = registryProvider("tiktok");
    const instagram = registryProvider("instagram");
    const events = await consume(collectTargets(
      { ...baseRequest, targets: threeTargets, concurrency: 3 },
      registryOf([["instagram", instagram], ["x", mismatched as unknown as SocialGraphProvider], ["tiktok", registryProvider("tiktok")]]),
    ));

    expect(targetError(events, "x:beta")).toMatchObject({ category: "PROVIDER_UNAVAILABLE" });
    expect(targetStatuses(events).get("instagram:alpha")).toBe("SUCCESS");
  });

  it("emits exactly one target summary per target with platform-bearing context", async () => {
    const events = await consume(collectTargets(
      { ...baseRequest, targets: threeTargets, concurrency: 3 },
      registryOf([
        ["instagram", registryProvider("instagram")],
        ["x", registryProvider("x")],
        ["tiktok", registryProvider("tiktok")],
      ]),
    ));

    const summaries = events.filter((event) => event.type === "targetSummary");
    expect(summaries).toHaveLength(3);
    for (const summary of summaries) {
      if (summary.type !== "targetSummary") continue;
      expect(summary.runId).toBe("run-1");
      expect(summary.targetId).toBeDefined();
      expect(["instagram", "x", "tiktok"]).toContain(summary.value.platform);
      expect(summary.value.collections.every((collection) => collection.platform === summary.value.platform))
        .toBe(true);
    }
    const rows = events.filter((event) => event.type === "relationship");
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      if (row.type !== "relationship") continue;
      expect(["instagram", "x", "tiktok"]).toContain(row.value.platform);
    }
  });

  it("never runs more than the configured number of targets concurrently", async () => {
    const delay = (ms: number) => new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
    const shared = { inFlight: 0, maxInFlight: 0 };
    const gate = () => delay(30);
    const instagram = registryProvider("instagram", { gate });
    const rawFetch = instagram.fetchFollowersPage;
    // One shared provider serves six same-platform targets through one shared counter.
    (instagram as unknown as { fetchFollowersPage: typeof rawFetch }).fetchFollowersPage =
      async (input: Parameters<typeof rawFetch>[0], context: Parameters<typeof rawFetch>[1]) => {
        shared.inFlight += 1;
        shared.maxInFlight = Math.max(shared.maxInFlight, shared.inFlight);
        try {
          return await rawFetch(input, context);
        } finally {
          shared.inFlight -= 1;
        }
      };

    const targets = Array.from({ length: 6 }, (_, index) => ({
      targetId: `t${index}`,
      platform: "instagram" as const,
      username: `user${index}`,
    }));
    const events = await consume(collectTargets(
      { ...baseRequest, targets, concurrency: 2 },
      registryOf([["instagram", instagram]]),
    ));

    expect(events.filter((event) => event.type === "targetSummary")).toHaveLength(6);
    expect(shared.maxInFlight).toBe(2);
    expect(shared.maxInFlight).toBeLessThanOrEqual(2);
  });

  it("never buffers more than the configured event capacity", async () => {
    const singleRowPages = Array.from({ length: 8 }, (_, index) => [
      { platform: "instagram" as const, platformUserId: `u${index}`, username: `user${index}` },
    ]);
    const provider = registryProvider("instagram", { pages: singleRowPages });
    const stream = collectTargets(
      { ...baseRequest, targets: [threeTargets[0]], concurrency: 1, eventBufferSize: 2 },
      registryOf([["instagram", provider]]),
    );

    let consumedRows = 0;
    let maxUnconsumed = 0;
    for await (const event of stream) {
      if (event.type === "relationship") {
        consumedRows += 1;
      }
      maxUnconsumed = Math.max(maxUnconsumed, provider.state.rowsProduced - consumedRows);
    }

    expect(consumedRows).toBe(8);
    expect(maxUnconsumed).toBeLessThanOrEqual(2);
  });

  it("aborts producers without summaries when the consumer closes early", async () => {
    const instagram = registryProvider("instagram", {
      gate: () => new Promise<void>(() => {}),
    });
    const stream = collectTargets(
      { ...baseRequest, targets: [threeTargets[0]], concurrency: 1 },
      registryOf([["instagram", instagram]]),
    );

    const pending = stream.next();
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    await stream.return(undefined);
    await pending.catch(() => undefined);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(instagram.state.inFlightFetches).toBe(0);
    expect(instagram.state.observedSignals.every((signal) => signal.aborted)).toBe(true);
    expect(await stream.next()).toEqual({ done: true, value: undefined });
  });

  it("rejects invalid batches before any provider work", async () => {
    const provider = registryProvider("instagram");
    const registry = registryOf([["instagram", provider]]);

    await expect(consume(collectTargets(
      { ...baseRequest, targets: [], concurrency: 1 },
      registry,
    ))).rejects.toMatchObject({ category: "INVALID_INPUT" });

    await expect(consume(collectTargets(
      {
        ...baseRequest,
        targets: [
          { targetId: "t1", platform: "instagram", username: "same" },
          { targetId: "t2", platform: "instagram", username: "Same " },
        ],
        concurrency: 1,
      },
      registry,
    ))).rejects.toMatchObject({ category: "INVALID_INPUT" });

    await expect(consume(collectTargets(
      { ...baseRequest, targets: [threeTargets[0]], concurrency: 0 },
      registry,
    ))).rejects.toMatchObject({ category: "INVALID_INPUT" });

    await expect(consume(collectTargets(
      { ...baseRequest, targets: [{ targetId: "t1", platform: "instagram", username: "  " }], concurrency: 1 },
      registry,
    ))).rejects.toMatchObject({ category: "INVALID_INPUT" });

    expect(provider.state.pageCalls).toBe(0);
  });
});
