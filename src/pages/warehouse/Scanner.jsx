import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import Shell from '../../components/Shell'

const MODES = [
  ['ENTRY', 'Entry — cargo arrives'],
  ['BIN', 'Bin — place on shelf'],
  ['EXIT', 'Load — onto flight'],
]

// Extracts just the SCL-XXXXXXXXXX part from whatever the QR contains.
// Handles: plain ID, full URL, URL with extra path segments.
function extractTrackingId(raw) {
  const cleaned = raw.trim().toUpperCase()
  // Already just a tracking ID
  if (/^SCL-[A-Z0-9]{6,12}$/.test(cleaned)) return cleaned
  // URL containing /track/SCL-... or ?id=SCL-...
  const match = cleaned.match(/SCL-[A-Z0-9]{6,12}/)
  if (match) return match[0]
  // Fallback — return as-is and let the server reject it with a clear message
  return cleaned
}

export default function Scanner() {
  const [mode, setMode] = useState('ENTRY')
  const [warehouses, setWarehouses] = useState([])
  const [bins, setBins] = useState([])
  const [warehouseId, setWarehouseId] = useState('')
  const [binCode, setBinCode] = useState('')
  const [manual, setManual] = useState('')
  const [result, setResult] = useState(null)
  const [cameraOn, setCameraOn] = useState(false)
  const [lastScanned, setLastScanned] = useState(null)
  const scannerRef = useRef(null)
  const busyRef = useRef(false)

  useEffect(() => {
    supabase.from('warehouses').select('*').then(({ data }) => {
      setWarehouses(data ?? [])
      if (data?.length) setWarehouseId(data[0].id)
    })
  }, [])

  useEffect(() => {
    if (!warehouseId) return
    supabase.from('bins').select('*').eq('warehouse_id', warehouseId).order('code')
      .then(({ data }) => setBins(data ?? []))
  }, [warehouseId])

  const submitScan = async (raw) => {
    if (busyRef.current) return

    // Validate warehouse selected
    if (!warehouseId) {
      setResult({ ok: false, text: '✕ Please select a warehouse first.' })
      return
    }
    // Validate bin selected for BIN mode
    if (mode === 'BIN' && !binCode) {
      setResult({ ok: false, text: '✕ Please select a bin/shelf location first.' })
      return
    }

    const trackingId = extractTrackingId(raw)
    if (!trackingId.startsWith('SCL-')) {
      setResult({ ok: false, text: `✕ Not a valid Speedcool QR code. Got: ${trackingId}` })
      return
    }

    busyRef.current = true
    setLastScanned(trackingId)
    setResult({ ok: null, text: `⏳ Processing ${trackingId}…` })

    const { data, error } = await supabase.rpc('record_scan', {
      p_tracking_id: trackingId,
      p_scan_type: mode,
      p_warehouse_id: warehouseId,
      p_bin_code: mode === 'BIN' ? binCode : null,
    })

    if (error) {
      setResult({ ok: false, text: `✕ ${error.message}` })
    } else {
      const newStatus = String(data.new_status).replaceAll('_', ' ')
      setResult({
        ok: true,
        text: `✓ ${data.tracking_id}\n→ Status: ${newStatus}`,
      })
    }

    // Allow next scan after 1.5 seconds (debounce)
    setTimeout(() => { busyRef.current = false }, 1500)
  }

  const startCamera = async () => {
    setResult(null)
    const { Html5Qrcode } = await import('html5-qrcode')
    setCameraOn(true)
    const scanner = new Html5Qrcode('qr-region')
    scannerRef.current = scanner
    try {
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 6, qrbox: { width: 250, height: 250 } },
        (text) => submitScan(text),
        () => {},
      )
    } catch (e) {
      setResult({
        ok: false,
        text: `✕ Camera unavailable: ${e?.message ?? e}. Use manual entry below.`,
      })
      setCameraOn(false)
    }
  }

  const stopCamera = async () => {
    try { await scannerRef.current?.stop(); await scannerRef.current?.clear() } catch {}
    setCameraOn(false)
  }

  useEffect(() => () => { scannerRef.current?.stop?.().catch(() => {}) }, [])

  const manualSubmit = (e) => {
    e.preventDefault()
    if (manual.trim()) { submitScan(manual.trim()); setManual('') }
  }

  const modeColors = { ENTRY: '#0e93b0', BIN: '#177e56', EXIT: '#c97a10' }
  const modeDesc = {
    ENTRY: 'Use when cargo physically arrives at the warehouse door.',
    BIN: 'Use when placing cargo onto a shelf or bin. Select the bin first.',
    EXIT: 'Use when loading cargo onto the vehicle for the assigned flight.',
  }

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Warehouse scanner</h1>
          <div className="sub">Scan the QR label on the shipment — or type the tracking ID manually.</div>
        </div>
      </div>

      <div style={{ maxWidth: 540 }}>
        {/* Mode selector */}
        <div className="card" style={{ marginBottom: 14 }}>
          <h3 style={{ marginBottom: 10 }}>1. Select scan type</h3>
          <div className="scan-modes">
            {MODES.map(([m, label]) => (
              <button key={m} className={mode === m ? 'active' : ''} onClick={() => { setMode(m); setResult(null) }}>
                {label}
              </button>
            ))}
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>{modeDesc[mode]}</p>
        </div>

        {/* Warehouse + Bin selectors */}
        <div className="card" style={{ marginBottom: 14 }}>
          <h3 style={{ marginBottom: 10 }}>2. Select location</h3>
          <label className="field">
            <span className="lbl">Warehouse</span>
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.iata})</option>)}
            </select>
          </label>
          {mode === 'BIN' && (
            <label className="field">
              <span className="lbl">Bin / shelf location</span>
              <select value={binCode} onChange={(e) => setBinCode(e.target.value)}>
                <option value="">Select bin…</option>
                {bins.map((b) => <option key={b.id} value={b.code}>{b.code}</option>)}
              </select>
            </label>
          )}
        </div>

        {/* Camera scanner */}
        <div className="card">
          <h3 style={{ marginBottom: 10 }}>3. Scan shipment QR code</h3>

          <div id="qr-region" style={{ display: cameraOn ? 'block' : 'none', borderRadius: 8, overflow: 'hidden', marginBottom: 10 }} />

          {!cameraOn ? (
            <button className="btn" style={{ width: '100%', marginBottom: 12 }} onClick={startCamera}>
              📷 Start camera scan
            </button>
          ) : (
            <button className="btn ghost" style={{ width: '100%', marginBottom: 12 }} onClick={stopCamera}>
              Stop camera
            </button>
          )}

          <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 13, marginBottom: 12 }}>
            — or enter manually —
          </div>

          <form onSubmit={manualSubmit} style={{ display: 'flex', gap: 8 }}>
            <input
              className="mono"
              placeholder="SCL-A1B2C3D4E5"
              value={manual}
              onChange={(e) => setManual(e.target.value.toUpperCase())}
              style={{ flex: 1 }}
            />
            <button className="btn dark" type="submit">Submit</button>
          </form>

          {/* Result display */}
          {result && (
            <div style={{
              marginTop: 14,
              padding: 14,
              borderRadius: 8,
              background: result.ok === true ? '#0e1f2b' : result.ok === false ? '#3a1212' : '#1a2a1a',
              fontFamily: 'var(--mono)',
              whiteSpace: 'pre-line',
              fontSize: 14,
              color: result.ok === true ? '#9fe8c9' : result.ok === false ? '#f3b0a0' : '#c8e6c9',
              borderLeft: `4px solid ${result.ok === true ? '#177e56' : result.ok === false ? '#c97a10' : '#4a8a4a'}`,
            }}>
              {result.text}
            </div>
          )}
        </div>

        {/* How it works guide */}
        <div className="card" style={{ marginTop: 14 }}>
          <h3 style={{ marginBottom: 10 }}>How scanning works</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              { step: '1', color: '#0e93b0', title: 'ENTRY scan', desc: 'Cargo arrives → status changes to "At Warehouse"' },
              { step: '2', color: '#177e56', title: 'BIN scan', desc: 'Select shelf (e.g. COLD-01) → status changes to "Binned"' },
              { step: '3', color: '#c97a10', title: 'LOAD scan', desc: 'Cargo goes to flight → status changes to "Loaded"' },
            ].map((s) => (
              <div key={s.step} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <div style={{
                  width: 28, height: 28, borderRadius: '50%', background: s.color,
                  color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: '700', fontSize: 13, flexShrink: 0,
                }}>{s.step}</div>
                <div>
                  <div style={{ fontWeight: '700', fontSize: 13 }}>{s.title}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="alert warn" style={{ marginTop: 12 }}>
            <strong>Important:</strong> The QR code on the shipment label only works inside this scanner page.
            If your phone opens a browser when you scan — use the <strong>manual entry</strong> field
            and type the tracking ID (SCL-XXXXXXXXXX) shown on the label.
          </div>
        </div>
      </div>
    </Shell>
  )
}
