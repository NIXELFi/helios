import { RequireAuth } from "@helios/auth";
import { LoginPane } from "./LoginPane";
import { VaultHome } from "./VaultHome";

export function VaultModule() {
  return (
    <RequireAuth
      fallback={
        <div className="flex h-full items-center justify-center bg-helios-panel text-helios-dim">
          Loading…
        </div>
      }
      unauthenticated={<LoginPane />}
    >
      <VaultHome />
    </RequireAuth>
  );
}
