// Locally-available plugins. In the MVP these are bundled example add-ons served
// from /plugins/. Sub-project B (Marketplace Backend) replaces this static list
// with a Supabase-backed catalog of the plugins a user has actually installed,
// scoped by subteam.

export interface MarketplaceEntry {
  /** Base URL (a directory containing manifest.json) the bundle is served from. */
  baseUrl: string;
}

export const LOCAL_PLUGINS: MarketplaceEntry[] = [{ baseUrl: "/plugins/spring-rate" }];
