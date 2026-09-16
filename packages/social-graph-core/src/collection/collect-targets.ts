import type {
  CollectTargetsRequest,
  TargetStreamEvent,
} from "../contracts/collection.js";
import type { Platform, SocialGraphProvider } from "../contracts/provider.js";
import { CollectionError } from "../errors/collection-error.js";
import { normalizeProviderError } from "../errors/normalize-error.js";
import type { CollectTargetOptions } from "./collect-target.js";
import { collectTarget } from "./collect-target.js";
import { BoundedEventQueue, QueueClosedError } from "./bounded-event-queue.js";

export type CollectTargetsOptions = CollectTargetOptions;

type BatchTarget = CollectTargetsRequest["targets"][number];

/**
 * Streams multiple targets through an injected provider registry with bounded
 * concurrency, a bounded event buffer, and per-target failure isolation. Each
 * target receives exactly one terminal target summary when the batch is
 * consumed normally; an early consumer closure aborts and settles all active
 * producers without emitting later summaries.
 */
export async function* collectTargets(
  request: CollectTargetsRequest,
  providers: ReadonlyMap<Platform, SocialGraphProvider>,
  options: CollectTargetsOptions = {},
): AsyncGenerator<TargetStreamEvent> {
  validateBatch(request);

  const concurrency = request.concurrency;
  const queue = new BoundedEventQueue<TargetStreamEvent>(
    request.eventBufferSize ?? concurrency * 4,
  );

  const callerSignal = request.signal;
  const internalController = new AbortController();
  const forwardAbort = () => internalController.abort();
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) internalController.abort();
    callerSignal.addEventListener("abort", forwardAbort);
  }

  let nextTargetIndex = 0;
  let activeTargets = 0;
  let finishedTargets = 0;

  const pump = (): void => {
    while (activeTargets < concurrency && nextTargetIndex < request.targets.length) {
      const target = request.targets[nextTargetIndex];
      if (target === undefined) break;
      nextTargetIndex += 1;
      activeTargets += 1;
      void runTarget(target);
    }
  };

  const runTarget = async (target: BatchTarget): Promise<void> => {
    let iterator: AsyncIterator<TargetStreamEvent> | undefined;

    try {
      iterator = collectTarget(
        {
          runId: request.runId,
          targetId: target.targetId,
          platform: target.platform,
          username: target.username,
          scrapeType: request.scrapeType,
          ...(request.maxFollowers === undefined ? {} : { maxFollowers: request.maxFollowers }),
          ...(request.maxFollowing === undefined ? {} : { maxFollowing: request.maxFollowing }),
          signal: internalController.signal,
        },
        selectProvider(target),
        {
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.retry === undefined ? {} : { retry: options.retry }),
        },
      )[Symbol.asyncIterator]();
      while (true) {
        await queue.reserve();
        let next: IteratorResult<TargetStreamEvent>;
        try {
          next = await iterator.next();
        } catch (error) {
          queue.release();
          throw error;
        }
        if (next.done) {
          queue.release();
          break;
        }
        queue.push(next.value);
      }
    } catch (error) {
      if (!(error instanceof QueueClosedError)) {
        try {
          await queue.reserve();
          queue.push(failedTargetEvent(request, target, normalizeProviderError(error, {
            platform: target.platform,
            targetId: target.targetId,
          })));
        } catch {
          // The consumer closed the batch iterator; no further summaries.
        }
      }
    } finally {
      activeTargets -= 1;
      finishedTargets += 1;
      await iterator?.return?.(undefined).catch(() => undefined);
      if (finishedTargets === request.targets.length) {
        queue.close();
      } else {
        pump();
      }
    }
  };

  const selectProvider = (target: BatchTarget): SocialGraphProvider => {
    const provider = providers.get(target.platform);
    if (provider === undefined || provider.platform !== target.platform) {
      throw new CollectionError({
        category: "PROVIDER_UNAVAILABLE",
        message: `No provider registered for platform ${target.platform}`,
        retryable: false,
        platform: target.platform,
        targetId: target.targetId,
      });
    }
    return provider;
  };

  try {
    pump();
    while (true) {
      const result = await queue.pull();
      if (result.done) break;
      yield result.value;
    }
  } finally {
    internalController.abort();
    queue.close();
    if (callerSignal !== undefined) {
      callerSignal.removeEventListener("abort", forwardAbort);
    }
  }
}

function validateBatch(request: CollectTargetsRequest): void {
  if (!Array.isArray(request.targets) || request.targets.length === 0) {
    throw new CollectionError({
      category: "INVALID_INPUT",
      message: "At least one target is required",
      retryable: false,
    });
  }
  if (!Number.isSafeInteger(request.concurrency) || request.concurrency < 1) {
    throw new CollectionError({
      category: "INVALID_INPUT",
      message: "concurrency must be a positive integer",
      retryable: false,
    });
  }
  if (
    request.eventBufferSize !== undefined
    && (!Number.isSafeInteger(request.eventBufferSize) || request.eventBufferSize < 1)
  ) {
    throw new CollectionError({
      category: "INVALID_INPUT",
      message: "eventBufferSize must be a positive integer",
      retryable: false,
    });
  }

  const seen = new Set<string>();
  for (const target of request.targets) {
    const username = target.username.trim().toLocaleLowerCase("en-US");
    if (target.targetId.trim() === "" || username === "") {
      throw new CollectionError({
        category: "INVALID_INPUT",
        message: "Targets require a targetId and a non-empty username",
        retryable: false,
        platform: target.platform,
        targetId: target.targetId,
      });
    }
    const key = `${target.platform}:${username}`;
    if (seen.has(key)) {
      throw new CollectionError({
        category: "INVALID_INPUT",
        message: `Duplicate target platform/username: ${key}`,
        retryable: false,
        platform: target.platform,
        targetId: target.targetId,
      });
    }
    seen.add(key);
  }
}

function failedTargetEvent(
  request: CollectTargetsRequest,
  target: BatchTarget,
  error: CollectionError,
): TargetStreamEvent {
  return {
    type: "targetSummary",
    runId: request.runId,
    targetId: target.targetId,
    value: {
      runId: request.runId,
      targetId: target.targetId,
      platform: target.platform,
      username: target.username,
      status: "FAILED",
      collections: [],
      error: error.toPublicError(),
    },
  };
}
