import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import Shell from '../../components/Shell'
import StatusChip from '../../components/StatusChip'
import { fmt } from '../../lib/constants'

export default function MyShipments() {
  const { session } = useAuth()
  const [ships, setShips] = useState([])
  const [q, setQ] = useState('')

  const load = async () => {
    const { data } = await supabase
      .from('shipments').select('*').order('created_at', { ascending: false })
    setShips(data ?? [])
  }

  useEffect(() => {
    load()
    const ch = supabase.channel('my-ships')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'shipments' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [session?.user?.id])

  const filtered = ships.filter((s) =>
    !q || s.tracking_id.toLowerCase().includes(q.toLowerCase()) ||
    (s.receiver_name ?? '').toLowerCase().includes(q.toLowerCase()))

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>My shipments</h1>
          <div className="sub">Live status for every consignment on your account.</div>
        </div>
        <input style={{ width: 240 }} placeholder="Search tracking ID or receiver"
          value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {filtered.length === 0 && (
        <div className="card">
          <p className="muted">No shipments yet. Once our team books a consignment for you it appears here instantly.</p>
        </div>
      )}
      {filtered.map((s) => (
        <Link key={s.id} to={`/shipment/${s.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className={`strip ${s.status === 'DELIVERED' ? 'delivered' : s.exception_open ? 'exception' : ''}`}>
            <div className="grow">
              <div className="tid">{s.tracking_id}</div>
              <div className="meta">
                {s.receiver_name} · {s.destination_city ?? s.destination_address} · booked {fmt(s.created_at)}
              </div>
            </div>
            {s.is_cold_chain && <span className="chip cold">Cold</span>}
            <StatusChip status={s.status} />
          </div>
        </Link>
      ))}
    </Shell>
  )
}
