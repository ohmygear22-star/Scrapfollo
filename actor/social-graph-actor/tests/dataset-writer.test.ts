import { describe, expect, it } from "vitest";
import { DatasetWriteError, LocalDatasetWriter } from "../src/dataset-writer.js";
import type { NormalizedRelationship } from "@social-graph/core";

function row(userId: string): NormalizedRelationship {
  return {
    platform: "instagram",
    sourceUsername: "source",
    sourceUserId: "source-id",
    relationship: "followers",
    userId,
    username: userId,
    position: 1,
    scrapedAt: "2026-09-16T00:00:00.000Z",
  };
}

describe("LocalDatasetWriter", () => {
  it("stores rows in order", async () => {
    const writer = new LocalDatasetWriter();
    await writer.write(row("u1"));
    await writer.write(row("u2"));

    expect(writer.rows.map((entry) => entry.userId)).toEqual(["u1", "u2"]);
  });

  it("throws DatasetWriteError when the injected failure matches a row", async () => {
    const writer = new LocalDatasetWriter({
      failWhen: (entry) => entry.userId === "u2",
    });

    await writer.write(row("u1"));
    await expect(writer.write(row("u2"))).rejects.toBeInstanceOf(DatasetWriteError);
    expect(writer.rows.map((entry) => entry.userId)).toEqual(["u1"]);
  });

  it("never stores secret-bearing payloads beyond the normalized row", async () => {
    const writer = new LocalDatasetWriter();
    await writer.write(row("u1"));

    const serialized = JSON.stringify(writer.rows);
    expect(serialized).not.toContain("cursor");
    expect(serialized).not.toContain("requestMetadata");
    expect(serialized).not.toContain("rawResponse");
  });
});
