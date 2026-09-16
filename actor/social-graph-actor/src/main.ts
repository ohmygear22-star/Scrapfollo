import { collectTargets } from "@social-graph/core";
import type {
  CoreRunMetrics,
  Platform,
  RelationshipCollectionSummary,
  RetryOptions,
  SocialGraphProviderRegistry,
  TargetCollectionStatus,
  TargetStreamEvent,
} from "@social-graph/core";
import { validateActorInput } from "./input.js";
import type { ValidatedActorInput } from "./input.js";
import type { DatasetWriter } from "./dataset-writer.js";
import type { KeyValueStore } from "./key-value-store.js";
import { buildRunSummary } from "./run-summary.js";
import type { RunSummary } from "./run-summary.js";

export type TargetDelivery = {
  targetId: string;
  platform: Platform;
  username: string;
  profilesResolved: boolean;
  coreStatus?: TargetCollectionStatus;
  collections: RelationshipCollectionSummary[];
  delivery: "delivered" | "persistence-failed" | "not-run";
};

export type ActorRunOutcome = {
  runId: string;
  input: ValidatedActorInput;
  targets: ReadonlyArray<TargetDelivery>;
  rowsWritten: number;
  rowsDropped: number;
  aborted: boolean;
  abortReason?: "timeout";
  metrics?: CoreRunMetrics;
  summary?: RunSummary;
};

export type ActorPlatform = {
  registry: SocialGraphProviderRegistry;
  dataset: DatasetWriter;
  keyValueStore?: KeyValueStore;
};

export type RunActorConfig = {
  runId?: string;
  /** Aborts the whole batch when exceeded; in-flight collections end ABORTED. */
  runTimeoutMs?: number;
  retry?: RetryOptions;
  /** Up to `batchSize` dataset writes in flight per flush; default 1 (per-item). */
  batchSize?: number;
  /** Wall clock used for RUN_SUMMARY timestamps; defaults to Date. */
  now?: () => Date;
};

type StreamStep =
  | { kind: "event"; value: TargetStreamEvent }
  | { kind: "done" }
  | { kind: "timeout" };

/**
 * Composition root of the actor: validates input, consumes one
 * `collectTargets` batch through the injected registry, streams normalized
 * rows to the Dataset with awaited writes, converts dataset write failures
 * into per-target persistence failures (never reporting the affected
 * collection as successfully delivered), and converts run timeouts into
 * aborted outcomes with finalized metrics.
 */
export async function runActor(
  rawInput: unknown,
  platform: ActorPlatform,
  config: RunActorConfig = {},
): Promise<ActorRunOutcome> {
  const input = validateActorInput(rawInput);
  const runId = config.runId ?? crypto.randomUUID();
  const batchSize = Math.max(1, config.batchSize ?? 1);

  const records = new Map<string, TargetDelivery>();
  for (const target of input.targets) {
    records.set(target.targetId, {
      targetId: target.targetId,
      platform: target.platform,
      username: target.username,
      profilesResolved: false,
      collections: [],
      delivery: "not-run",
    });
  }

  const failedTargets = new Set<string>();
  const now = config.now ?? (() => new Date());
  const startedAt = now();
  let datasetOperations = 0;
  let rowsWritten = 0;
  let rowsDropped = 0;
  let metrics: CoreRunMetrics | undefined;
  let aborted = false;
  let abortReason: "timeout" | undefined;

  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let inflight: Array<{ targetId: string; promise: Promise<void> }> = [];

  const flushWrites = async (): Promise<void> => {
    if (inflight.length === 0) return;
    const pending = inflight;
    inflight = [];
    const results = await Promise.allSettled(pending.map((entry) => entry.promise));
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        rowsWritten += 1;
      } else {
        failedTargets.add(pending[index]?.targetId ?? "");
        rowsDropped += 1;
      }
    });
  };

  const handleEvent = (event: TargetStreamEvent): void => {
    if (event.type === "profile") {
      const record = records.get(event.targetId);
      if (record !== undefined) record.profilesResolved = true;
      return;
    }
    if (event.type === "collectionSummary") {
      const record = records.get(event.targetId);
      if (record !== undefined) record.collections.push(event.value);
      return;
    }
    if (event.type === "targetSummary") {
      const record = records.get(event.targetId);
      if (record !== undefined) record.coreStatus = event.value.status;
      return;
    }
    if (failedTargets.has(event.targetId)) {
      rowsDropped += 1;
      return;
    }
    const write = platform.dataset.write(event.value);
    // Attach a no-op catch immediately: without it, a rejection between the
    // push and the flushWrites handler would crash the process as an
    // unhandled rejection before the failure could be converted.
    write.catch(() => undefined);
    datasetOperations += 1;
    inflight.push({ targetId: event.targetId, promise: write });
  };

  const stream = collectTargets(
    {
      runId,
      targets: input.targets,
      scrapeType: input.scrapeType,
      ...(input.maxFollowers === undefined ? {} : { maxFollowers: input.maxFollowers }),
      ...(input.maxFollowing === undefined ? {} : { maxFollowing: input.maxFollowing }),
      concurrency: input.concurrency,
      eventBufferSize: input.eventBufferSize,
      signal: controller.signal,
    },
    platform.registry,
    {
      ...(config.retry === undefined ? {} : { retry: config.retry }),
      onRunMetrics: (runMetrics) => {
        metrics = runMetrics;
      },
    },
  );

  try {
    const timeoutPromise = config.runTimeoutMs === undefined
      ? undefined
      : new Promise<StreamStep>((resolve) => {
        timeoutHandle = setTimeout(() => {
          aborted = true;
          abortReason = "timeout";
          controller.abort();
          resolve({ kind: "timeout" });
        }, config.runTimeoutMs);
      });

    while (true) {
      const nextPromise: Promise<IteratorResult<TargetStreamEvent>> = stream.next();
      const step: StreamStep = timeoutPromise === undefined
        ? await nextPromise.then((result): StreamStep =>
          result.done ? { kind: "done" } : { kind: "event", value: result.value })
        : await Promise.race([
          nextPromise.then((result): StreamStep =>
            result.done ? { kind: "done" } : { kind: "event", value: result.value }),
          timeoutPromise,
        ]);

      if (step.kind === "timeout") {
        // The raced-away next() still owns the stream slot; await it before
        // draining, or its result would be silently swallowed.
        const raced = await nextPromise;
        if (!raced.done && raced.value !== undefined) handleEvent(raced.value);
        if (inflight.length >= batchSize) await flushWrites();
        // Core converts in-flight work into ABORTED summaries once the
        // signal fires; drain without the race until the stream ends.
        while (true) {
          const drained = await stream.next();
          if (drained.done) break;
          handleEvent(drained.value);
          if (inflight.length >= batchSize) await flushWrites();
        }
        break;
      }
      if (step.kind === "done") break;
      handleEvent(step.value);

      if (inflight.length >= batchSize) {
        await flushWrites();
      }
    }
    await flushWrites();
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    controller.abort();
    await stream.return(undefined).catch(() => undefined);
  }

  for (const record of records.values()) {
    if (failedTargets.has(record.targetId)) {
      record.delivery = "persistence-failed";
    } else if (record.profilesResolved) {
      record.delivery = "delivered";
    } else {
      record.delivery = "not-run";
    }
  }

  const finishedAt = now();
  const summary = buildRunSummary(
    {
      runId,
      input,
      targets: input.targets.map((target) => {
        const record = records.get(target.targetId);
        if (record === undefined) throw new Error(`missing delivery record for ${target.targetId}`);
        return record;
      }),
      rowsWritten,
      rowsDropped,
      aborted,
      ...(abortReason === undefined ? {} : { abortReason }),
      ...(metrics === undefined ? {} : { metrics }),
    },
    {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      actorRuntimeMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      datasetOperations,
    },
  );
  if (platform.keyValueStore !== undefined) {
    await platform.keyValueStore.setValue("RUN_SUMMARY", summary);
  }

  const outcome: ActorRunOutcome = {
    runId,
    input,
    targets: summary.targets,
    rowsWritten,
    rowsDropped,
    aborted,
    ...(abortReason === undefined ? {} : { abortReason }),
    ...(metrics === undefined ? {} : { metrics }),
    summary,
  };
  return outcome;
}
