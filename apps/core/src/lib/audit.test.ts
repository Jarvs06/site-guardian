import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "./audit.js";

function deps(insert: () => unknown) {
  const error = vi.fn();
  return {
    deps: {
      supabase: { from: () => ({ insert }) } as unknown as SupabaseClient,
      log: { error } as never,
    },
    error,
  };
}

describe("audit", () => {
  it("inserts a row", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const { deps: d } = deps(insert);
    await audit(d, { action: "site.registered", website_id: "w", ip: "1.2.3.4", metadata: { a: 1 } });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ action: "site.registered", website_id: "w", ip_address: "1.2.3.4", actor: "website:w" }),
    );
  });

  it("never throws when the client returns an error", async () => {
    const { deps: d, error } = deps(() => Promise.resolve({ error: { message: "boom" } }));
    await expect(audit(d, { action: "x" })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it("never throws when the client throws", async () => {
    const { deps: d, error } = deps(() => {
      throw new Error("kaboom");
    });
    await expect(audit(d, { action: "x" })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});
