export const isMarketsFeed = (uri: string) => uri === "kites://feed/markets";

export const normalizeDefaultFeed = (uri: string) =>
  isMarketsFeed(uri) ? "following" : uri;
