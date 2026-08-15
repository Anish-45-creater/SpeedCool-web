import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import Shell from '../../components/Shell'
import { fmt } from '../../lib/constants'

export default function Notifications() {
  const [items, setItems] = useState([])
  const load = async () => {
    const { data } = await supabase.from('notifications')
      .select('*').order('created_at', { ascending: false }).limit(50)
    setItems(data ?? [])
  }
  useEffect(() => {
    load()
    const ch = supabase.channel('notifs')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [])
  return (
    <Shell>
      <div className="page-head"><div><h1>Notifications</h1>
        <div className="sub">Every milestone, the moment it happens.</div></div></div>
      <div className="card">
        {items.length === 0 && <p className="muted">Nothing yet — milestone alerts appear here in real time.</p>}
        {items.map((n) => (
          <div key={n.id} className="notif-item">
            <div><strong className="mono small">{n.title}</strong></div>
            <div>{n.body}</div>
            <div className="when">{fmt(n.created_at)}</div>
          </div>
        ))}
      </div>
    </Shell>
  )
}
