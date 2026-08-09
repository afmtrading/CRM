import 'server-only'

/**
 * Authorises a scheduled run.
 *
 * Two secrets are accepted because two things call these routes: our own
 * `SYNC_INGEST_SECRET`, used when triggering a run by hand or from pg_cron, and
 * `CRON_SECRET`, which Vercel Cron sends automatically as a bearer token. If
 * neither is configured the route is off, which is the safe default for an
 * endpoint that runs without a user session.
 */
export function schedulerSecrets(): string[] {
  return [process.env.SYNC_INGEST_SECRET, process.env.CRON_SECRET].filter(
    (value): value is string => Boolean(value),
  )
}

export function isSchedulerAuthorized(request: Request): boolean {
  const secrets = schedulerSecrets()
  if (secrets.length === 0) return false

  const header = request.headers.get('authorization') ?? ''
  return secrets.some((secret) => header === `Bearer ${secret}`)
}
