import 'server-only'

import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { supabaseAnonKey, supabaseServiceRoleKey, supabaseUrl } from '@/lib/env'

/**
 * The Supabase client, with query building left untyped.
 *
 * See src/lib/database.types.ts for the reasoning: PostgREST's select-string
 * parser types results against the schema generic, and a hand-written generic
 * cannot describe foreign keys well enough for nested selects like
 * `select('*, companies(id, name)')` to resolve. Rather than sprinkle casts at
 * every call site, the escape hatch lives here, once, and results are typed
 * where they are consumed (`.maybeSingle<ContactRow>()`, `as ContactRow[]`).
 *
 * Everything outside of from()/rpc() — auth in particular — keeps its types.
 */
export type AppSupabaseClient = Omit<SupabaseClient, 'from' | 'rpc'> & {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  from(table: string): any
  rpc(fn: string, args?: Record<string, unknown>): any
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * Request-scoped Supabase client carrying the signed-in user's JWT, so every
 * query runs under that user's RLS policies.
 */
export async function createSupabaseServerClient(): Promise<AppSupabaseClient> {
  const cookieStore = await cookies()

  return createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options)
          })
        } catch {
          // Called from a Server Component, where cookies are read-only. The
          // middleware refreshes the session, so this is safe to ignore.
        }
      },
    },
  }) as unknown as AppSupabaseClient
}

/**
 * Service-role client. Bypasses RLS entirely — use only for internal admin
 * actions that legitimately span organizations (provisioning an organization,
 * inviting a user into one), and always after checking the caller's role
 * yourself, because the database will not check it for you.
 */
export function createSupabaseAdminClient(): AppSupabaseClient {
  return createClient(supabaseUrl(), supabaseServiceRoleKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  }) as unknown as AppSupabaseClient
}

/**
 * Sessionless client, running as `anon`.
 *
 * For the two places a person with no account has to reach the database: the
 * unsubscribe link, and a public marketing form. It carries no cookies on
 * purpose — a signed-in colleague opening a form must not have their JWT
 * attached to it, because that would quietly change which policies apply and
 * make the public path behave differently for staff than for everybody else.
 *
 * `anon` may execute four functions in total and read no table at all, so what
 * this client can do is exactly the list in those grants.
 */
export function createSupabaseAnonClient(): AppSupabaseClient {
  return createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: { getAll: () => [], setAll: () => {} },
  }) as unknown as AppSupabaseClient
}
