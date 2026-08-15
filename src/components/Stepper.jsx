import { STAGES, stageIndex } from '../lib/constants'

export default function Stepper({ status }) {
  const idx = stageIndex(status)
  const delivered = status === 'DELIVERED'
  return (
    <div className="stepper">
      {STAGES.map((s, i) => {
        const done = delivered || i < idx
        const now = !delivered && i === idx
        return (
          <div key={s.name} className={`step ${done ? 'done' : ''} ${now ? 'now' : ''}`}>
            <div className="dot">{done ? '✓' : i + 1}</div>
            <div className="nm">{s.name}</div>
          </div>
        )
      })}
    </div>
  )
}
