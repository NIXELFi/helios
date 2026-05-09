import { useState, useMemo } from "react";
import { SupabaseAuthProvider, createSupabaseClient } from "@helios/auth";
import { ModulePicker, type ModuleId } from "./shell/ModulePicker";
import { VaultModule } from "./modules/vault";
import LogsApp from "./App";

function tryCreateClient() {
  try {
    return createSupabaseClient();
  } catch {
    return null;
  }
}

// Each module mounts on first visit and stays mounted afterward. Switching tabs
// just toggles visibility, so LogsApp keeps its loaded sessions / workspace
// state and Vault keeps its Supabase auth + queries — no reload + flash on
// every switch.
export default function HeliosShell() {
  const [active, setActive] = useState<ModuleId>("logs");
  const [visited, setVisited] = useState<Set<ModuleId>>(() => new Set(["logs"]));
  const client = useMemo(tryCreateClient, []);

  function activate(id: ModuleId) {
    setActive(id);
    setVisited((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }

  return (
    <div className="flex h-screen w-screen">
      <ModulePicker active={active} onSelect={activate} />
      <main className="flex-1 min-w-0 relative">
        {visited.has("logs") && (
          <div className={"absolute inset-0 " + (active === "logs" ? "" : "hidden")}>
            <LogsApp />
          </div>
        )}
        {visited.has("vault") && (
          <div className={"absolute inset-0 " + (active === "vault" ? "" : "hidden")}>
            {client ? (
              <SupabaseAuthProvider client={client}>
                <VaultModule />
              </SupabaseAuthProvider>
            ) : (
              <div className="flex h-full items-center justify-center bg-zinc-900 text-zinc-400">
                Vault is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in
                <code className="ml-1">.env.local</code>.
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
