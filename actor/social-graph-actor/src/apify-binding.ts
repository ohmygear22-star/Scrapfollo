import { Actor, log } from "apify";
import type { NormalizedRelationship } from "@social-graph/core";
import { runActor } from "./main.js";
import type { ActorPlatform } from "./main.js";
import type { DatasetWriter } from "./dataset-writer.js";
import { ActorInputError } from "./input.js";
import type { KeyValueStore } from "./key-value-store.js";
import { runResidentialProbe } from "./probe-classify.js";
import { runTikTokSignProbe } from "./tiktok-sign-probe.js";

/**
 * The ONLY module allowed to import the Apify SDK (architecture-enforced).
 * Binds runActor to the platform adapters. The registry is empty until
 * Phase 3 injects a live provider, so every target reports
 * PROVIDER_UNAVAILABLE — the actor can be deployed and exercised
 * end-to-end without any live platform call.
 */

function sdkDatasetWriter(): DatasetWriter {
  return {
    async write(row: NormalizedRelationship): Promise<void> {
      await Actor.pushData(row);
    },
  };
}

function sdkKeyValueStore(): KeyValueStore {
  return {
    async setValue(key: string, value: unknown): Promise<void> {
      await Actor.setValue(key, value);
    },
  };
}

type ProbeInput = {
  probe: { platform: "instagram" | "tiktok" | "tiktok-sign"; proxyUser?: unknown; target?: unknown };
};

function isProbeInput(raw: unknown): raw is ProbeInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const probe = (raw as { probe?: unknown }).probe;
  if (typeof probe !== "object" || probe === null) return false;
  const platform = (probe as { platform?: unknown }).platform;
  return platform === "instagram" || platform === "tiktok" || platform === "tiktok-sign";
}

export function createApifyPlatform(): ActorPlatform {
  return {
    registry: new Map(),
    dataset: sdkDatasetWriter(),
    keyValueStore: sdkKeyValueStore(),
  };
}

export async function apifyMain(): Promise<void> {
  await Actor.init();
  let failed = false;
  try {
    const input = await Actor.getInput();
    if (isProbeInput(input)) {
      if (input.probe.platform === "tiktok-sign") {
        const target = typeof input.probe.target === "string" && input.probe.target.trim() !== ""
          ? input.probe.target.trim().replace(/^@/, "")
          : "khaby.lame";
        const result = await runTikTokSignProbe(target, sdkKeyValueStore(), "auto");
        log.info("tiktok sign probe finished", { target, ...result });
      } else {
        const proxyUser = typeof input.probe.proxyUser === "string" && input.probe.proxyUser !== ""
          ? input.probe.proxyUser
          : "auto,groups-RESIDENTIAL";
        const result = await runResidentialProbe(input.probe.platform, sdkKeyValueStore(), proxyUser);
        log.info("residential probe finished", { platform: input.probe.platform, proxyUser, ...result });
      }
    } else {
      await runActor(input, createApifyPlatform());
    }
  } catch (error) {
    failed = true;
    const message = error instanceof ActorInputError
      ? error.message
      : "Actor run failed";
    log.error(message, { kind: error instanceof ActorInputError ? "invalid-input" : "run-failure" });
  } finally {
    if (failed) {
      await Actor.fail("Actor run failed");
    } else {
      await Actor.exit();
    }
  }
}
