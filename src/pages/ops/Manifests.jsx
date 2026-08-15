import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import Shell from '../../components/Shell'

export default function Manifests() {
  const [manifests, setManifests] = useState([])
  const [warehouses, setWarehouses] = useState([])
  const [flights, setFlights] = useState([])
  const [shipsByManifest, setShipsByManifest] = useState({})
  const [newWh, setNewWh] = useState('')
  const [addTid, setAddTid] = useState({})
  const [flightPick, setFlightPick] = useState({})
  const [msg, setMsg] = useState(null)

  const load = async () => {
    const { data: m } = await supabase.from('manifests')
      .select('*, warehouses(name), flights(flight_number, live_status)')
      .order('created_at', { ascending: false }).limit(25)
    setManifests(m ?? [])
    const { data: w } = await supabase.from('warehouses').select('*')
    setWarehouses(w ?? [])
    const { data: f } = await supabase.from('flights').select('*')
      .in('live_status', ['SCHEDULED', 'DELAYED']).order('scheduled_departure')
    setFlights(f ?? [])
    const ids = (m ?? []).map((x) => x.id)
    if (ids.length) {
      const { data: s } = await supabase.from('shipments')
        .select('id, tracking_id, status, manifest_id').in('manifest_id', ids)
      const grouped = {}
      for (const sh of s ?? []) (grouped[sh.manifest_id] ??= []).push(sh)
      setShipsByManifest(grouped)
    }
  }
  useEffect(() => { load() }, [])

  const run = async (fn, args, okMsg) => {
    setMsg(null)
    const { error } = await supabase.rpc(fn, args)
    if (error) setMsg({ t: 'err', m: error.message })
    else { setMsg({ t: 'ok', m: okMsg }); load() }
  }

  const createManifest = async () => {
    setMsg(null)
    const { data: u } = await supabase.auth.getUser()
    const { error } = await supabase.from('manifests')
      .insert({ origin_warehouse_id: newWh || null, created_by: u?.user?.id })
    if (error) setMsg({ t: 'err', m: error.message })
    else load()
  }

  return (
    <Shell>
      <div className="page-head">
        <div><h1>Manifests</h1>
          <div className="sub">Group binned shipments into lots, then assign a flight — AWB numbers are stamped automatically.</div></div>
      </div>
      {msg && <div className={`alert ${msg.t}`}>{msg.m}</div>}

      <div className="card" style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="field" style={{ marginBottom: 0, width: 280 }}>
          <span className="lbl">Origin warehouse</span>
          <select value={newWh} onChange={(e) => setNewWh(e.target.value)}>
            <option value="">Select…</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
        <button className="btn" onClick={createManifest}>+ Open new manifest</button>
      </div>

      {manifests.map((m) => {
        const items = shipsByManifest[m.id] ?? []
        return (
          <div className="card" key={m.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <div>
                <span className="mono" style={{ fontWeight: 600 }}>{m.code}</span>
                <span className="muted small"> · {m.warehouses?.name ?? 'No origin'} · {items.length} shipment{items.length === 1 ? '' : 's'}</span>
              </div>
              <span className="chip">{m.status}{m.flights ? ` · ${m.flights.flight_number}` : ''}</span>
            </div>

            {items.length > 0 && (
              <p className="small mono" style={{ marginTop: 8, color: 'var(--ink-2)' }}>
                {items.map((s) => s.tracking_id).join('  ·  ')}
              </p>
            )}

            {m.status === 'OPEN' && (
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <label className="field" style={{ marginBottom: 0, width: 240 }}>
                  <span className="lbl">Add shipment (must be BINNED)</span>
                  <input placeholder="SCL-…" value={addTid[m.id] ?? ''}
                    onChange={(e) => setAddTid({ ...addTid, [m.id]: e.target.value })} />
                </label>
                <button className="btn small" onClick={() =>
                  run('add_to_manifest', { p_tracking_id: addTid[m.id], p_manifest_id: m.id },
                    'Shipment added to manifest')}>Add</button>

                <label className="field" style={{ marginBottom: 0, width: 260 }}>
                  <span className="lbl">Assign flight (closes manifest)</span>
                  <select value={flightPick[m.id] ?? ''}
                    onChange={(e) => setFlightPick({ ...flightPick, [m.id]: e.target.value })}>
                    <option value="">Select flight…</option>
                    {flights.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.flight_number} · {f.origin_iata}→{f.destination_iata}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="btn small dark" disabled={!flightPick[m.id] || items.length === 0}
                  onClick={() => run('assign_flight',
                    { p_manifest_id: m.id, p_flight_id: flightPick[m.id] },
                    'Flight assigned — shipments moved to ASSIGNED_TO_FLIGHT')}>
                  Assign flight
                </button>
              </div>
            )}
            {m.status !== 'OPEN' && (
              <p className="small muted" style={{ marginTop: 8 }}>
                Loading is done at the scanner (EXIT scan per shipment). Departure and landing are driven from the Flights page.
              </p>
            )}
          </div>
        )
      })}
      {manifests.length === 0 && <div className="card"><p className="muted">No manifests yet — open one above.</p></div>}
    </Shell>
  )
}
