import type { ProviderRelationshipPage } from "../contracts/provider.js";

export class PaginationState {
  currentCursor: string | undefined;
  readonly seenCursors = new Set<string>();
  pageOrdinal = 0;
  requestsMade = 0;
  rawItemsReceived = 0;

  recordPage(page: ProviderRelationshipPage): void {
    this.pageOrdinal += 1;
    this.requestsMade += 1;
    this.rawItemsReceived += page.items.length;
  }

  nextCursorFor(
    page: ProviderRelationshipPage,
    paginationSupported: boolean,
  ): string | undefined {
    if (!paginationSupported && (page.hasMore || page.nextCursor !== undefined)) {
      throw new PaginationStateError(
        "Provider declared pagination unsupported but returned a next-page signal",
      );
    }

    if (!page.hasMore) return undefined;

    if (page.nextCursor === undefined) {
      throw new PaginationStateError("Provider returned hasMore without a next cursor");
    }

    if (this.seenCursors.has(page.nextCursor)) {
      throw new PaginationStateError("Provider returned a repeated next cursor");
    }

    this.seenCursors.add(page.nextCursor);
    this.currentCursor = page.nextCursor;
    return this.currentCursor;
  }
}

export class PaginationStateError extends Error {}
