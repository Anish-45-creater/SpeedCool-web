import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import Shell from '../../components/Shell'

const ROLES = ['customer', 'ops', 'warehouse', 'driver', 'admin']

export default function Admin() {
  const [tab, setTab] = useState('team')
  const [profiles, setProfiles] = useState([])
  const [warehouses, setWarehouses] = useState([])
  const [bins, setBins] = useState([])
  const [vehicles, setVehicles] = useState([])
  const [msg, setMsg] = useState(null)
  const [newWh, setNewWh] = useState({ name: '', city: '', iata: '' })
  const [newBin, setNewBin] = useState({ warehouse_id: '', code: '' })
  const [newVeh, setNewVeh] = useState({ plate_number: '', label: '' })

  const load = async () => {
    const [{ data: p }, { data: w }, { data: b }, { data: v }] = await Promise.all([
      supabase.from('profiles').select('*').order('created_at'),
      supabase.from('warehouses').select('*').order('name'),
      supabase.from('bins').select('*, warehouses(name)').order('code'),
      supabase.from('vehicles').select('*').order('plate_number'),
    ])
    setProfiles(p ?? []); setWarehouses(w ?? []); setBins(b ?? []); setVehicles(v ?? [])
  }
  useEffect(() => { load() }, [])

  const setRole = async (id, role) => {
    setMsg(null)
    const { error } = await supabase.from('profiles').update({ role }).eq('id', id)
    if (error) setMsg({ t: 'err', m: error.message })
    else { setMsg({ t: 'ok', m: 'Role updated' }); load() }
  }
  const addWarehouse = async () => {
    const { error } = await supabase.from('warehouses').insert({ ...newWh, iata: newWh.iata.toUpperCase() })
    if (error) setMsg({ t: 'err', m: error.message })
    else { setNewWh({ name: '', city: '', iata: '' }); load() }
  }
  const addBin = async () => {
    const { error } = await supabase.from('bins')
      .insert({ warehouse_id: newBin.warehouse_id, code: newBin.code.toUpperCase() })
    if (error) setMsg({ t: 'err', m: error.message })
    else { setNewBin({ ...newBin, code: '' }); load() }
  }
  const addVehicle = async () => {
    const { error } = await supabase.from('vehicles').insert(newVeh)
    if (error) setMsg({ t: 'err', m: error.message })
    else { setNewVeh({ plate_number: '', label: '' }); load() }
  }
  const setDriver = async (vehId, driverId) => {
    const { error } = await supabase.from('vehicles')
      .update({ driver_id: driverId || null }).eq('id', vehId)
    if (error) setMsg({ t: 'err', m: error.message })
    else load()
  }

  const drivers = profiles.filter((p) => p.role === 'driver')

  return (
    <Shell>
      <div className="page-head">
        <div><h1>Admin</h1><div className="sub">Team roles, facilities and fleet.</div></div>
      </div>
      <div className="scan-modes" style={{ maxWidth: 480 }}>
        {[['team', 'Team'], ['facilities', 'Warehouses'], ['fleet', 'Fleet']].map(([t, l]) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{l}</button>
        ))}
      </div>
      {msg && <div className={`alert ${msg.t}`}>{msg.m}</div>}

      {tab === 'team' && (
        <div className="card">
          <table>
            <thead><tr><th>Name</th><th>Phone</th><th>Role</th></tr></thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.id}>
                  <td>{p.full_name || <span className="muted">—</span>}</td>
                  <td className="mono small">{p.phone ?? '—'}</td>
                  <td style={{ width: 160 }}>
                    <select value={p.role} onChange={(e) => setRole(p.id, e.target.value)}>
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted" style={{ marginTop: 10 }}>
            New sign-ups start as customers. Promote your ops, warehouse and driver staff here — ask them to sign out and back in after a role change.
          </p>
        </div>
      )}

      {tab === 'facilities' && (
        <>
          <div className="card">
            <h3>Warehouses</h3>
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <input style={{ width: 220 }} placeholder="Name" value={newWh.name}
                onChange={(e) => setNewWh({ ...newWh, name: e.target.value })} />
              <input style={{ width: 140 }} placeholder="City" value={newWh.city}
                onChange={(e) => setNewWh({ ...newWh, city: e.target.value })} />
              <input style={{ width: 90 }} placeholder="IATA" maxLength={3} value={newWh.iata}
                onChange={(e) => setNewWh({ ...newWh, iata: e.target.value })} />
              <button className="btn small" onClick={addWarehouse}>Add</button>
            </div>
            <table style={{ marginTop: 12 }}>
              <thead><tr><th>Name</th><th>City</th><th>IATA</th></tr></thead>
              <tbody>
                {warehouses.map((w) => (
                  <tr key={w.id}><td>{w.name}</td><td>{w.city}</td><td className="mono">{w.iata}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card">
            <h3>Bins</h3>
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <select style={{ width: 240 }} value={newBin.warehouse_id}
                onChange={(e) => setNewBin({ ...newBin, warehouse_id: e.target.value })}>
                <option value="">Warehouse…</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
              <input style={{ width: 140 }} placeholder="Code e.g. C-01" value={newBin.code}
                onChange={(e) => setNewBin({ ...newBin, code: e.target.value })} />
              <button className="btn small" onClick={addBin} disabled={!newBin.warehouse_id || !newBin.code}>Add</button>
            </div>
            <table style={{ marginTop: 12 }}>
              <thead><tr><th>Code</th><th>Warehouse</th></tr></thead>
              <tbody>
                {bins.map((b) => (
                  <tr key={b.id}><td className="mono">{b.code}</td><td>{b.warehouses?.name}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'fleet' && (
        <div className="card">
          <h3>Vehicles</h3>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <input style={{ width: 180 }} placeholder="Plate number" value={newVeh.plate_number}
              onChange={(e) => setNewVeh({ ...newVeh, plate_number: e.target.value })} />
            <input style={{ width: 180 }} placeholder="Label" value={newVeh.label}
              onChange={(e) => setNewVeh({ ...newVeh, label: e.target.value })} />
            <button className="btn small" onClick={addVehicle} disabled={!newVeh.plate_number}>Add</button>
          </div>
          <table style={{ marginTop: 12 }}>
            <thead><tr><th>Plate</th><th>Label</th><th>Driver</th></tr></thead>
            <tbody>
              {vehicles.map((v) => (
                <tr key={v.id}>
                  <td className="mono">{v.plate_number}</td>
                  <td>{v.label}</td>
                  <td style={{ width: 220 }}>
                    <select value={v.driver_id ?? ''} onChange={(e) => setDriver(v.id, e.target.value)}>
                      <option value="">No driver</option>
                      {drivers.map((d) => <option key={d.id} value={d.id}>{d.full_name || d.id.slice(0, 8)}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted" style={{ marginTop: 10 }}>
            A vehicle needs a driver before Dispatch can assign shipments to it.
            Promote drivers on the Team tab first.
          </p>
        </div>
      )}
    </Shell>
  )
}
