// H-1 (open-signup hardening): client-side email validation so a malformed or
// disallowed address is rejected inline before any auth round-trip. The domain
// allowlist is data-driven (pdm.signup_allowed_domains, read pre-auth through
// public.list_signup_domains()); the before-insert trigger on auth.users is the
// real gate — this is UX only.

// A reasonable, intentionally-strict single-`@` pattern: non-space local part,
// a dotted domain with a 2+ char TLD.
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function domainMessage(domains: readonly string[]): string {
  return `Sign-up is restricted to ${domains.map((d) => `@${d}`).join(", ")} accounts.`;
}

/** Validates an email's format and, when an allowlist is known, its domain.
 *  `domains` null/empty = no client-side domain check (list not loaded, or the
 *  gate is disabled). Returns an error string to display, or null. */
export function validateSignupEmail(email: string, domains: readonly string[] | null): string | null {
  const trimmed = email.trim().toLowerCase();
  if (!EMAIL_RE.test(trimmed)) return "Enter a valid email address.";
  if (domains && domains.length > 0) {
    const domain = trimmed.slice(trimmed.lastIndexOf("@") + 1);
    if (!domains.some((d) => d.toLowerCase() === domain)) return domainMessage(domains);
  }
  return null;
}

/** Maps a sign-up error to what the user should read. GoTrue wraps ANY
 *  exception from an auth.users trigger — including the domain gate's — as
 *  HTTP 500 "Database error saving new user", which tells the user nothing.
 *  When that happens the domain gate is by far the likeliest cause, so say so. */
export function signupErrorMessage(
  err: { message?: string; status?: number },
  domains: readonly string[] | null,
): string {
  const msg = err.message ?? "";
  if (/database error saving new user/i.test(msg) || /approved email domains/i.test(msg)) {
    return domains && domains.length > 0
      ? domainMessage(domains)
      : "Sign-up was rejected. Use your organization email address.";
  }
  return msg || "Sign-up failed.";
}
