/**
 * Environment access.
 *
 * The build must succeed without secrets (Vercel builds the app before the
 * project's env vars are necessarily complete), so reads are lazy and only the
 * code paths that actually talk to Supabase throw when configuration is
 * missing.
 */

function read(name: string): string | undefined {
  const value = process.env[name]
  return value && value.length > 0 ? value : undefined
}

export function supabaseUrl(): string {
  // Static property access, not read(): Next.js only inlines NEXT_PUBLIC_*
  // vars into the browser bundle when the reference is a literal like
  // `process.env.NEXT_PUBLIC_SUPABASE_URL`. This function is called from
  // client components (src/lib/supabase/client.ts), so a dynamic
  // `process.env[name]` lookup would resolve to undefined in the browser
  // even though the value is set.
  const value = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!value) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set')
  return value
}

export function supabaseAnonKey(): string {
  const value = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!value) throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY is not set')
  return value
}

/**
 * Service role key. Only ever read inside server-only admin paths (creating an
 * organization, inviting a user) — never imported into a client component.
 */
export function supabaseServiceRoleKey(): string {
  const value = read('SUPABASE_SERVICE_ROLE_KEY')
  if (!value) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set')
  return value
}

export function isSupabaseConfigured(): boolean {
  return Boolean(read('NEXT_PUBLIC_SUPABASE_URL') && read('NEXT_PUBLIC_SUPABASE_ANON_KEY'))
}

/**
 * Google OAuth, for the Gmail sync.
 *
 * Absent by default: the feature stays invisible until an admin has created a
 * Google Cloud project and set these, rather than offering a Connect button
 * that leads to a Google error page.
 */
export function googleClientId(): string {
  const value = read('GOOGLE_CLIENT_ID')
  if (!value) throw new Error('GOOGLE_CLIENT_ID is not set')
  return value
}

export function googleClientSecret(): string {
  const value = read('GOOGLE_CLIENT_SECRET')
  if (!value) throw new Error('GOOGLE_CLIENT_SECRET is not set')
  return value
}

export function isGoogleConfigured(): boolean {
  return Boolean(read('GOOGLE_CLIENT_ID') && read('GOOGLE_CLIENT_SECRET'))
}

/** Where Google sends the user back. Must match the console entry exactly. */
export function googleRedirectUri(): string {
  return `${siteUrl()}/api/gmail/callback`
}

export function siteUrl(): string {
  return (
    read('NEXT_PUBLIC_SITE_URL') ??
    (read('VERCEL_URL') ? `https://${read('VERCEL_URL')}` : 'http://localhost:3000')
  )
}
