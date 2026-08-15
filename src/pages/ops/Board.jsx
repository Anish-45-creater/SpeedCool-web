import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import Shell from '../../components/Shell'
import StatusChip from '../../components/StatusChip'
import { STAGES } from '../../lib/constants'

export default function Board() {
  const [ships, setShips] = useState([])

  const load = async () => {
    const { data } = await supabase.from('shipments')
      .select('*').neq('status', 'DELIVERED').order('updated_at', { ascending: false })
    setShips(data ?? [])
  }

  useEffect(() => {
    load()
    const ch = supabase.channel('board')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shipments' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [])

  const exceptions = ships.filter((s) => s.status === 'EXCEPTION')
  const inCols = STAGES.map((st) => ({
    name: st.name,
    items: ships.filter((s) => st.statuses.includes(s.status)),
  }))


  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Live board</h1>
          <div className="sub">Every active consignment, updated over WebSockets as scans and milestones land.</div>
        </div>
        <Link to="/ops/new" className="btn">+ New shipment</Link>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 18 }}>
        <div className="card kpi cool"><div className="n">{ships.length}</div><div className="l">Active shipments</div></div>
        <div className="card kpi"><div className="n">{inCols[2].items.length}</div><div className="l">In air transit</div></div>
        <div className="card kpi ok"><div className="n">{inCols[3].items.length}</div><div className="l">Out for delivery</div></div>
        <div className="card kpi warn"><div className="n">{exceptions.length}</div><div className="l">Open exceptions</div></div>
      </div>

      {exceptions.length > 0 && (
        <div className="alert warn">
          {exceptions.length} shipment{exceptions.length > 1 ? 's' : ''} need attention —{' '}
          <Link to="/ops/exceptions">open the exception queue</Link>.
        </div>
      )}

      <div className="board">
        {inCols.map((col) => (
          <div key={col.name}>
            <div className="col-head"><span>{col.name}</span><span>{col.items.length}</span></div>
            {col.items.map((s) => (
              <Link key={s.id} to={`/shipment/${s.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                <div className="strip">
                  <div className="grow">
                    <div className="tid" style={{ fontSize: 12.5 }}>{s.tracking_id}</div>
                    <div className="meta">{s.destination_city ?? '—'}{s.is_cold_chain ? ' · ❄' : ''}</div>
                  </div>
                  <StatusChip status={s.status} />
                </div>
              </Link>
            ))}
            {col.items.length === 0 && <p className="small muted">Empty</p>}
          </div>
        ))}
      </div>
    </Shell>
  )
}
