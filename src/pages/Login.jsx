import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { ROLE_HOME } from '../lib/constants'

// Static demo logins seeded by supabase/migrations/0003_seed_demo_users.sql.
// Set VITE_SHOW_DEMO_LOGINS=false in .env to hide this panel (e.g. in prod).
const DEMO_ACCOUNTS = [
  { role: 'Ops', email: 'ops@speedcool.com', password: 'Speedcool@123' },
  { role: 'Warehouse', email: 'warehouse@speedcool.com', password: 'Speedcool@123' },
  { role: 'Driver', email: 'driver@speedcool.com', password: 'Speedcool@123' },
  { role: 'Customer', email: 'customer@speedcool.com', password: 'Speedcool@123' },
]
const SHOW_DEMO_LOGINS = import.meta.env.VITE_SHOW_DEMO_LOGINS !== 'false'

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

  const signInAs = async (account) => {
    setBusy(true); setMsg(null)
    const { data, error } = await supabase.auth.signInWithPassword({
      email: account.email, password: account.password,
    })
    if (error) setMsg({ t: 'err', m: `${account.role} demo login failed: ${error.message}. Have you run supabase/migrations/0003_seed_demo_users.sql yet?` })
    else await goHome(data.user.id)
    setBusy(false)
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

          {SHOW_DEMO_LOGINS && mode === 'signin' && (
            <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
              <p className="small muted" style={{ textAlign: 'center', marginBottom: 8 }}>
                Demo accounts
              </p>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--line)' }}>
                    <th style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--muted)', fontWeight: 600 }}>Sign in as</th>
                    <th style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--muted)', fontWeight: 600 }}>Password</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {DEMO_ACCOUNTS.map((a) => (
                    <tr key={a.email} style={{ borderBottom: '1px solid var(--line)' }}>
                      <td style={{ padding: '6px', fontFamily: 'var(--mono)' }}>{a.email}</td>
                      <td style={{ padding: '6px', fontFamily: 'var(--mono)' }}>{a.password}</td>
                      <td style={{ padding: '6px', textAlign: 'right' }}>
                        <button
                          type="button" className="btn ghost small"
                          disabled={busy} onClick={() => signInAs(a)}
                        >
                          Sign in
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
