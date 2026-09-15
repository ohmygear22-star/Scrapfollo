export type RelationshipCollectionMetrics = Readonly<{
  rawItemsReceived: number;
  uniqueItemsProduced: number;
  duplicatesRemoved: number;
  requestsMade: number;
  requestsFailed: number;
  requestsRetried: number;
  bytesTransferred: number | null;
  runtimeMs: number;
}>;

export type CoreRunMetrics = Readonly<{
  profilesRequested: number;
  profilesSuccessful: number;
  profilesFailed: number;
  profilesPartial: number;
  followersReturned: number;
  followingReturned: number;
  totalRelationshipsReturned: number;
  rawItemsReceived: number;
  uniqueItemsProduced: number;
  duplicatesRemoved: number;
  requestsMade: number;
  requestsFailed: number;
  requestsRetried: number;
  bytesTransferred: number | null;
  runtimeMs: number;
}>;
