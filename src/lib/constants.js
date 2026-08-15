export const STATUS_FLOW = [
  'BOOKED',
  'RECEIVED_AT_WAREHOUSE',
  'BINNED',
  'MANIFESTED',
  'ASSIGNED_TO_FLIGHT',
  'LOADED',
  'IN_FLIGHT',
  'LANDED',
  'CUSTOMS_CLEARANCE',
  'CLEARED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
]

export const STATUS_LABELS = {
  BOOKED: 'Booked',
  RECEIVED_AT_WAREHOUSE: 'At warehouse',
  BINNED: 'Binned',
  MANIFESTED: 'Manifested',
  ASSIGNED_TO_FLIGHT: 'Flight assigned',
  LOADED: 'Loaded',
  IN_FLIGHT: 'In flight',
  LANDED: 'Landed',
  CUSTOMS_CLEARANCE: 'In customs',
  CLEARED: 'Customs cleared',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  EXCEPTION: 'Exception',
}

// The 4 lifecycle stages shown to customers
export const STAGES = [
  { name: 'Order accepted', statuses: ['BOOKED'] },
  { name: 'Warehouse', statuses: ['RECEIVED_AT_WAREHOUSE', 'BINNED', 'MANIFESTED'] },
  { name: 'Air transit', statuses: ['ASSIGNED_TO_FLIGHT', 'LOADED', 'IN_FLIGHT', 'LANDED', 'CUSTOMS_CLEARANCE', 'CLEARED'] },
  { name: 'Delivery', statuses: ['OUT_FOR_DELIVERY', 'DELIVERED'] },
]

export function nextStatus(current) {
  const i = STATUS_FLOW.indexOf(current)
  if (i === -1 || i === STATUS_FLOW.length - 1) return null
  return STATUS_FLOW[i + 1]
}

export function stageIndex(status) {
  if (status === 'EXCEPTION') return -1
  const idx = STAGES.findIndex((s) => s.statuses.includes(status))
  return idx
}

export function fmt(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

export const ROLE_HOME = {
  admin: '/ops',
  ops: '/ops',
  warehouse: '/warehouse',
  driver: '/driver',
  customer: '/my',
}
