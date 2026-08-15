import { createContext, useContext, useEffect, useState } from 'react'
import { supabase, startSessionRefresh, stopSessionRefresh } from '../lib/supabase'

const AuthCtx = createContext({ session: null, profile: null, loading: true })

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [sessionError, setSessionError] = useState(null)

  // Load initial session
  useEffect(() => {
    supabase.auth.getSession().then(({ data, error }) => {
      if (error) {
        console.error('Session load error:', error)
        setLoading(false)
        return
      }
      setSession(data.session)
      if (!data.session) setLoading(false)
    })

    // Listen for auth events
    const { data: sub } = supabase.auth.onAuthStateChange((event, sess) => {
      console.log('Auth event:', event)

      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        setSession(sess)
        setSessionError(null)
        startSessionRefresh() // Start keeping session alive
      }

      if (event === 'SIGNED_OUT') {
        setSession(null)
        setProfile(null)
        setLoading(false)
        stopSessionRefresh()
      }

      if (event === 'TOKEN_REFRESHED') {
        setSession(sess) // Update with fresh token
      }

      // Session expired — try to refresh once before logging out
      if (event === 'USER_UPDATED') {
        setSession(sess)
      }
    })

    return () => {
      sub.subscription.unsubscribe()
      stopSessionRefresh()
    }
  }, [])

  // Load profile whenever session changes
  useEffect(() => {
    if (!session?.user) return
    let cancelled = false

    const loadProfile = async () => {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', session.user.id)
          .single()

        if (!cancelled) {
          if (error) {
            console.error('Profile load error:', error)
            // If it's an auth error — try refreshing the session
            if (error.code === 'PGRST301' || error.message?.includes('JWT')) {
              const { error: refreshError } = await supabase.auth.refreshSession()
              if (!refreshError) {
                // Retry profile load after refresh
                const { data: retryData } = await supabase
                  .from('profiles')
                  .select('*')
                  .eq('id', session.user.id)
                  .single()
                if (!cancelled && retryData) {
                  setProfile(retryData)
                }
              }
            }
          } else {
            setProfile(data ?? null)
          }
          setLoading(false)
        }
      } catch (err) {
        console.error('Profile load failed:', err)
        if (!cancelled) setLoading(false)
      }
    }

    loadProfile()
    startSessionRefresh() // Keep session alive while logged in

    return () => { cancelled = true }
  }, [session?.user?.id])

  const signOut = async () => {
    stopSessionRefresh()
    await supabase.auth.signOut()
  }

  // Auto-recover from expired session
  const refreshSession = async () => {
    const { data, error } = await supabase.auth.refreshSession()
    if (!error && data.session) {
      setSession(data.session)
      setSessionError(null)
      return true
    }
    return false
  }

  return (
    <AuthCtx.Provider value={{
      session,
      profile,
      loading,
      sessionError,
      signOut,
      refreshSession,
    }}>
      {children}
    </AuthCtx.Provider>
  )
}

export const useAuth = () => useContext(AuthCtx)
