import { STATUS_LABELS, fmt } from '../lib/constants'

export default function Timeline({ events }) {
  if (!events?.length) return <p className="muted small">No events yet.</p>
  const list = [...events].sort((a, b) => new Date(b.at ?? b.created_at) - new Date(a.at ?? a.created_at))
  return (
    <ul className="timeline">
      {list.map((e, i) => (
        <li key={i} className={e.status === 'EXCEPTION' ? 'exception' : ''}>
          <div className="t-status">{STATUS_LABELS[e.status] ?? e.status}</div>
          <div className="t-meta">
            {fmt(e.at ?? e.created_at)}
            {(e.location ?? e.location_label) ? ` · ${e.location ?? e.location_label}` : ''}
          </div>
          {e.note && <div className="t-note">{e.note}</div>}
        </li>
      ))}
    </ul>
  )
}
