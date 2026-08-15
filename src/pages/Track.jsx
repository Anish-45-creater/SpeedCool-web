import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import Stepper from '../components/Stepper'
import Timeline from '../components/Timeline'
import StatusChip from '../components/StatusChip'
import { fmt } from '../lib/constants'

export default function Track() {
  const { trackingId } = useParams()
  const [data, setData] = useState(null)
  const [notFound, setNotFound] = useState(false)

  const load = async () => {
    const { data: res, error } = await supabase.rpc('public_track', { p_tracking_id: trackingId })
    if (error || !res) { setNotFound(true); return }
    setData(res)
    setNotFound(false)
  }

  useEffect(() => {
    load()
    const t = setInterval(load, 12000) // live refresh for anonymous visitors
    return () => clearInterval(t)
  }, [trackingId])

  return (
    <div className="auth-wrap" style={{ alignItems: 'flex-start', paddingTop: 50 }}>
      <div style={{ width: 680, maxWidth: '100%' }}>
        <Link to="/" className="brand" style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 22 }}>
          SPEED<span style={{ color: 'var(--glacier)' }}>COOL</span>
        </Link>
        <div className="card" style={{ marginTop: 16 }}>
          {notFound && (
            <div className="alert err">
              No shipment found for <span className="mono">{trackingId}</span>. Check the ID and try again.
            </div>
          )}
          {data && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
                <div>
                  <div className="mono" style={{ fontSize: 17, fontWeight: 600 }}>{data.tracking_id}</div>
                  <div className="muted small">
                    Booked {fmt(data.created_at)}
                    {data.destination_city ? ` · to ${data.destination_city}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  {data.is_cold_chain && <span className="chip cold">Cold chain</span>}
                  <StatusChip status={data.status} />
                </div>
              </div>
              {data.exception_open && (
                <div className="alert warn" style={{ marginTop: 14 }}>
                  This shipment has an active exception. Our operations team is on it —
                  the timeline below has the latest note.
                </div>
              )}
              <Stepper status={data.status} />
              {data.eta && (
                <p className="small muted" style={{ textAlign: 'center', marginTop: 6 }}>
                  Estimated arrival {fmt(data.eta)}
                </p>
              )}
              <h3 style={{ marginTop: 22, marginBottom: 4 }}>Journey</h3>
              <Timeline events={data.events} />
              <p className="small muted" style={{ marginTop: 14 }}>
                This page refreshes automatically. Updates land within seconds of a scan,
                a flight milestone, or delivery.
              </p>
            </>
          )}
          {!data && !notFound && <p className="muted">Loading shipment…</p>}
        </div>
      </div>
    </div>
  )
}
