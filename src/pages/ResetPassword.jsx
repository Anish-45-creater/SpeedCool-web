import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { ROLE_HOME } from '../lib/constants'

// User lands here from the password-reset email. Supabase puts a recovery
// session in the URL; the client picks it up automatically, then we let
// them set a new password.
export default function ResetPassword() {
  const [ready, setReady] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setReady(!!data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || session) setReady(true)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const submit = async (e) => {
    e.preventDefault()
    setMsg(null)
    if (password !== confirm) { setMsg({ t: 'err', m: 'Passwords do not match.' }); return }
    setBusy(true)
    const { data, error } = await supabase.auth.updateUser({ password })
    if (error) setMsg({ t: 'err', m: error.message })
    else {
      const { data: p } = await supabase.from('profiles').select('role').eq('id', data.user.id).single()
      navigate(ROLE_HOME[p?.role] ?? '/my')
    }
    setBusy(false)
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="card">
          <div className="auth-brand">SPEED<span>COOL</span></div>
          <div className="auth-sub">Set a new password</div>
          {msg && <div className={`alert ${msg.t}`}>{msg.m}</div>}
          {!ready ? (
            <>
              <p className="muted small">
                Waiting for your reset link… Open this page from the link in your
                password-reset email. If the link expired, request a new one.
              </p>
              <p className="small" style={{ textAlign: 'center', marginTop: 12 }}>
                <Link to="/login">← Back to sign in</Link>
              </p>
            </>
          ) : (
            <form onSubmit={submit}>
              <label className="field"><span className="lbl">New password</span>
                <input type="password" required minLength={6} value={password}
                  onChange={(e) => setPassword(e.target.value)} />
              </label>
              <label className="field"><span className="lbl">Confirm password</span>
                <input type="password" required minLength={6} value={confirm}
                  onChange={(e) => setConfirm(e.target.value)} />
              </label>
              <button className="btn" style={{ width: '100%' }} disabled={busy}>
                {busy ? 'Saving…' : 'Save & sign in'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
