'use client'

import { createBrowserClient } from '@supabase/ssr'

import { supabaseAnonKey, supabaseUrl } from '@/lib/env'

let client: ReturnType<typeof createBrowserClient> | undefined

export function createSupabaseBrowserClient() {
  client ??= createBrowserClient(supabaseUrl(), supabaseAnonKey())
  return client
}
