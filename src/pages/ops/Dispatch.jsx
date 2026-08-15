import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import Shell from '../../components/Shell'
import { STATUS_LABELS } from '../../lib/constants'

export default function Dispatch() {
  const [ready, setReady] = useState([])       // CLEARED shipments
  const [customs, setCustoms] = useState([])   // LANDED / CUSTOMS_CLEARANCE
  const [vehicles, setVehicles] = useState([])
  const [pick, setPick] = useState({})
  const [msg, setMsg] = useState(null)

  const load = async () => {
    const { data: r } = await supabase.from('shipments').select('*').eq('status', 'CLEARED')
    setReady(r ?? [])
    const { data: c } = await supabase.from('shipments').select('*')
      .in('status', ['LANDED', 'CUSTOMS_CLEARANCE'])
    setCustoms(c ?? [])
    const { data: v } = await supabase.from('vehicles')
      .select('*, profiles:driver_id(full_name)').eq('active', true)
    setVehicles(v ?? [])
  }
  useEffect(() => {
    load()
    const ch = supabase.channel('dispatch')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'shipments' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [])

  const advance = async (id, to) => {
    setMsg(null)
    const { error } = await supabase.rpc('advance_shipment', { p_shipment_id: id, p_new_status: to })
    if (error) setMsg({ t: 'err', m: error.message })
  }
  const dispatch = async (id) => {
    setMsg(null)
    if (!pick[id]) { setMsg({ t: 'err', m: 'Pick a vehicle first.' }); return }
    const { error } = await supabase.rpc('dispatch_shipment', { p_shipment_id: id, p_vehicle_id: pick[id] })
    if (error) setMsg({ t: 'err', m: error.message })
    else setMsg({ t: 'ok', m: 'Dispatched — driver sees it on their route now.' })
  }

  return (
    <Shell>
      <div className="page-head">
        <div><h1>Customs & dispatch</h1>
          <div className="sub">Clear landed cargo through customs, then hand it to a delivery vehicle.</div></div>
      </div>
      {msg && <div className={`alert ${msg.t}`}>{msg.m}</div>}

      <div className="card">
        <h3>In customs</h3>
        {customs.length === 0 && <p className="muted small" style={{ marginTop: 6 }}>Nothing in customs right now.</p>}
        {customs.map((s) => (
          <div className="strip" key={s.id}>
            <div className="grow">
              <Link to={`/shipment/${s.id}`} className="tid">{s.tracking_id}</Link>
              <div className="meta">{STATUS_LABELS[s.status]} · {s.destination_city ?? '—'}</div>
            </div>
            {s.status === 'LANDED' && (
              <button className="btn small" onClick={() => advance(s.id, 'CUSTOMS_CLEARANCE')}>Start customs</button>
            )}
            {s.status === 'CUSTOMS_CLEARANCE' && (
              <button className="btn small dark" onClick={() => advance(s.id, 'CLEARED')}>Mark cleared</button>
            )}
          </div>
        ))}
      </div>

      <div className="card">
        <h3>Ready for last-mile</h3>
        {ready.length === 0 && <p className="muted small" style={{ marginTop: 6 }}>No cleared shipments waiting.</p>}
        {ready.map((s) => (
          <div className="strip" key={s.id}>
            <div className="grow">
              <Link to={`/shipment/${s.id}`} className="tid">{s.tracking_id}</Link>
              <div className="meta">{s.receiver_name} · {s.destination_address}</div>
            </div>
            <select style={{ width: 220 }} value={pick[s.id] ?? ''}
              onChange={(e) => setPick({ ...pick, [s.id]: e.target.value })}>
              <option value="">Pick vehicle…</option>
              {vehicles.map((v) => (
                <option key={v.id} value={v.id} disabled={!v.driver_id}>
                  {v.plate_number}{v.profiles?.full_name ? ` — ${v.profiles.full_name}` : ' — no driver'}
                </option>
              ))}
            </select>
            <button className="btn small" onClick={() => dispatch(s.id)}>Dispatch</button>
          </div>
        ))}
        <p className="small muted" style={{ marginTop: 8 }}>
          Vehicles need a driver assigned (Admin → Fleet) before they can be dispatched.
        </p>
      </div>
    </Shell>
  )
}
