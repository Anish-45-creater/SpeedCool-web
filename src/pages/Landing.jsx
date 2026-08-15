import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

export default function Landing() {
  const [tid, setTid] = useState('')
  const navigate = useNavigate()
  const go = (e) => {
    e.preventDefault()
    if (tid.trim()) navigate(`/track/${tid.trim().toUpperCase()}`)
  }
  return (
    <div className="landing">
      <header>
        <div className="brand">SPEED<span>COOL</span></div>
        <Link to="/login" className="btn ghost" style={{ color: '#cfdbe2', borderColor: '#46606f' }}>
          Sign in
        </Link>
      </header>
      <div className="hero">
        <div className="eyebrow">Air cargo · cold chain · door to door</div>
        <h1>Every shipment, visible from booking to signature.</h1>
        <p className="lead">
          Real-time tracking across warehouse, flight, customs and last-mile
          delivery — with proactive alerts the moment anything changes.
        </p>
        <form className="track-box" onSubmit={go}>
          <input
            value={tid}
            onChange={(e) => setTid(e.target.value)}
            placeholder="SCL-XXXXXXXXXX"
            aria-label="Tracking ID"
          />
          <button className="btn" type="submit">Track shipment</button>
        </form>
        <div className="stages">
          <div><div className="k">01 BOOKED</div><div className="v">Order accepted, QR label issued</div></div>
          <div><div className="k">02 WAREHOUSE</div><div className="v">Scanned to shelf level</div></div>
          <div><div className="k">03 IN FLIGHT</div><div className="v">Live flight milestones</div></div>
          <div><div className="k">04 DELIVERED</div><div className="v">Signed proof of delivery</div></div>
        </div>
      </div>
    </div>
  )
}
