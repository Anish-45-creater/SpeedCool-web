import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import Shell from '../../components/Shell'
import Modal from '../../components/Modal'
import { fmt, FLIGHT_STATUS_LABELS } from '../../lib/constants'

const FLIGHT_TONE = {
  DELAYED: 'exception', CANCELLED: 'exception', LANDED: 'delivered',
  EN_ROUTE: 'transit', DEPARTED: 'transit', BOARDING: 'transit',
}

const EMPTY_FORM = {
  flight_number: '', carrier: '', origin_iata: '', destination_iata: '',
  departure: '', arrival: '', capacity_kg: '',
}

function toLocalInputValue(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function durationLabel(depIso, arrIso) {
  if (!depIso || !arrIso) return null
  const mins = Math.round((new Date(arrIso) - new Date(depIso)) / 60000)
  if (mins <= 0 || Number.isNaN(mins)) return null
  const h = Math.floor(mins / 60), m = mins % 60
  return `${h}h ${m}m`
}

export default function Flights() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const navigate = useNavigate()

  const [flights, setFlights] = useState([])
  const [msg, setMsg] = useState(null)
  const [expanded, setExpanded] = useState(null)

  // modal state: null | 'add' | { mode: 'edit'|'delay'|'cancel', flight }
  const [modal, setModal] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [delayValue, setDelayValue] = useState(6)
  const [delayUnit, setDelayUnit] = useState('hours')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)

  const load = async () => {
    const { data } = await supabase.from('flights').select('*')
      .order('scheduled_departure', { ascending: false }).limit(40)
    setFlights(data ?? [])
  }
  useEffect(() => {
    load()
    const ch = supabase.channel('flights')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'flights' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [])

  const openAdd = () => { setForm(EMPTY_FORM); setMsg(null); setModal('add') }
  const openEdit = (f) => {
    setForm({
      flight_number: f.flight_number, carrier: f.carrier ?? '',
      origin_iata: f.origin_iata, destination_iata: f.destination_iata,
      departure: toLocalInputValue(f.scheduled_departure),
      arrival: toLocalInputValue(f.scheduled_arrival),
      capacity_kg: f.capacity_kg ?? '',
    })
    setMsg(null); setModal({ mode: 'edit', flight: f })
  }
  const openDelay = (f) => { setDelayValue(6); setDelayUnit('hours'); setReason(''); setMsg(null); setModal({ mode: 'delay', flight: f }) }
  const openCancel = (f) => { setReason(''); setMsg(null); setModal({ mode: 'cancel', flight: f }) }
  const closeModal = () => { if (!busy) setModal(null) }

  const submitAddOrEdit = async (e) => {
    e.preventDefault()
    setMsg(null)
    const departure = form.departure ? new Date(form.departure).toISOString() : null
    const arrival = form.arrival ? new Date(form.arrival).toISOString() : null
    const durationMinutes = departure && arrival ? Math.round((new Date(arrival) - new Date(departure)) / 60000) : null
    setBusy(true)
    if (modal === 'add') {
      const { error } = await supabase.rpc('admin_add_flight', {
        p_flight_number: form.flight_number, p_carrier: form.carrier || null,
        p_origin_iata: form.origin_iata, p_destination_iata: form.destination_iata,
        p_departure: departure, p_arrival: arrival,
        p_duration_minutes: durationMinutes, p_capacity_kg: form.capacity_kg === '' ? null : Number(form.capacity_kg),
      })
      setBusy(false)
      if (error) setMsg({ t: 'err', m: error.message })
      else { setModal(null); load() }
    } else if (modal?.mode === 'edit') {
      const { error } = await supabase.rpc('admin_update_flight', {
        p_flight_id: modal.flight.id, p_flight_number: form.flight_number, p_carrier: form.carrier || null,
        p_origin_iata: form.origin_iata, p_destination_iata: form.destination_iata,
        p_departure: departure, p_arrival: arrival,
        p_duration_minutes: durationMinutes, p_capacity_kg: form.capacity_kg === '' ? null : Number(form.capacity_kg),
      })
      setBusy(false)
      if (error) setMsg({ t: 'err', m: error.message })
      else { setModal(null); load() }
    }
  }

  const confirmDelay = async () => {
    if (!reason.trim()) { setMsg({ t: 'err', m: 'Delay reason is required.' }); return }
    const minutes = Number(delayValue) * (delayUnit === 'hours' ? 60 : 1)
    if (!minutes || minutes <= 0) { setMsg({ t: 'err', m: 'Enter a delay duration greater than zero.' }); return }
    setMsg(null); setBusy(true); setChecking(true)
    const { error } = await supabase.rpc('admin_delay_flight', {
      p_flight_id: modal.flight.id, p_reason: reason, p_duration_minutes: minutes,
    })
    setChecking(false); setBusy(false)
    if (error) setMsg({ t: 'err', m: error.message })
    else { setModal(null); load() }
  }

  const confirmCancel = async () => {
    if (!reason.trim()) { setMsg({ t: 'err', m: 'Cancellation reason is required.' }); return }
    setMsg(null); setBusy(true); setChecking(true)
    const { error } = await supabase.rpc('admin_cancel_flight', {
      p_flight_id: modal.flight.id, p_reason: reason,
    })
    setChecking(false); setBusy(false)
    if (error) setMsg({ t: 'err', m: error.message })
    else { setModal(null); load() }
  }

  // live preview for the delay modal
  const previewFlight = modal?.mode === 'delay' ? modal.flight : null
  const previewMinutes = previewFlight ? Number(delayValue) * (delayUnit === 'hours' ? 60 : 1) : 0
  const previewDep = previewFlight && previewMinutes > 0
    ? new Date(new Date(previewFlight.scheduled_departure).getTime() + previewMinutes * 60000) : null
  const previewArr = previewFlight && previewMinutes > 0 && previewFlight.scheduled_arrival
    ? new Date(new Date(previewFlight.scheduled_arrival).getTime() + previewMinutes * 60000) : null

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Flights</h1>
          <div className="sub">
            {isAdmin
              ? 'Add, edit, delay or cancel flights. Delaying or cancelling automatically re-routes affected cargo — there is no manual "pick a flight" step.'
              : 'Live monitoring only. Adding, editing, delaying and cancelling flights is restricted to Admin.'}
          </div>
        </div>
        {isAdmin && <button className="btn" onClick={openAdd}>+ Add Flight</button>}
      </div>
      {msg && <div className={`alert ${msg.t}`}>{msg.m}</div>}
      {!isAdmin && (
        <div className="alert warn">
          You're signed in as <strong>Ops</strong>. You can monitor every flight here, but adding, editing, delaying,
          and cancelling flights (and choosing replacement flights) is admin-only — the automatic re-routing engine
          handles that without any manual selection.
        </div>
      )}

      {flights.map((f) => {
        const dur = durationLabel(f.scheduled_departure, f.scheduled_arrival)
        const capPct = f.capacity_kg ? Math.min(100, Math.round((f.capacity_used_kg / f.capacity_kg) * 100)) : null
        return (
          <div className="card" key={f.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div>
                <div className="mono" style={{ fontWeight: 700, fontSize: 15 }}>
                  {f.flight_number} {f.carrier && <span className="muted small">· {f.carrier}</span>}
                </div>
                <div className="muted small">
                  {f.origin_iata} → {f.destination_iata} · Dep {fmt(f.scheduled_departure)}
                  {f.scheduled_arrival && <> · Arr {fmt(f.scheduled_arrival)}</>}
                  {dur && <> · {dur}</>}
                </div>
                {f.disruption_reason && (
                  <div className="small" style={{ color: 'var(--signal)', marginTop: 2 }}>
                    ⚠ {f.live_status === 'CANCELLED' ? 'Cancelled' : 'Delayed'} — {f.disruption_reason}
                    {f.live_status === 'DELAYED' && f.delay_duration_minutes ? ` (+${f.delay_duration_minutes} min)` : ''}
                  </div>
                )}
              </div>
              <span className={`chip ${FLIGHT_TONE[f.live_status] ?? ''}`}>
                {FLIGHT_STATUS_LABELS[f.live_status] ?? f.live_status}
              </span>
            </div>

            {f.capacity_kg != null && (
              <div style={{ marginTop: 10 }}>
                <div className="muted small">Cargo capacity: {f.capacity_used_kg ?? 0} / {f.capacity_kg} kg</div>
                <div style={{ background: 'var(--frost)', borderRadius: 999, height: 6, marginTop: 4, overflow: 'hidden' }}>
                  <div style={{ width: `${capPct}%`, background: capPct >= 90 ? 'var(--signal)' : 'var(--glacier)', height: '100%' }} />
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
              <button className="btn small ghost" onClick={() => setExpanded(expanded === f.id ? null : f.id)}>
                👁 {expanded === f.id ? 'Hide details' : 'View details'}
              </button>
              {isAdmin && !['CANCELLED', 'LANDED', 'COMPLETED'].includes(f.live_status) && (
                <button className="btn small ghost" onClick={() => openEdit(f)}>✏ Edit</button>
              )}
              {isAdmin && ['SCHEDULED', 'DELAYED'].includes(f.live_status) && (
                <button className="btn small warn" onClick={() => openDelay(f)}>⏱ Delay</button>
              )}
              {isAdmin && !['CANCELLED', 'LANDED', 'COMPLETED'].includes(f.live_status) && (
                <button className="btn small danger" onClick={() => openCancel(f)}>✕ Cancel</button>
              )}
              {f.live_status === 'CANCELLED' && (
                <button className="btn small ghost" onClick={() => navigate('/ops/reroute')}>
                  View re-routing activity →
                </button>
              )}
            </div>

            {expanded === f.id && (
              <div className="reroute-preview">
                <table style={{ width: '100%' }}><tbody>
                  <tr><td className="muted small" style={{ width: 160 }}>Original departure</td><td className="small">{fmt(f.original_scheduled_departure) ?? '—'}</td></tr>
                  <tr><td className="muted small">Original arrival</td><td className="small">{fmt(f.original_scheduled_arrival) ?? '—'}</td></tr>
                  <tr><td className="muted small">Delay reason</td><td className="small">{f.delay_reason ?? '—'}</td></tr>
                  <tr><td className="muted small">Total delay</td><td className="small">{f.delay_duration_minutes ? `${f.delay_duration_minutes} min` : '—'}</td></tr>
                  <tr><td className="muted small">Capacity used</td><td className="small">{f.capacity_used_kg ?? 0} kg{f.capacity_kg ? ` of ${f.capacity_kg} kg` : ''}</td></tr>
                  <tr><td className="muted small">Last synced</td><td className="small">{fmt(f.last_synced_at) ?? '—'}</td></tr>
                </tbody></table>
              </div>
            )}
          </div>
        )
      })}
      {flights.length === 0 && <div className="card"><p className="muted">No flights registered yet.</p></div>}

      {/* ---------- Add / Edit modal ---------- */}
      {(modal === 'add' || modal?.mode === 'edit') && (
        <Modal
          title={modal === 'add' ? 'Add Flight' : `Edit ${modal.flight.flight_number}`}
          subtitle="Departure and arrival must be exact timestamps — they drive automatic re-routing."
          onClose={closeModal}
          width={520}
        >
          {msg && <div className={`alert ${msg.t}`}>{msg.m}</div>}
          <form onSubmit={submitAddOrEdit}>
            <div className="grid cols-2">
              <label className="field"><span className="lbl">Flight number</span>
                <input required value={form.flight_number} onChange={(e) => setForm({ ...form, flight_number: e.target.value })} placeholder="SC101" />
              </label>
              <label className="field"><span className="lbl">Airline</span>
                <input value={form.carrier} onChange={(e) => setForm({ ...form, carrier: e.target.value })} placeholder="Speedcool Air" />
              </label>
              <label className="field"><span className="lbl">Source airport (IATA)</span>
                <input required maxLength={3} value={form.origin_iata} onChange={(e) => setForm({ ...form, origin_iata: e.target.value.toUpperCase() })} placeholder="MAA" />
              </label>
              <label className="field"><span className="lbl">Destination airport (IATA)</span>
                <input required maxLength={3} value={form.destination_iata} onChange={(e) => setForm({ ...form, destination_iata: e.target.value.toUpperCase() })} placeholder="DXB" />
              </label>
              <label className="field"><span className="lbl">Departure date &amp; time</span>
                <input required type="datetime-local" value={form.departure} onChange={(e) => setForm({ ...form, departure: e.target.value })} />
              </label>
              <label className="field"><span className="lbl">Expected arrival date &amp; time</span>
                <input required type="datetime-local" value={form.arrival} onChange={(e) => setForm({ ...form, arrival: e.target.value })} />
              </label>
              <label className="field"><span className="lbl">Cargo capacity (kg)</span>
                <input required type="number" min="0" step="1" value={form.capacity_kg} onChange={(e) => setForm({ ...form, capacity_kg: e.target.value })} placeholder="2000" />
              </label>
              <label className="field"><span className="lbl">Flight duration</span>
                <input disabled value={durationLabel(form.departure, form.arrival) ?? 'Set both times'} />
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button className="btn" disabled={busy}>{busy ? 'Saving…' : modal === 'add' ? 'Add flight' : 'Save changes'}</button>
              <button type="button" className="btn ghost" onClick={closeModal} disabled={busy}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}

      {/* ---------- Delay modal ---------- */}
      {modal?.mode === 'delay' && (
        <Modal title="Delay Flight" subtitle={`${modal.flight.flight_number} · ${modal.flight.origin_iata} → ${modal.flight.destination_iata}`} onClose={closeModal}>
          {msg && <div className={`alert ${msg.t}`}>{msg.m}</div>}
          <label className="field"><span className="lbl">Delay reason</span>
            <input required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Technical issue" />
          </label>
          <div className="grid cols-2">
            <label className="field"><span className="lbl">Delay duration</span>
              <input type="number" min="1" value={delayValue} onChange={(e) => setDelayValue(e.target.value)} />
            </label>
            <label className="field"><span className="lbl">Unit</span>
              <select value={delayUnit} onChange={(e) => setDelayUnit(e.target.value)}>
                <option value="minutes">Minutes</option>
                <option value="hours">Hours</option>
              </select>
            </label>
          </div>

          {previewDep && (
            <div className="reroute-preview">
              <div><strong>New departure:</strong> {fmt(previewDep.toISOString())}</div>
              {previewArr && <div><strong>New arrival:</strong> {fmt(previewArr.toISOString())}</div>}
              <div className="reroute-flow">
                <span className="step">⚠ Delayed</span>
                <span className="arrow">→</span>
                <span className="step">🔍 Search same route, earlier than new departure</span>
                <span className="arrow">→</span>
                <span className="step">🔄 Auto-assign earliest match, or keep on delayed flight</span>
              </div>
            </div>
          )}

          {checking && (
            <div className="alert ok">
              <span className="spin">🔄</span> Checking alternative flights<span className="searching-dots" />
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn warn" onClick={confirmDelay} disabled={busy}>{busy ? 'Confirming…' : 'Confirm Delay'}</button>
            <button className="btn ghost" onClick={closeModal} disabled={busy}>Cancel</button>
          </div>
        </Modal>
      )}

      {/* ---------- Cancel modal ---------- */}
      {modal?.mode === 'cancel' && (
        <Modal title="Cancel Flight" subtitle={`${modal.flight.flight_number} · ${modal.flight.origin_iata} → ${modal.flight.destination_iata}`} onClose={closeModal}>
          {msg && <div className={`alert ${msg.t}`}>{msg.m}</div>}
          <label className="field"><span className="lbl">Cancellation reason</span>
            <input required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Aircraft technical issue" />
          </label>
          <div className="alert warn">
            ⚠ Cargo currently on this flight will be automatically searched for an alternative flight with the same
            source and destination. If none is available yet, affected shipments move to Exceptions and will be
            re-routed automatically the moment a suitable flight is added or freed up.
          </div>
          {checking && (
            <div className="alert ok">
              <span className="spin">🔄</span> Searching for alternative flights and re-routing cargo<span className="searching-dots" />
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn danger" onClick={confirmCancel} disabled={busy}>{busy ? 'Confirming…' : 'Confirm Cancellation'}</button>
            <button className="btn ghost" onClick={closeModal} disabled={busy}>Back</button>
          </div>
        </Modal>
      )}
    </Shell>
  )
}
