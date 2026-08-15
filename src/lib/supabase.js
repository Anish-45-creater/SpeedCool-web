import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const configured = Boolean(url && anonKey)

export const supabase = createClient(
  url || 'https://placeholder.supabase.co',
  anonKey || 'public-anon-key-not-set',
  {
    auth: {
      persistSession: true,        // Save session in localStorage
      autoRefreshToken: true,       // Auto refresh before expiry
      detectSessionInUrl: true,     // Handle password reset links
      storageKey: 'speedcool-auth', // Unique key avoids conflicts
    },
    global: {
      headers: {
        'x-app-name': 'speedcool-tracking',
      },
    },
    realtime: {
      params: {
        eventsPerSecond: 10,
      },
    },
  },
)

// Proactively refresh the session every 10 minutes
// This prevents the "session expired" logout completely
let refreshInterval = null

export function startSessionRefresh() {
  if (refreshInterval) return
  refreshInterval = setInterval(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (session) {
      const expiresAt = session.expires_at * 1000
      const now = Date.now()
      const tenMinutes = 10 * 60 * 1000
      // If token expires within 10 minutes — refresh now
      if (expiresAt - now < tenMinutes) {
        await supabase.auth.refreshSession()
      }
    }
  }, 5 * 60 * 1000) // Check every 5 minutes
}

export function stopSessionRefresh() {
  if (refreshInterval) {
    clearInterval(refreshInterval)
    refreshInterval = null
  }
}
