import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import Shell from '../../components/Shell'
import { fmt } from '../../lib/constants'

export default function RerouteActivity() {
  const [rows, setRows] = useState([])
  const [pendingExceptions, setPendingExceptions] = useState([])

  const load = async () => {
    const { data } = await supabase
      .from('flight_reroute_audit')
      .select('*, shipments(tracking_id), original:flights!flight_reroute_audit_original_flight_id_fkey(flight_number,origin_iata,destination_iata), new:flights!flight_reroute_audit_new_flight_id_fkey(flight_number)')
      .order('created_at', { ascending: false })
      .limit(50)
    setRows(data ?? [])

    const { data: pend } = await supabase
      .from('shipments')
      .select('id, tracking_id, status, exception_open')
      .eq('status', 'EXCEPTION')
    setPendingExceptions(pend ?? [])
  }

  useEffect(() => {
    load()
    const ch = supabase.channel('reroute-activity')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'flight_reroute_audit' }, load)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'shipments' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [])

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Re-routing Activity</h1>
          <div className="sub">
            A live audit trail of the automatic re-routing engine — every time a delayed or cancelled flight moved
            cargo to another flight, or found no alternative available. This is read-only: nobody picks the
            replacement flight by hand, the database engine does.
          </div>
        </div>
      </div>

      {pendingExceptions.length > 0 && (
        <div className="alert warn">
          {pendingExceptions.length} shipment{pendingExceptions.length > 1 ? 's are' : ' is'} still waiting for an
          alternative flight after a cancellation. The engine automatically re-checks whenever Admin adds a new
          flight or a flight's schedule changes — no action needed here.
        </div>
      )}

      {rows.length === 0 && (
        <div className="card"><p className="muted">No re-routing activity yet — nothing has been delayed or cancelled.</p></div>
      )}

      {rows.map((r) => (
        <div className="card" key={r.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <div>
              <Link to={`/shipment/${r.shipment_id}`} className="mono" style={{ fontWeight: 700 }}>
                {r.shipments?.tracking_id}
              </Link>
              <div className="muted small" style={{ marginTop: 2 }}>
                {r.reroute_type === 'AUTOMATIC_CANCELLATION' ? 'Flight cancelled' : 'Flight delayed'}
                {r.original ? ` — ${r.original.flight_number} (${r.original.origin_iata}→${r.original.destination_iata})` : ''}
              </div>
            </div>
            <span className={`chip ${r.alternative_found ? 'delivered' : 'exception'}`}>
              {r.alternative_found ? 'Auto re-routed' : 'No alternative found'}
            </span>
          </div>

          <div className="reroute-flow" style={{ marginTop: 10 }}>
            <span className="step">{r.reroute_type === 'AUTOMATIC_CANCELLATION' ? '✕ Cancelled' : '⚠ Delayed'}</span>
            <span className="arrow">→</span>
            <span className="step">🔍 Searched same-route flights</span>
            <span className="arrow">→</span>
            {r.alternative_found ? (
              <span className="step">✓ Re-routed to {r.new?.flight_number}</span>
            ) : (
              <span className="step">⚠ None available</span>
            )}
          </div>

          {r.reroute_reason && <p className="small muted" style={{ marginTop: 8 }}>Reason: {r.reroute_reason}</p>}
          <p className="small muted" style={{ marginTop: 4 }}>{fmt(r.created_at)}</p>
        </div>
      ))}
    </Shell>
  )
}
