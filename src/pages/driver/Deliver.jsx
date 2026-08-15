import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import Shell from '../../components/Shell'

export default function Deliver() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [ship, setShip] = useState(null)
  const [signedBy, setSignedBy] = useState('')
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  const canvasRef = useRef(null)
  const drawing = useRef(false)
  const hasInk = useRef(false)

  useEffect(() => {
    supabase.from('shipments').select('*').eq('id', id).single()
      .then(({ data }) => { setShip(data); setSignedBy(data?.receiver_name ?? '') })
  }, [id])

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = c.offsetWidth * dpr
    c.height = 200 * dpr
    const ctx = c.getContext('2d')
    ctx.scale(dpr, dpr)
    ctx.lineWidth = 2.2
    ctx.lineCap = 'round'
    ctx.strokeStyle = '#0e1f2b'

    const pos = (e) => {
      const r = c.getBoundingClientRect()
      const p = e.touches ? e.touches[0] : e
      return { x: p.clientX - r.left, y: p.clientY - r.top }
    }
    const down = (e) => { e.preventDefault(); drawing.current = true; const { x, y } = pos(e); ctx.beginPath(); ctx.moveTo(x, y) }
    const move = (e) => {
      if (!drawing.current) return
      e.preventDefault()
      const { x, y } = pos(e)
      ctx.lineTo(x, y); ctx.stroke(); hasInk.current = true
    }
    const up = () => { drawing.current = false }
    c.addEventListener('mousedown', down); c.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    c.addEventListener('touchstart', down, { passive: false })
    c.addEventListener('touchmove', move, { passive: false })
    c.addEventListener('touchend', up)
    return () => {
      c.removeEventListener('mousedown', down); c.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      c.removeEventListener('touchstart', down); c.removeEventListener('touchmove', move)
      c.removeEventListener('touchend', up)
    }
  }, [ship])

  const clearSig = () => {
    const c = canvasRef.current
    c.getContext('2d').clearRect(0, 0, c.width, c.height)
    hasInk.current = false
  }

  const complete = async () => {
    setMsg(null)
    if (!signedBy.trim()) { setMsg({ t: 'err', m: 'Enter who signed for the delivery.' }); return }
    if (!hasInk.current) { setMsg({ t: 'err', m: 'Capture a signature first.' }); return }
    setBusy(true)
    try {
      const blob = await new Promise((res) => canvasRef.current.toBlob(res, 'image/png'))
      const path = `${ship.id}/signature-${Date.now()}.png`
      const { error: upErr } = await supabase.storage.from('pods').upload(path, blob, { contentType: 'image/png' })
      if (upErr) throw upErr

      let lat = null, lng = null
      try {
        const p = await new Promise((res, rej) =>
          navigator.geolocation.getCurrentPosition(res, rej, { timeout: 4000 }))
        lat = p.coords.latitude; lng = p.coords.longitude
      } catch { /* location optional */ }

      const { error } = await supabase.rpc('complete_delivery', {
        p_shipment_id: ship.id, p_signed_by: signedBy.trim(),
        p_signature_path: path, p_lat: lat, p_lng: lng,
      })
      if (error) throw error
      navigate('/driver')
    } catch (e) {
      setMsg({ t: 'err', m: e.message ?? String(e) })
    }
    setBusy(false)
  }

  if (!ship) return <Shell><p className="muted">Loading…</p></Shell>

  return (
    <Shell>
      <div className="page-head">
        <div><h1 className="mono">{ship.tracking_id}</h1>
          <div className="sub">{ship.receiver_name} · {ship.destination_address}</div></div>
      </div>
      <div className="card" style={{ maxWidth: 520 }}>
        {msg && <div className={`alert ${msg.t}`}>{msg.m}</div>}
        <label className="field"><span className="lbl">Received &amp; signed by</span>
          <input value={signedBy} onChange={(e) => setSignedBy(e.target.value)} />
        </label>
        <span className="lbl" style={{ fontFamily: 'var(--mono)', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--muted)' }}>
          Signature
        </span>
        <canvas ref={canvasRef} className="sig-pad" style={{ height: 200, marginTop: 4 }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn ghost" onClick={clearSig}>Clear</button>
          <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={complete}>
            {busy ? 'Saving…' : 'Complete delivery'}
          </button>
        </div>
        <p className="small muted" style={{ marginTop: 10 }}>
          Saves the signed proof of delivery, records your location if permitted,
          and instantly notifies the customer.
        </p>
      </div>
    </Shell>
  )
}
