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

export default function HeliosShell() {
  const [active, setActive] = useState<ModuleId>("logs");
  const client = useMemo(tryCreateClient, []);

  return (
    <div className="flex h-screen w-screen">
      <ModulePicker active={active} onSelect={setActive} />
      <main className="flex-1">
        {active === "logs" ? (
          <LogsApp />
        ) : client ? (
          <SupabaseAuthProvider client={client}>
            <VaultModule />
          </SupabaseAuthProvider>
        ) : (
          <div className="flex h-full items-center justify-center bg-zinc-900 text-zinc-400">
            Vault is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in
            <code className="ml-1">.env.local</code>.
          </div>
        )}
      </main>
    </div>
  );
}
