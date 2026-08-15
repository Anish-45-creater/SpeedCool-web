import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import Shell from '../../components/Shell'
import { STATUS_FLOW, STATUS_LABELS } from '../../lib/constants'

export default function Exceptions() {
  const [items, setItems] = useState([])
  const [lastEvent, setLastEvent] = useState({})
  const [resolveTo, setResolveTo] = useState({})
  const [note, setNote] = useState({})
  const [msg, setMsg] = useState(null)

  const load = async () => {
    const { data } = await supabase.from('shipments').select('*').eq('status', 'EXCEPTION')
    setItems(data ?? [])
    const ids = (data ?? []).map((s) => s.id)
    if (ids.length) {
      const { data: ev } = await supabase.from('shipment_events')
        .select('shipment_id, note, created_at').in('shipment_id', ids)
        .eq('status', 'EXCEPTION').order('created_at', { ascending: false })
      const map = {}
      for (const e of ev ?? []) if (!map[e.shipment_id]) map[e.shipment_id] = e
      setLastEvent(map)
    }
  }
  useEffect(() => {
    load()
    const ch = supabase.channel('exceptions')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'shipments' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [])

  const resolve = async (id) => {
    setMsg(null)
    const to = resolveTo[id]
    if (!to) { setMsg({ t: 'err', m: 'Choose which stage to resume at.' }); return }
    const { error } = await supabase.rpc('advance_shipment', {
      p_shipment_id: id, p_new_status: to,
      p_note: note[id] ? `Resolved: ${note[id]}` : 'Exception resolved',
    })
    if (error) setMsg({ t: 'err', m: error.message })
    else setMsg({ t: 'ok', m: `Resumed at ${STATUS_LABELS[to]}` })
  }

  return (
    <Shell>
      <div className="page-head">
        <div><h1>Exception queue</h1>
          <div className="sub">Flight delays, customs holds, failed deliveries — resolve and resume the journey.</div></div>
      </div>
      {msg && <div className={`alert ${msg.t}`}>{msg.m}</div>}
      {items.length === 0 && <div className="card"><p className="muted">No open exceptions. All cargo is moving.</p></div>}
      {items.map((s) => (
        <div className="card" key={s.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <Link to={`/shipment/${s.id}`} className="mono" style={{ fontWeight: 600 }}>{s.tracking_id}</Link>
            <span className="chip exception">Exception</span>
          </div>
          <p className="small" style={{ marginTop: 6 }}>
            {lastEvent[s.id]?.note ?? 'No note recorded'} ·{' '}
            <span className="muted mono">{lastEvent[s.id] ? new Date(lastEvent[s.id].created_at).toLocaleString() : ''}</span>
          </p>
          {(lastEvent[s.id]?.note ?? '').toLowerCase().includes('flight') && (
            <Link to="/ops/reroute" className="btn ghost small" style={{ marginTop: 8, display: 'inline-block' }}>
              View re-routing activity →
            </Link>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label className="field" style={{ marginBottom: 0, width: 240 }}>
              <span className="lbl">Resume at stage</span>
              <select value={resolveTo[s.id] ?? ''} onChange={(e) => setResolveTo({ ...resolveTo, [s.id]: e.target.value })}>
                <option value="">Select…</option>
                {STATUS_FLOW.filter((st) => st !== 'DELIVERED').map((st) => <option key={st} value={st}>{STATUS_LABELS[st]}</option>)}
              </select>
            </label>
            <label className="field" style={{ marginBottom: 0, flex: 1, minWidth: 200 }}>
              <span className="lbl">Resolution note</span>
              <input value={note[s.id] ?? ''} onChange={(e) => setNote({ ...note, [s.id]: e.target.value })} />
            </label>
            <button className="btn" onClick={() => resolve(s.id)}>Resolve</button>
          </div>
        </div>
      ))}
    </Shell>
  )
}
