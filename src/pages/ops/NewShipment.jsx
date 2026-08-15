import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import Shell from '../../components/Shell'

export default function NewShipment() {
  const [customers, setCustomers] = useState([])
  const [warehouses, setWarehouses] = useState([])
  const [form, setForm] = useState({
    customer_id: '', origin_warehouse_id: '', receiver_name: '', receiver_phone: '',
    destination_address: '', destination_city: '', description: '',
    weight_kg: '', pieces: 1, declared_value: '', is_cold_chain: false,
  })
  const [msg, setMsg] = useState(null)
  const navigate = useNavigate()
  const set = (k) => (e) =>
    setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })

  useEffect(() => {
    supabase.from('profiles').select('id, full_name, phone').eq('role', 'customer')
      .then(({ data }) => setCustomers(data ?? []))
    supabase.from('warehouses').select('*').then(({ data }) => setWarehouses(data ?? []))
  }, [])

  const submit = async (e) => {
    e.preventDefault()
    setMsg(null)
    const payload = {
      ...form,
      weight_kg: form.weight_kg === '' ? null : Number(form.weight_kg),
      declared_value: form.declared_value === '' ? null : Number(form.declared_value),
      pieces: Number(form.pieces) || 1,
      origin_warehouse_id: form.origin_warehouse_id || null,
    }
    const { data, error } = await supabase.from('shipments').insert(payload).select('id, tracking_id').single()
    if (error) { setMsg({ t: 'err', m: error.message }); return }
    navigate(`/shipment/${data.id}`) // DB trigger logs the BOOKED event + customer notification
  }

  return (
    <Shell>
      <div className="page-head">
        <div><h1>New shipment</h1>
          <div className="sub">Books the order, generates the tracking ID and the printable QR label.</div></div>
      </div>
      <div className="card" style={{ maxWidth: 640 }}>
        {msg && <div className={`alert ${msg.t}`}>{msg.m}</div>}
        <form onSubmit={submit}>
          <div className="grid cols-2">
            <label className="field"><span className="lbl">Customer account</span>
              <select required value={form.customer_id} onChange={set('customer_id')}>
                <option value="">Select customer…</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.full_name || c.id.slice(0, 8)}</option>)}
              </select>
            </label>
            <label className="field"><span className="lbl">Origin warehouse</span>
              <select value={form.origin_warehouse_id} onChange={set('origin_warehouse_id')}>
                <option value="">Select…</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
            <label className="field"><span className="lbl">Receiver name</span>
              <input required value={form.receiver_name} onChange={set('receiver_name')} />
            </label>
            <label className="field"><span className="lbl">Receiver phone</span>
              <input required value={form.receiver_phone} onChange={set('receiver_phone')} placeholder="+91…" />
            </label>
          </div>
          <label className="field"><span className="lbl">Destination address</span>
            <input required value={form.destination_address} onChange={set('destination_address')} />
          </label>
          <div className="grid cols-2">
            <label className="field"><span className="lbl">Destination city</span>
              <input value={form.destination_city} onChange={set('destination_city')} />
            </label>
            <label className="field"><span className="lbl">Contents</span>
              <input value={form.description} onChange={set('description')} placeholder="e.g. Vaccines, 4 boxes" />
            </label>
            <label className="field"><span className="lbl">Weight (kg)</span>
              <input type="number" step="0.1" value={form.weight_kg} onChange={set('weight_kg')} />
            </label>
            <label className="field"><span className="lbl">Pieces</span>
              <input type="number" min="1" value={form.pieces} onChange={set('pieces')} />
            </label>
            <label className="field"><span className="lbl">Declared value (₹)</span>
              <input type="number" value={form.declared_value} onChange={set('declared_value')} />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={form.is_cold_chain} onChange={set('is_cold_chain')} />
            Cold-chain shipment (temperature controlled)
          </label>
          <button className="btn">Book shipment</button>
        </form>
        <p className="small muted" style={{ marginTop: 12 }}>
          The customer must have an account first (they sign up on the login page).
        </p>
      </div>
    </Shell>
  )
}
