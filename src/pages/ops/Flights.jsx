import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import Shell from '../../components/Shell'
import { fmt } from '../../lib/constants'

const FLIGHT_STATUS_LABELS = {
  SCHEDULED: 'Scheduled', DELAYED: 'Delayed', DEPARTED: 'Departed',
  EN_ROUTE: 'En route', LANDED: 'Landed', CANCELLED: 'Cancelled',
}

export default function Flights() {
  const [flights, setFlights] = useState([])
  const [form, setForm] = useState({ flight_number: '', carrier: '', origin_iata: '', destination_iata: '' })
  const [msg, setMsg] = useState(null)
  const [panel, setPanel] = useState({}) // { [flightId]: 'delay' | 'cancel' }
  const [reason, setReason] = useState({})
  const navigate = useNavigate()

  const load = async () => {
    const { data } = await supabase.from('flights').select('*')
      .order('scheduled_departure', { ascending: false }).limit(30)
    setFlights(data ?? [])
  }
  useEffect(() => {
    load()
    const ch = supabase.channel('flights')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'flights' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [])

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  const create = async (e) => {
    e.preventDefault()
    setMsg(null)
    const { error } = await supabase.from('flights').insert({
      ...form,
      origin_iata: form.origin_iata.toUpperCase(),
      destination_iata: form.destination_iata.toUpperCase(),
    })
    if (error) setMsg({ t: 'err', m: error.message })
    else { setForm({ flight_number: '', carrier: '', origin_iata: '', destination_iata: '' }); load() }
  }

  const act = async (fn, args, okMsg) => {
    setMsg(null)
    const { error } = await supabase.rpc(fn, args)
    if (error) setMsg({ t: 'err', m: error.message })
    else { setMsg({ t: 'ok', m: okMsg }); load() }
  }

  const togglePanel = (id, which) => setPanel((p) => ({ ...p, [id]: p[id] === which ? null : which }))

  const confirmDelay = (f) => {
    act('flight_delayed', { p_flight_id: f.id, p_reason: reason[f.id] || null }, `${f.flight_number} marked delayed`)
    setPanel((p) => ({ ...p, [f.id]: null }))
  }
  const confirmCancel = (f) => {
    act('flight_cancelled', { p_flight_id: f.id, p_reason: reason[f.id] || null },
      `${f.flight_number} cancelled — affected shipments moved to Exceptions`)
    setPanel((p) => ({ ...p, [f.id]: null }))
  }

  return (
    <Shell>
      <div className="page-head">
        <div><h1>Flights</h1>
          <div className="sub">Delay or cancel a flight and every affected shipment is flagged automatically.</div></div>
      </div>
      {msg && <div className={`alert ${msg.t}`}>{msg.m}</div>}

      <div className="card" style={{ maxWidth: 560 }}>
        <h3>Register flight</h3>
        <form onSubmit={create}>
          <div className="grid cols-2">
            <label className="field"><span className="lbl">Flight number</span>
              <input required placeholder="6E-1234" value={form.flight_number} onChange={set('flight_number')} />
            </label>
            <label className="field"><span className="lbl">Carrier</span>
              <input placeholder="IndiGo" value={form.carrier} onChange={set('carrier')} />
            </label>
            <label className="field"><span className="lbl">Origin IATA</span>
              <input required maxLength={3} placeholder="MAA" value={form.origin_iata} onChange={set('origin_iata')} />
            </label>
            <label className="field"><span className="lbl">Destination IATA</span>
              <input required maxLength={3} placeholder="DEL" value={form.destination_iata} onChange={set('destination_iata')} />
            </label>
          </div>
          <button className="btn">Add flight</button>
        </form>
      </div>

      {flights.map((f) => (
        <div className="card" key={f.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <div>
              <div className="mono" style={{ fontWeight: 700, fontSize: 15 }}>{f.flight_number}</div>
              <div className="muted small">{f.origin_iata} → {f.destination_iata} · {fmt(f.scheduled_departure)}</div>
              {f.disruption_reason && (
                <div className="small" style={{ color: 'var(--signal)', marginTop: 2 }}>⚠ {f.disruption_reason}</div>
              )}
            </div>
            <span className={`chip ${f.live_status === 'CANCELLED' ? 'exception' : f.live_status === 'LANDED' ? 'delivered' : ''}`}>
              {FLIGHT_STATUS_LABELS[f.live_status] ?? f.live_status}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            {['SCHEDULED', 'DELAYED'].includes(f.live_status) && (
              <button className="btn small" onClick={() => act('flight_departed', { p_flight_id: f.id }, `${f.flight_number} departed`)}>
                Mark departed
              </button>
            )}
            {['DEPARTED', 'EN_ROUTE'].includes(f.live_status) && (
              <button className="btn small dark" onClick={() => act('flight_landed', { p_flight_id: f.id }, `${f.flight_number} landed`)}>
                Mark landed
              </button>
            )}
            {['SCHEDULED', 'DELAYED'].includes(f.live_status) && (
              <button className="btn small warn" onClick={() => togglePanel(f.id, 'delay')}>Delay</button>
            )}
            {!['CANCELLED', 'LANDED'].includes(f.live_status) && (
              <button className="btn small danger" onClick={() => togglePanel(f.id, 'cancel')}>Cancel flight</button>
            )}
            {f.live_status === 'CANCELLED' && (
              <button className="btn small ghost" onClick={() => navigate('/ops/reroute')}>Reroute affected shipments</button>
            )}
          </div>

          {panel[f.id] === 'delay' && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
              <label className="field"><span className="lbl">Reason (shown to customers)</span>
                <input placeholder="e.g. Airspace restriction over route" value={reason[f.id] ?? ''}
                  onChange={(e) => setReason({ ...reason, [f.id]: e.target.value })} />
              </label>
              <button className="btn small warn" onClick={() => confirmDelay(f)}>Confirm delay</button>
            </div>
          )}
          {panel[f.id] === 'cancel' && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
              <label className="field"><span className="lbl">Reason (shown to customers)</span>
                <input placeholder="e.g. Weather diversion" value={reason[f.id] ?? ''}
                  onChange={(e) => setReason({ ...reason, [f.id]: e.target.value })} />
              </label>
              <button className="btn small danger" onClick={() => confirmCancel(f)}>Confirm cancellation</button>
            </div>
          )}
        </div>
      ))}
      {flights.length === 0 && <div className="card"><p className="muted">No flights registered yet.</p></div>}
    </Shell>
  )
}
