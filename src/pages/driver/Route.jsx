import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import Shell from '../../components/Shell'
import { fmt } from '../../lib/constants'

export default function DriverRoute() {
  const { session } = useAuth()
  const [stops, setStops] = useState([])
  const [done, setDone] = useState([])

  const load = async () => {
    const { data } = await supabase.from('delivery_assignments')
      .select('*, shipments(id, tracking_id, receiver_name, receiver_phone, destination_address, destination_city, status, is_cold_chain)')
      .order('sequence')
    const all = data ?? []
    setStops(all.filter((a) => !a.completed_at))
    setDone(all.filter((a) => a.completed_at))
  }
  useEffect(() => {
    load()
    const ch = supabase.channel('driver-route')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'delivery_assignments' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [session?.user?.id])

  return (
    <Shell>
      <div className="page-head">
        <div><h1>My route</h1>
          <div className="sub">{stops.length} stop{stops.length === 1 ? '' : 's'} remaining today.</div></div>
      </div>
      {stops.map((a, i) => (
        <div className="strip" key={a.id}>
          <div className="grow">
            <div className="tid">#{i + 1} · {a.shipments?.tracking_id}{a.shipments?.is_cold_chain ? ' ❄' : ''}</div>
            <div className="meta">
              {a.shipments?.receiver_name} · {a.shipments?.destination_address}
              {a.shipments?.destination_city ? `, ${a.shipments.destination_city}` : ''}
            </div>
            <div className="meta mono">{a.shipments?.receiver_phone}</div>
          </div>
          <a className="btn ghost small" target="_blank" rel="noreferrer"
            href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
              `${a.shipments?.destination_address ?? ''} ${a.shipments?.destination_city ?? ''}`)}`}>
            Navigate
          </a>
          <Link className="btn small" to={`/driver/deliver/${a.shipments?.id}`}>Deliver</Link>
        </div>
      ))}
      {stops.length === 0 && (
        <div className="card"><p className="muted">No pending stops. Dispatched shipments appear here automatically.</p></div>
      )}
      {done.length > 0 && (
        <>
          <h3 style={{ margin: '22px 0 8px' }}>Completed today</h3>
          {done.map((a) => (
            <div className="strip delivered" key={a.id}>
              <div className="grow">
                <div className="tid">{a.shipments?.tracking_id}</div>
                <div className="meta">Delivered {fmt(a.completed_at)}</div>
              </div>
              <span className="chip delivered">Delivered</span>
            </div>
          ))}
        </>
      )}
    </Shell>
  )
}
