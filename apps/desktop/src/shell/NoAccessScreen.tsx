/**
 * Full-pane state shown in place of any data-backed module when the signed-in
 * account holds no org role yet (see useOrgAccess / migration 20260714010000).
 * The database already denies every read for these accounts — this screen
 * turns that wall of nothing into a calm, actionable explanation.
 */
export function NoAccessScreen({
  email,
  onRecheck,
  onSignOut,
}: {
  email: string | null;
  onRecheck: () => void;
  onSignOut: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center bg-helios-base p-8">
      <div className="w-[26rem] max-w-full text-center">
        {/* Badge-style lock glyph, deliberately quiet — this is a waiting
            room, not an error. */}
        <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-full border border-helios-line bg-helios-panel">
          <svg
            viewBox="0 0 24 24"
            className="h-6 w-6 text-asu-gold"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="5" y="11" width="14" height="9" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        </div>
        <h2 className="mb-2 text-lg font-semibold text-helios-text">
          Your account isn't on a team yet
        </h2>
        <p className="mb-1 text-sm leading-relaxed text-helios-dim">
          Everything in Helios — the vault, projects, dashboards — belongs to the
          team, so access starts once you're given a role.
        </p>
        <p className="mb-6 text-sm leading-relaxed text-helios-dim">
          Please contact your <span className="text-helios-text">team lead</span> and
          ask them to add you{email ? (
            <>
              {" "}(you signed up as <span className="text-helios-text">{email}</span>)
            </>
          ) : null}. The moment they do, you're in.
        </p>
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={onRecheck}
            className="rounded bg-asu-gold px-4 py-1.5 text-sm text-white hover:brightness-110"
          >
            Check again
          </button>
          <button
            type="button"
            onClick={onSignOut}
            className="rounded border border-helios-line px-4 py-1.5 text-sm text-helios-dim hover:bg-helios-line hover:text-helios-text"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
