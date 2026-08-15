// SessionGuard — wraps every protected page
// If the session expires it tries to refresh silently first
// Only shows the "session expired" screen if refresh also fails
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

export default function SessionGuard({ children }) {
  const { session, refreshSession } = useAuth()
  const navigate = useNavigate()
  const [checking, setChecking] = useState(false)
  const [expired, setExpired] = useState(false)

  useEffect(() => {
    if (session) {
      setExpired(false)
      return
    }

    // No session — try to recover it silently
    const tryRecover = async () => {
      setChecking(true)
      const { data } = await supabase.auth.getSession()
      if (data?.session) {
        // Session exists in storage — all good
        setExpired(false)
      } else {
        // Try refreshing
        const recovered = await refreshSession()
        if (!recovered) {
          setExpired(true)
        }
      }
      setChecking(false)
    }

    tryRecover()
  }, [session])

  if (checking) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center',
        justifyContent: 'center', background: '#eef3f5',
      }}>
        <p style={{ color: '#5d707d' }}>Checking session…</p>
      </div>
    )
  }

  if (expired) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center',
        justifyContent: 'center', background: '#eef3f5', flexDirection: 'column', gap: 16,
      }}>
        <div style={{
          background: '#fff', borderRadius: 10, padding: 32,
          border: '1px solid #d7e0e5', textAlign: 'center', maxWidth: 360,
        }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>⏱️</div>
          <h2 style={{ fontFamily: 'Barlow Semi Condensed, sans-serif', marginBottom: 8 }}>
            Session expired
          </h2>
          <p style={{ color: '#5d707d', fontSize: 14, marginBottom: 20 }}>
            You were logged out after a period of inactivity.
            Sign in again to continue.
          </p>
          <button
            onClick={() => navigate('/login')}
            style={{
              background: '#0e93b0', color: '#fff', border: 'none',
              borderRadius: 6, padding: '11px 24px', fontWeight: '700',
              fontSize: 14, cursor: 'pointer', width: '100%',
            }}
          >
            Sign in again
          </button>
        </div>
      </div>
    )
  }

  return children
}
