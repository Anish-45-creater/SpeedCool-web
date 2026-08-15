import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import Shell from '../../components/Shell'

export default function Reroute() {
  const [items, setItems] = useState([])
  const [alternates, setAlternates] = useState({}) // "origin|dest" -> flights[]
  const [pick, setPick] = useState({})
  const [reason, setReason] = useState({})
  const [msg, setMsg] = useState(null)

  const load = async () => {
    const { data } = await supabase
      .from('shipments')
      .select('*, manifests(id, flights(id, flight_number, origin_iata, destination_iata, live_status))')
      .neq('status', 'DELIVERED')

    const affected = (data ?? []).filter((s) => {
      const flightStatus = s.manifests?.flights?.live_status
      return s.status === 'EXCEPTION' || ['DELAYED', 'CANCELLED'].includes(flightStatus)
    })
    setItems(affected)

    const routes = new Set()
    for (const s of affected) {
      const f = s.manifests?.flights
      if (f) routes.add(`${f.origin_iata}|${f.destination_iata}|${f.id}`)
    }
    const altMap = {}
    for (const key of routes) {
      const [origin, destination, excludeId] = key.split('|')
      const { data: alts } = await supabase.from('flights')
        .select('*')
        .eq('origin_iata', origin).eq('destination_iata', destination)
        .neq('id', excludeId).neq('live_status', 'CANCELLED')
        .order('scheduled_departure')
      altMap[`${origin}|${destination}`] = alts ?? []
    }
    setAlternates(altMap)
  }

  useEffect(() => {
    load()
    const ch = supabase.channel('reroute')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shipments' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'flights' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [])

  const reroute = async (s) => {
    setMsg(null)
    const flightId = pick[s.id]
    if (!flightId) { setMsg({ t: 'err', m: 'Pick an alternate flight first.' }); return }
    const { error } = await supabase.rpc('reroute_shipment', {
      p_shipment_id: s.id, p_new_flight_id: flightId, p_reason: reason[s.id] || null,
    })
    if (error) setMsg({ t: 'err', m: error.message })
    else { setMsg({ t: 'ok', m: `${s.tracking_id} rerouted — customer notified` }); load() }
  }

  return (
    <Shell>
      <div className="page-head">
        <div><h1>Reroute</h1>
          <div className="sub">Shipments stuck on a delayed or cancelled flight — move each to an alternate in one click.</div></div>
      </div>
      {msg && <div className={`alert ${msg.t}`}>{msg.m}</div>}

      {items.length === 0 && (
        <div className="card"><p className="muted">Nothing needs rerouting right now — all flights on schedule.</p></div>
      )}

      {items.map((s) => {
        const f = s.manifests?.flights
        const routeKey = f ? `${f.origin_iata}|${f.destination_iata}` : null
        const alts = routeKey ? (alternates[routeKey] ?? []) : []
        return (
          <div className="card" key={s.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div>
                <Link to={`/shipment/${s.id}`} className="tid mono" style={{ fontWeight: 700 }}>{s.tracking_id}</Link>
                <div className="muted small">{f ? `${f.flight_number} · ${f.origin_iata}→${f.destination_iata}` : 'No flight assigned'}</div>
              </div>
              {f && <span className="chip">{f.live_status}</span>}
            </div>

            {alts.length === 0 ? (
              <p className="small muted" style={{ marginTop: 10 }}>
                No alternate flight registered yet for this route — add one on the Flights page.
              </p>
            ) : (
              <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <label className="field" style={{ minWidth: 220, marginBottom: 0 }}>
                  <span className="lbl">Alternate flight</span>
                  <select value={pick[s.id] ?? ''} onChange={(e) => setPick({ ...pick, [s.id]: e.target.value })}>
                    <option value="">Select flight…</option>
                    {alts.map((a) => <option key={a.id} value={a.id}>{a.flight_number} · {a.live_status}</option>)}
                  </select>
                </label>
                <label className="field" style={{ flex: 1, minWidth: 220, marginBottom: 0 }}>
                  <span className="lbl">Reason (shown to customer)</span>
                  <input placeholder="e.g. Rebooked due to cancellation" value={reason[s.id] ?? ''}
                    onChange={(e) => setReason({ ...reason, [s.id]: e.target.value })} />
                </label>
                <button className="btn" disabled={!pick[s.id]} onClick={() => reroute(s)}>Reroute shipment</button>
              </div>
            )}
          </div>
        )
      })}
    </Shell>
  )
}
