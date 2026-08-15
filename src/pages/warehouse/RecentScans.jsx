import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import Shell from '../../components/Shell'
import { fmt } from '../../lib/constants'

export default function RecentScans() {
  const [rows, setRows] = useState([])
  useEffect(() => {
    supabase.from('warehouse_scans')
      .select('*, shipments(tracking_id), warehouses(name), bins(code)')
      .order('scanned_at', { ascending: false }).limit(50)
      .then(({ data }) => setRows(data ?? []))
  }, [])
  return (
    <Shell>
      <div className="page-head"><div><h1>Recent scans</h1>
        <div className="sub">The last 50 scan events across all warehouses.</div></div></div>
      <div className="card">
        <table>
          <thead><tr><th>Shipment</th><th>Type</th><th>Warehouse</th><th>Bin</th><th>When</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.shipments?.tracking_id}</td>
                <td><span className="chip">{r.scan_type}</span></td>
                <td>{r.warehouses?.name}</td>
                <td className="mono">{r.bins?.code ?? '—'}</td>
                <td className="small">{fmt(r.scanned_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="muted" style={{ marginTop: 10 }}>No scans recorded yet.</p>}
      </div>
    </Shell>
  )
}
