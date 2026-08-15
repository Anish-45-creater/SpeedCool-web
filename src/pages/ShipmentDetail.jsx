import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { QRCodeSVG } from 'qrcode.react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import Shell from '../components/Shell'
import Stepper from '../components/Stepper'
import Timeline from '../components/Timeline'
import StatusChip from '../components/StatusChip'
import { STATUS_LABELS, nextStatus, fmt } from '../lib/constants'

export default function ShipmentDetail() {
  const { id } = useParams()
  const { profile } = useAuth()
  const isStaff = ['admin', 'ops'].includes(profile?.role)
  const [ship, setShip] = useState(null)
  const [events, setEvents] = useState([])
  const [pod, setPod] = useState(null)
  const [podUrl, setPodUrl] = useState(null)
  const [msg, setMsg] = useState(null)
  const [note, setNote] = useState('')

  const load = async () => {
    const { data: s } = await supabase.from('shipments').select('*').eq('id', id).single()
    setShip(s ?? null)
    const { data: ev } = await supabase
      .from('shipment_events').select('*').eq('shipment_id', id).order('created_at')
    setEvents(ev ?? [])
    const { data: p } = await supabase
      .from('proof_of_delivery').select('*').eq('shipment_id', id).maybeSingle()
    setPod(p ?? null)
    if (p?.signature_path) {
      const { data: signed } = await supabase.storage.from('pods')
        .createSignedUrl(p.signature_path, 3600)
      setPodUrl(signed?.signedUrl ?? null)
    }
  }

  useEffect(() => {
    load()
    const ch = supabase
      .channel(`ship-${id}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'shipment_events', filter: `shipment_id=eq.${id}` },
        () => load())
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [id])

  const advance = async (to) => {
    setMsg(null)
    const { error } = await supabase.rpc('advance_shipment', {
      p_shipment_id: id, p_new_status: to, p_note: note || null,
    })
    if (error) setMsg({ t: 'err', m: error.message })
    else { setNote(''); setMsg({ t: 'ok', m: `Moved to ${STATUS_LABELS[to]}` }) }
  }

  const raiseException = async () => {
    if (!note.trim()) { setMsg({ t: 'err', m: 'Add a note describing the exception first.' }); return }
    await advance('EXCEPTION')
  }

  if (!ship) return <Shell><p className="muted">Loading…</p></Shell>
  const nxt = nextStatus(ship.status)

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1 className="mono">{ship.tracking_id}</h1>
          <div className="sub">
            {ship.awb_number ? <>AWB <span className="mono">{ship.awb_number}</span> · </> : null}
            Booked {fmt(ship.created_at)} · {ship.pieces} pc · {ship.weight_kg ?? '—'} kg
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {ship.is_cold_chain && <span className="chip cold">Cold chain</span>}
          <StatusChip status={ship.status} />
        </div>
      </div>

      <div className="card">
        <Stepper status={ship.status} />
      </div>

      <div className="grid cols-2" style={{ marginTop: 14, alignItems: 'start' }}>
        <div>
          <div className="card">
            <h3>Consignment</h3>
            <table style={{ marginTop: 8 }}>
              <tbody>
                <tr><td className="muted small">Receiver</td><td>{ship.receiver_name} · <span className="mono small">{ship.receiver_phone}</span></td></tr>
                <tr><td className="muted small">Destination</td><td>{ship.destination_address}{ship.destination_city ? `, ${ship.destination_city}` : ''}</td></tr>
                <tr><td className="muted small">Contents</td><td>{ship.description ?? '—'}</td></tr>
                <tr><td className="muted small">Declared value</td><td>{ship.declared_value ? `₹${Number(ship.declared_value).toLocaleString('en-IN')}` : '—'}</td></tr>
              </tbody>
            </table>
          </div>

          {isStaff && (
            <div className="card">
              <h3>Operations</h3>
              {msg && <div className={`alert ${msg.t}`} style={{ marginTop: 10 }}>{msg.m}</div>}
              <label className="field" style={{ marginTop: 10 }}>
                <span className="lbl">Note (shown on the customer timeline)</span>
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Customs docs verified" />
              </label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {nxt && nxt !== 'DELIVERED' && ship.status !== 'EXCEPTION' && (
                  <button className="btn" onClick={() => advance(nxt)}>
                    Advance to {STATUS_LABELS[nxt]}
                  </button>
                )}
                {nxt === 'DELIVERED' && profile?.role !== 'admin' && (
                  <span className="small muted">Delivery is completed by the driver with a signed PoD.</span>
                )}
                {nxt === 'DELIVERED' && profile?.role === 'admin' && (
                  <button className="btn" onClick={() => advance('DELIVERED')}>
                    Force delivered (admin)
                  </button>
                )}
                {ship.status === 'EXCEPTION' && (
                  <span className="small muted">Resolve from the Exceptions page.</span>
                )}
                {ship.status !== 'EXCEPTION' && ship.status !== 'DELIVERED' && (
                  <button className="btn warn" onClick={raiseException}>Raise exception</button>
                )}
              </div>
            </div>
          )}

          {pod && (
            <div className="card">
              <h3>Proof of delivery</h3>
              <p className="small" style={{ marginTop: 6 }}>
                Signed by <strong>{pod.signed_by}</strong> · {fmt(pod.delivered_at)}
              </p>
              {podUrl && (
                <img src={podUrl} alt="Delivery signature" style={{ maxWidth: 280, border: '1px solid var(--line)', borderRadius: 6, marginTop: 8, background: '#fff' }} />
              )}
            </div>
          )}

          <div className="card print-area">
            <h3>Shipping label</h3>
            <div className="label-card" style={{ marginTop: 10 }}>
              <div className="lc-head"><span>SPEEDCOOL</span><span>{ship.is_cold_chain ? '❄ COLD' : 'AIR'}</span></div>
              <div className="lc-tid">{ship.tracking_id}</div>
              <QRCodeSVG value={ship.tracking_id} size={132} />
              <div className="lc-row"><strong>To:</strong> {ship.receiver_name}</div>
              <div className="lc-row">{ship.destination_address}{ship.destination_city ? `, ${ship.destination_city}` : ''}</div>
              <div className="lc-row mono small">{ship.awb_number ?? 'AWB pending'} · {ship.pieces} pc · {ship.weight_kg ?? '—'} kg</div>
            </div>
            <button className="btn ghost small" style={{ marginTop: 12 }} onClick={() => window.print()}>
              Print label
            </button>
          </div>
        </div>

        <div className="card">
          <h3>Live timeline</h3>
          <Timeline events={events} />
        </div>
      </div>
    </Shell>
  )
}
