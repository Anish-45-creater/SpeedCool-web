import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { ROLE_HOME } from './lib/constants'
import { configured } from './lib/supabase'

import Landing from './pages/Landing'
import Track from './pages/Track'
import Login from './pages/Login'
import ResetPassword from './pages/ResetPassword'
import ShipmentDetail from './pages/ShipmentDetail'
import MyShipments from './pages/customer/MyShipments'
import Notifications from './pages/customer/Notifications'
import Board from './pages/ops/Board'
import NewShipment from './pages/ops/NewShipment'
import Manifests from './pages/ops/Manifests'
import Flights from './pages/ops/Flights'
import Reroute from './pages/ops/Reroute'
import Dispatch from './pages/ops/Dispatch'
import Exceptions from './pages/ops/Exceptions'
import Scanner from './pages/warehouse/Scanner'
import RecentScans from './pages/warehouse/RecentScans'
import DriverRoute from './pages/driver/Route'
import Deliver from './pages/driver/Deliver'
import Admin from './pages/admin/Admin'

function Protected({ roles, children }) {
  const { session, profile, loading } = useAuth()
  if (loading) {
    return <div className="auth-wrap"><p className="muted">Loading…</p></div>
  }
  if (!session) return <Navigate to="/login" replace />
  if (roles && profile && !roles.includes(profile.role)) {
    return <Navigate to={ROLE_HOME[profile.role] ?? '/my'} replace />
  }
  return children
}

export default function App() {
  if (!configured) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="card">
            <div className="auth-brand">SPEED<span>COOL</span></div>
            <div className="auth-sub">One-time setup needed</div>
            <div className="alert warn">
              Supabase keys are not configured, so the app can't reach the database yet.
            </div>
            <p className="small">
              Set these two environment variables and rebuild:
            </p>
            <p className="mono small" style={{ margin: '10px 0', lineHeight: 1.8 }}>
              VITE_SUPABASE_URL<br />VITE_SUPABASE_ANON_KEY
            </p>
            <p className="small muted">
              Locally: copy <span className="mono">.env.example</span> to <span className="mono">.env</span>.
              On Render: add them under Environment, then "Clear build cache &amp; deploy".
              Values are in Supabase → Project Settings → API. Full steps are in the README.
            </p>
          </div>
        </div>
      </div>
    )
  }
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          {/* Public */}
          <Route path="/" element={<Landing />} />
          <Route path="/track/:trackingId" element={<Track />} />
          <Route path="/login" element={<Login />} />
          <Route path="/reset" element={<ResetPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />

          {/* Shared (any signed-in role that RLS permits) */}
          <Route path="/shipment/:id" element={<Protected><ShipmentDetail /></Protected>} />

          {/* Customer */}
          <Route path="/my" element={<Protected roles={['customer', 'admin']}><MyShipments /></Protected>} />
          <Route path="/my/notifications" element={<Protected roles={['customer', 'admin']}><Notifications /></Protected>} />

          {/* Ops */}
          <Route path="/ops" element={<Protected roles={['ops', 'admin']}><Board /></Protected>} />
          <Route path="/ops/new" element={<Protected roles={['ops', 'admin']}><NewShipment /></Protected>} />
          <Route path="/ops/manifests" element={<Protected roles={['ops', 'admin']}><Manifests /></Protected>} />
          <Route path="/ops/flights" element={<Protected roles={['ops', 'admin']}><Flights /></Protected>} />
          <Route path="/ops/reroute" element={<Protected roles={['ops', 'admin']}><Reroute /></Protected>} />
          <Route path="/ops/dispatch" element={<Protected roles={['ops', 'admin']}><Dispatch /></Protected>} />
          <Route path="/ops/exceptions" element={<Protected roles={['ops', 'admin']}><Exceptions /></Protected>} />

          {/* Warehouse */}
          <Route path="/warehouse" element={<Protected roles={['warehouse', 'ops', 'admin']}><Scanner /></Protected>} />
          <Route path="/warehouse/recent" element={<Protected roles={['warehouse', 'ops', 'admin']}><RecentScans /></Protected>} />

          {/* Driver */}
          <Route path="/driver" element={<Protected roles={['driver', 'admin']}><DriverRoute /></Protected>} />
          <Route path="/driver/deliver/:id" element={<Protected roles={['driver', 'admin']}><Deliver /></Protected>} />

          {/* Admin */}
          <Route path="/admin" element={<Protected roles={['admin']}><Admin /></Protected>} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
