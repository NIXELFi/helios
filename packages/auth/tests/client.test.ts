import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSupabaseClient } from "../src/client";

describe("createSupabaseClient", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates a client when both URL and anon key are provided explicitly", () => {
    const c = createSupabaseClient({
      url: "https://example.supabase.co",
      anonKey: "anon-k",
    });
    expect(c).toBeDefined();
    expect(c.auth).toBeDefined();
  });

  it("reads from VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY when args omitted", () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://from-env.supabase.co");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "env-key");
    const c = createSupabaseClient();
    expect(c).toBeDefined();
  });

  it("throws when no URL is configured", () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "");
    expect(() => createSupabaseClient()).toThrow(/SUPABASE_URL/);
  });
});
