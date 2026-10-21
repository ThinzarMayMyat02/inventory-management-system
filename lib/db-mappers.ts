import type { Batch, Movement, Product, ReorderRequest, Settings } from './types'

type Row = Record<string, any>

export const mapProduct = (r: Row): Product => ({
  id: r.id, name: r.name, sku: r.sku, category: r.category, unit: r.unit,
  reorderPoint: Number(r.reorder_point), dailyUsage: Number(r.daily_usage), unitCost: Number(r.unit_cost),
  supplier: r.supplier ?? '', tracksExpiry: r.tracks_expiry,
  createdAt: r.created_at, updatedAt: r.updated_at,
})

export const mapBatch = (r: Row): Batch => ({
  id: r.id, productId: r.product_id, batchNumber: r.batch_number,
  quantity: Number(r.quantity), receivedQty: Number(r.received_qty), expiryDate: r.expiry_date,
  receivedAt: r.received_at, supplier: r.supplier ?? '', dispatchPriority: r.dispatch_priority,
})

export const mapMovement = (r: Row): Movement => ({
  id: r.id, type: r.type, productId: r.product_id, productName: r.product_name, sku: r.sku, unit: r.unit,
  quantity: Number(r.quantity), previousStock: Number(r.previous_stock), newStock: Number(r.new_stock),
  batchSummary: r.batch_summary ?? '', reason: r.reason ?? '', note: r.note ?? '', createdAt: r.created_at,
})

export const mapReorder = (r: Row): ReorderRequest => ({
  id: r.id, productId: r.product_id, productName: r.product_name, sku: r.sku, unit: r.unit,
  quantity: Number(r.quantity), status: r.status, basis: r.basis ?? '', createdAt: r.created_at,
})

export const settingsToRow = (settings: Settings, workspaceId: string) => ({
  workspace_id: workspaceId, expiry_window_days: settings.expiryWindowDays,
  stockout_horizon_days: settings.stockoutHorizonDays, target_cover_days: settings.targetCoverDays,
})

export const mapSettings = (r: Row | null, defaults: Settings): Settings => r ? ({
  expiryWindowDays: r.expiry_window_days,
  stockoutHorizonDays: r.stockout_horizon_days,
  targetCoverDays: r.target_cover_days,
}) : defaults

export const productToRow = (p: Product, workspaceId: string) => ({
  id: p.id, workspace_id: workspaceId, name: p.name, sku: p.sku, category: p.category, unit: p.unit,
  reorder_point: p.reorderPoint, daily_usage: p.dailyUsage, unit_cost: p.unitCost,
  supplier: p.supplier, tracks_expiry: p.tracksExpiry, created_at: p.createdAt, updated_at: p.updatedAt,
})

export const batchToRow = (b: Batch, workspaceId: string) => ({
  id: b.id, workspace_id: workspaceId, product_id: b.productId, batch_number: b.batchNumber,
  quantity: b.quantity, received_qty: b.receivedQty, expiry_date: b.expiryDate,
  received_at: b.receivedAt, supplier: b.supplier, dispatch_priority: b.dispatchPriority,
})

export const movementToRow = (m: Movement, workspaceId: string) => ({
  id: m.id, workspace_id: workspaceId, type: m.type, product_id: m.productId,
  product_name: m.productName, sku: m.sku, unit: m.unit, quantity: m.quantity,
  previous_stock: m.previousStock, new_stock: m.newStock, batch_summary: m.batchSummary,
  reason: m.reason, note: m.note, created_at: m.createdAt,
})

export const reorderToRow = (r: ReorderRequest, workspaceId: string) => ({
  id: r.id, workspace_id: workspaceId, product_id: r.productId, product_name: r.productName,
  sku: r.sku, unit: r.unit, quantity: r.quantity, status: r.status, basis: r.basis, created_at: r.createdAt,
})

export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return `'${String(value).replace(/'/g, "''")}'`
}
