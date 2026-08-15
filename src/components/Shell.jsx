import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

const NAV = {
  admin: [
    ['/ops', 'Live board'], ['/ops/new', 'New shipment'], ['/ops/manifests', 'Manifests'],
    ['/ops/flights', 'Flights'], ['/ops/reroute', 'Reroute'], ['/ops/dispatch', 'Dispatch'], ['/ops/exceptions', 'Exceptions'],
    ['/warehouse', 'Scanner'], ['/admin', 'Admin'],
  ],
  ops: [
    ['/ops', 'Live board'], ['/ops/new', 'New shipment'], ['/ops/manifests', 'Manifests'],
    ['/ops/flights', 'Flights'], ['/ops/reroute', 'Reroute'], ['/ops/dispatch', 'Dispatch'], ['/ops/exceptions', 'Exceptions'],
  ],
  warehouse: [['/warehouse', 'Scanner'], ['/warehouse/recent', 'Recent scans']],
  driver: [['/driver', 'My route']],
  customer: [['/my', 'My shipments'], ['/my/notifications', 'Notifications']],
}

export default function Shell({ children }) {
  const { profile, signOut } = useAuth()
  const navigate = useNavigate()
  const links = NAV[profile?.role] ?? []
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">SPEED<span>COOL</span></div>
        <div className="role-tag">{profile?.role ?? ''} console</div>
        <nav>
          {links.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/ops' || to === '/my' || to === '/warehouse' || to === '/driver' || to === '/admin'}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="foot">
          <div className="who">{profile?.full_name || 'Signed in'}</div>
          <button onClick={async () => { await signOut(); navigate('/') }}>Sign out</button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  )
}
