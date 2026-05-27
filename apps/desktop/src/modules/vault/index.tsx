import { useAuthLoading, useUser } from "@helios/auth";
import { VaultHome } from "./VaultHome";
import { useVaultAccess } from "./data/useVaultAccess";

// Vault sign-in gating lives in the Shell: the sidebar grays out the Vault
// button when there's no user, and `<VaultModule>` only mounts when
// `user !== null`. This component handles the two states that remain once a
// user IS signed in:
//   1. the brief window before `getSession()` resolves (auth loading), and
//   2. authorization — a freshly signed-up account has no role row yet, so
//      it can't actually read bytes or write (see useVaultAccess). We show
//      an explicit notice rather than a broken-looking empty vault.
export function VaultModule() {
  const loading = useAuthLoading();
  if (loading) return <Notice>Loading…</Notice>;
  return <VaultAccessGate />;
}

function VaultAccessGate() {
  const access = useVaultAccess();
  const user = useUser();

  if (access.status === "loading") return <Notice>Checking access…</Notice>;

  if (access.status === "error") {
    return (
      <CenteredCard title="Couldn't verify Vault access">
        <p className="text-helios-dim">
          Signed in as <span className="text-helios-text">{user?.email}</span>, but the role
          lookup failed:
        </p>
        <p className="mt-2 rounded-sm border border-red-500/40 bg-red-500/10 px-2 py-1 font-mono-num text-[11px] text-red-200">
          {access.error}
        </p>
        <p className="mt-3 text-helios-dim">
          If you're running your own Supabase project, this usually means the{" "}
          <code className="font-mono-num text-helios-text">pdm</code> schema + migrations
          aren't applied yet. See the project setup notes handed out with your connection.
        </p>
      </CenteredCard>
    );
  }

  if (access.status === "no-role") {
    return (
      <CenteredCard title="Your account isn't authorized yet">
        <p className="text-helios-dim">
          You're signed in as <span className="text-helios-text">{user?.email}</span>, but an
          admin hasn't granted you access to this vault yet.
        </p>
        <p className="mt-3 text-helios-dim">
          Ask a vault admin to grant your account a role (viewer / editor / admin). Until then
          you can keep using Logs and CFD — they don't require an account.
        </p>
      </CenteredCard>
    );
  }

  return <VaultHome />;
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-helios-panel text-helios-dim">
      {children}
    </div>
  );
}

function CenteredCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-helios-panel p-6 text-sm text-helios-text">
      <div className="w-[min(92vw,460px)] rounded-md border border-helios-line bg-helios-base p-5">
        <div className="text-[11px] uppercase tracking-wider text-asu-gold">{title}</div>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}
