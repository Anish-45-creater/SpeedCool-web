import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { ROLE_HOME } from '../lib/constants'

export default function Login() {
  const { session, profile } = useAuth()
  const [mode, setMode] = useState('signin') // signin | signup | forgot
  const [form, setForm] = useState({ email: '', password: '', full_name: '', phone: '' })
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })
  const swap = (m) => (e) => { e.preventDefault(); setMode(m); setMsg(null) }

  // Already signed in? Straight to the right console.
  useEffect(() => {
    if (session && profile) navigate(ROLE_HOME[profile.role] ?? '/my', { replace: true })
  }, [session, profile])

  const goHome = async (userId) => {
    const { data: p } = await supabase.from('profiles').select('role').eq('id', userId).single()
    navigate(ROLE_HOME[p?.role] ?? '/my')
  }

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setMsg(null)

    if (mode === 'signin') {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: form.email.trim(), password: form.password,
      })
      if (error) setMsg({ t: 'err', m: error.message })
      else await goHome(data.user.id)

    } else if (mode === 'signup') {
      const { data, error } = await supabase.auth.signUp({
        email: form.email.trim(),
        password: form.password,
        options: { data: { full_name: form.full_name, phone: form.phone } },
      })
      if (error) setMsg({ t: 'err', m: error.message })
      else if (data.session) {
        // email confirmation is off — user is signed in, go straight in
        await goHome(data.user.id)
      } else {
        setMsg({ t: 'ok', m: 'Account created. Check your inbox to confirm your email, then sign in.' })
        setMode('signin')
      }

    } else if (mode === 'forgot') {
      const { error } = await supabase.auth.resetPasswordForEmail(form.email.trim(), {
        redirectTo: `${window.location.origin}/reset`,
      })
      if (error) setMsg({ t: 'err', m: error.message })
      else setMsg({ t: 'ok', m: 'Password reset link sent — check your inbox.' })
    }
    setBusy(false)
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="card">
          <div className="auth-brand">SPEED<span>COOL</span></div>
          <div className="auth-sub">
            {mode === 'signin' && 'Sign in — customers, ops, warehouse, drivers & admins'}
            {mode === 'signup' && 'Create a customer account'}
            {mode === 'forgot' && 'Reset your password'}
          </div>
          {msg && <div className={`alert ${msg.t}`}>{msg.m}</div>}
          <form onSubmit={submit}>
            {mode === 'signup' && (
              <>
                <label className="field"><span className="lbl">Full name</span>
                  <input required value={form.full_name} onChange={set('full_name')} />
                </label>
                <label className="field"><span className="lbl">Phone</span>
                  <input value={form.phone} onChange={set('phone')} placeholder="+91…" />
                </label>
              </>
            )}
            <label className="field"><span className="lbl">Email</span>
              <input type="email" required value={form.email} onChange={set('email')} />
            </label>
            {mode !== 'forgot' && (
              <label className="field"><span className="lbl">Password</span>
                <input type="password" required minLength={6} value={form.password} onChange={set('password')} />
              </label>
            )}
            <button className="btn" style={{ width: '100%' }} disabled={busy}>
              {busy ? 'Please wait…'
                : mode === 'signin' ? 'Sign in'
                : mode === 'signup' ? 'Create account'
                : 'Send reset link'}
            </button>
          </form>
          <p className="small" style={{ textAlign: 'center', marginTop: 14 }}>
            {mode === 'signin' && (
              <>New customer? <a href="#" onClick={swap('signup')}>Create an account</a>
                {' · '}<a href="#" onClick={swap('forgot')}>Forgot password?</a></>
            )}
            {mode !== 'signin' && (
              <>Already registered? <a href="#" onClick={swap('signin')}>Sign in</a></>
            )}
          </p>
          <p className="small muted" style={{ textAlign: 'center', marginTop: 6 }}>
            Staff accounts are created by your admin (see Admin → Team).
          </p>
          <p className="small muted" style={{ textAlign: 'center', marginTop: 6 }}>
            <Link to="/">← Back to tracking</Link>
          </p>
        </div>
      </div>
    </div>
  )
}
