import { STATUS_LABELS } from '../lib/constants'

export default function StatusChip({ status }) {
  let cls = 'chip'
  if (status === 'DELIVERED') cls += ' delivered'
  else if (status === 'EXCEPTION') cls += ' exception'
  else if (['IN_FLIGHT', 'LOADED', 'LANDED', 'OUT_FOR_DELIVERY'].includes(status)) cls += ' transit'
  return <span className={cls}>{STATUS_LABELS[status] ?? status}</span>
}
