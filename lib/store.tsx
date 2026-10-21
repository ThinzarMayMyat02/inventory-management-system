'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { computeMetrics, todayISO, type Metrics } from './calc'
import { createProductOp, uid, type BulkCommitRow, type IssueInput, type OpResult, type ProductInput, type ReceiveInput } from './ops'
import { buildSeed } from './seed'
import { DEFAULT_SETTINGS, type Data, type Persisted, type Product, type ReorderStatus, type Settings, type TrashItem } from './types'
import { getSupabase, isSupabaseConfigured } from './supabase'
import { mapBatch, mapMovement, mapProduct, mapReorder, mapSettings, settingsToRow } from './db-mappers'

const STORAGE_KEY = 'stocksense-ai:v1'
const MIGRATION_EXPORTED_KEY = 'stocksense-ai:supabase-migration-exported:v1'
const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export interface Row { product: Product; m: Metrics }
interface StoreApi {
  ready: boolean
  data: Data
  trash: TrashItem[]
  settings: Settings
  rows: Row[]
  authEnabled: boolean
  userEmail: string | null
  authError: string | null
  workspaceId: string | null
  localMigrationAvailable: boolean
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  exportLocalSql: () => Promise<void>
  getRow: (productId: string) => Row | undefined
  addProduct: (input: ProductInput) => Promise<Product>
  updateProduct: (id: string, patch: Partial<Omit<Product, 'id' | 'createdAt'>>) => Promise<{ ok: boolean; error?: string }>
  updateProducts: (ids: string[], patch: Partial<Pick<Product, 'category' | 'unit' | 'reorderPoint' | 'dailyUsage'>>) => Promise<void>
  deleteProducts: (ids: string[]) => Promise<void>
  restoreTrash: (id: string) => Promise<{ ok: boolean; error?: string }>
  permanentlyDeleteTrash: (id: string) => Promise<void>
  emptyTrash: () => Promise<void>
  receiveStock: (input: ReceiveInput) => Promise<OpResult>
  issueStock: (input: IssueInput) => Promise<OpResult>
  commitBulk: (rows: BulkCommitRow[]) => Promise<{ created: number; received: number }>
  createReorder: (productId: string, quantity: number, basis: string) => Promise<void>
  setReorderStatus: (id: string, status: ReorderStatus) => Promise<void>
  setDispatchPriority: (batchId: string, value: boolean) => Promise<void>
  updateSettings: (patch: Partial<Settings>) => Promise<void>
  resetDemo: () => Promise<void>
}

const EMPTY: Data = { products: [], batches: [], movements: [], reorders: [] }
const Ctx = createContext<StoreApi | null>(null)
function pruneTrash(items: TrashItem[], now = Date.now()): TrashItem[] {
  return items.filter((item) => now - new Date(item.deletedAt).getTime() < TRASH_RETENTION_MS)
}
function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message)
  return result.data as T
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<Persisted | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authReady, setAuthReady] = useState(!isSupabaseConfigured())
  const [localMigrationAvailable, setLocalMigrationAvailable] = useState(false)
  const ref = useRef<Persisted | null>(null)
  const supabaseEnabled = isSupabaseConfigured()

  const commit = useCallback((next: Persisted) => { ref.current = next; setState(next) }, [])

  useEffect(() => {
    try { setLocalMigrationAvailable(Boolean(localStorage.getItem(STORAGE_KEY)) && !localStorage.getItem(MIGRATION_EXPORTED_KEY)) }
    catch { setLocalMigrationAvailable(false) }
  }, [])

  const refreshWorkspace = useCallback(async (nextWorkspaceId: string) => {
    const supabase = getSupabase()
    const purged = await supabase.rpc('purge_expired_trash', { p_workspace_id: nextWorkspaceId })
    if (purged.error) throw new Error(purged.error.message)
    const [products, batches, movements, reorders, settings, trash] = await Promise.all([
      supabase.from('products').select('*').eq('workspace_id', nextWorkspaceId).order('created_at', { ascending: false }),
      supabase.from('batches').select('*').eq('workspace_id', nextWorkspaceId).order('received_at', { ascending: false }),
      supabase.from('stock_movements').select('*').eq('workspace_id', nextWorkspaceId).order('created_at', { ascending: false }),
      supabase.from('reorder_requests').select('*').eq('workspace_id', nextWorkspaceId).order('created_at', { ascending: false }),
      supabase.from('workspace_settings').select('*').eq('workspace_id', nextWorkspaceId).maybeSingle(),
      supabase.from('recycle_bin_entries').select('*').eq('workspace_id', nextWorkspaceId).order('deleted_at', { ascending: false }),
    ])
    for (const result of [products, batches, movements, reorders, settings, trash]) if (result.error) throw new Error(result.error.message)
    const data: Data = {
      products: (products.data ?? []).map(mapProduct), batches: (batches.data ?? []).map(mapBatch),
      movements: (movements.data ?? []).map(mapMovement), reorders: (reorders.data ?? []).map(mapReorder),
    }
    const recycle: TrashItem[] = (trash.data ?? []).map((item: any) => ({
      id: item.id, product: mapProduct(item.product_snapshot),
      batches: (item.batches_snapshot ?? []).map(mapBatch), deletedAt: item.deleted_at,
    }))
    const next: Persisted = {
      data, trash: pruneTrash(recycle), settings: mapSettings(settings.data, DEFAULT_SETTINGS),
      seededOn: todayISO(), dirty: true,
    }
    commit(next)
  }, [commit])

  useEffect(() => {
    if (!supabaseEnabled) {
      // Keep local data available for the migration exporter until Supabase is configured.
      setAuthReady(true)
      return
    }
    const supabase = getSupabase()
    let alive = true
    const initialize = async (nextUser: User | null) => {
      setUser(nextUser)
      setAuthError(null)
      setState(null)
      setWorkspaceId(null)
      if (!nextUser) { setAuthReady(true); return }
      try {
        const member = unwrap(await supabase.from('workspace_members').select('workspace_id').eq('user_id', nextUser.id).limit(1).maybeSingle()) as { workspace_id: string } | null
        if (!member?.workspace_id) throw new Error('No inventory workspace is linked to this account. Run schema.sql and sign in again.')
        if (!alive) return
        setWorkspaceId(member.workspace_id)
        const seedState = unwrap(await supabase.from('workspace_settings').select('sample_data_initialized').eq('workspace_id', member.workspace_id).maybeSingle()) as { sample_data_initialized: boolean } | null
        if (seedState && !seedState.sample_data_initialized) {
          const seed = buildSeed()
          const seeded = await supabase.rpc('initialize_workspace_seed', { p_workspace_id: member.workspace_id,
            p_products: seed.data.products.map((p) => ({ id:p.id,name:p.name,sku:p.sku,category:p.category,unit:p.unit,reorder_point:p.reorderPoint,daily_usage:p.dailyUsage,unit_cost:p.unitCost,supplier:p.supplier,tracks_expiry:p.tracksExpiry,created_at:p.createdAt,updated_at:p.updatedAt })),
            p_batches: seed.data.batches.map((b) => ({ id:b.id,product_id:b.productId,batch_number:b.batchNumber,quantity:b.quantity,received_qty:b.receivedQty,expiry_date:b.expiryDate,received_at:b.receivedAt,supplier:b.supplier,dispatch_priority:b.dispatchPriority })),
            p_movements: seed.data.movements.map((m) => ({ id:m.id,type:m.type,product_id:m.productId,product_name:m.productName,sku:m.sku,unit:m.unit,quantity:m.quantity,previous_stock:m.previousStock,new_stock:m.newStock,batch_summary:m.batchSummary,reason:m.reason,note:m.note,created_at:m.createdAt })) })
          if (seeded.error) throw new Error(seeded.error.message)
        }
        await refreshWorkspace(member.workspace_id)
      } catch (error) {
        if (alive) setAuthError(error instanceof Error ? error.message : 'Could not load your inventory workspace.')
      } finally { if (alive) setAuthReady(true) }
    }
    supabase.auth.getSession().then(({ data, error }) => {
      if (error) setAuthError(error.message)
      return initialize(data.session?.user ?? null)
    })
    // Do not call Supabase APIs from inside onAuthStateChange. Supabase Auth
    // holds an internal lock while invoking listeners; initialize() queries
    // the workspace and can deadlock the client after a successful sign-in.
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      const nextUser = session?.user ?? null
      setTimeout(() => { if (alive) void initialize(nextUser) }, 0)
    })
    return () => { alive = false; listener.subscription.unsubscribe() }
  }, [supabaseEnabled, refreshWorkspace])

  const data = state?.data ?? EMPTY
  const settings = state?.settings ?? DEFAULT_SETTINGS
  const rows = useMemo<Row[]>(() => data.products.map((product) => ({ product, m: computeMetrics(product, data.batches, settings) })), [data.products, data.batches, settings])

  const withWorkspace = useCallback(() => {
    if (!workspaceId || !ref.current) throw new Error('Sign in and wait for your workspace to finish loading.')
    return { supabase: getSupabase(), workspaceId, current: ref.current }
  }, [workspaceId])

  const api = useMemo<StoreApi>(() => ({
    ready: authReady && (!supabaseEnabled || !user || state !== null || Boolean(authError)),
    data, trash: pruneTrash(state?.trash ?? []), settings, rows,
    authEnabled: supabaseEnabled, userEmail: user?.email ?? null, authError, workspaceId, localMigrationAvailable,
    signIn: async (email, password) => {
      setAuthError(null)
      const result = await getSupabase().auth.signInWithPassword({ email, password })
      if (result.error) { setAuthError(result.error.message); throw result.error }
    },
    signUp: async (email, password) => {
      setAuthError(null)
      const result = await getSupabase().auth.signUp({ email, password })
      if (result.error) { setAuthError(result.error.message); throw result.error }
      if (!result.data.session) setAuthError('Check your email to confirm your account, then sign in.')
    },
    signOut: async () => { const result = await getSupabase().auth.signOut(); if (result.error) throw result.error },
    exportLocalSql: async () => {
      let persisted: Persisted | null = null
      try { const raw = localStorage.getItem(STORAGE_KEY); if (raw) persisted = JSON.parse(raw) as Persisted } catch { /* handled below */ }
      if (!persisted) throw new Error('No StockSense localStorage data was found in this browser.')
      const targetWorkspace = workspaceId
      const sql = buildMigrationSql(persisted, targetWorkspace)
      const blob = new Blob([sql], { type: 'text/sql;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'mig.sql'; anchor.click()
      URL.revokeObjectURL(url)
      localStorage.setItem(MIGRATION_EXPORTED_KEY, new Date().toISOString())
      setLocalMigrationAvailable(false)
    },
    getRow: (id) => rows.find((r) => r.product.id === id),
    addProduct: async (input) => {
      const { supabase, workspaceId: ws, current } = withWorkspace()
      const created = createProductOp(current.data, input).product
      unwrap(await supabase.from('products').insert({ id: created.id, workspace_id: ws, name: created.name, sku: created.sku,
        category: created.category, unit: created.unit, reorder_point: created.reorderPoint, daily_usage: created.dailyUsage,
        unit_cost: created.unitCost, supplier: created.supplier, tracks_expiry: created.tracksExpiry, created_at: created.createdAt, updated_at: created.updatedAt }))
      await refreshWorkspace(ws); return created
    },
    updateProduct: async (id, patch) => {
      const { supabase, workspaceId: ws, current } = withWorkspace()
      const normalized = patch.sku === undefined ? patch : { ...patch, sku: patch.sku.trim().toUpperCase() }
      if (normalized.sku && current.data.products.some((p) => p.id !== id && p.sku.toLowerCase() === normalized.sku!.toLowerCase())) return { ok: false, error: 'SKU is already used by another product.' }
      const row: Record<string, unknown> = { ...normalized, updated_at: new Date().toISOString() }
      const pairs: Record<string, string> = { reorderPoint: 'reorder_point', dailyUsage: 'daily_usage', unitCost: 'unit_cost', tracksExpiry: 'tracks_expiry', createdAt: 'created_at', updatedAt: 'updated_at' }
      for (const [key, value] of Object.entries(normalized)) { if (pairs[key]) { row[pairs[key]] = value; delete row[key] } }
      const result = await supabase.from('products').update(row).eq('workspace_id', ws).eq('id', id)
      if (result.error) return { ok: false, error: result.error.message }
      await refreshWorkspace(ws); return { ok: true }
    },
    updateProducts: async (ids, patch) => {
      const { supabase, workspaceId: ws } = withWorkspace()
      const row: Record<string, unknown> = {}
      if (patch.category !== undefined) row.category = patch.category
      if (patch.unit !== undefined) row.unit = patch.unit
      if (patch.reorderPoint !== undefined) row.reorder_point = patch.reorderPoint
      if (patch.dailyUsage !== undefined) row.daily_usage = patch.dailyUsage
      row.updated_at = new Date().toISOString()
      unwrap(await supabase.from('products').update(row).eq('workspace_id', ws).in('id', ids))
      await refreshWorkspace(ws)
    },
    deleteProducts: async (ids) => {
      const { supabase, workspaceId: ws } = withWorkspace()
      unwrap(await supabase.rpc('trash_products', { p_workspace_id: ws, p_product_ids: ids }))
      await refreshWorkspace(ws)
    },
    restoreTrash: async (id) => {
      const { supabase, workspaceId: ws } = withWorkspace()
      const result = await supabase.rpc('restore_trash_product', { p_workspace_id: ws, p_entry_id: id })
      if (result.error) return { ok: false, error: result.error.message }
      await refreshWorkspace(ws); return { ok: true }
    },
    permanentlyDeleteTrash: async (id) => {
      const { supabase, workspaceId: ws } = withWorkspace()
      unwrap(await supabase.rpc('purge_trash', { p_workspace_id: ws, p_entry_id: id }))
      await refreshWorkspace(ws)
    },
    emptyTrash: async () => {
      const { supabase, workspaceId: ws } = withWorkspace()
      unwrap(await supabase.rpc('purge_trash', { p_workspace_id: ws, p_entry_id: null }))
      await refreshWorkspace(ws)
    },
    receiveStock: async (input) => {
      const { supabase, workspaceId: ws } = withWorkspace()
      const result = await supabase.rpc('receive_stock', { p_workspace_id: ws, p_product_id: input.productId,
        p_quantity: input.quantity, p_batch_id: input.batchId ?? null, p_batch_number: input.batchNumber ?? null,
        p_expiry_date: input.expiryDate ?? null, p_supplier: input.supplier ?? null,
        p_reason: input.reason ?? 'Supplier delivery', p_note: input.note ?? '' })
      if (result.error) return { ok: false, error: result.error.message }
      await refreshWorkspace(ws)
      return { ok: true, movement: mapMovement(result.data), data: ref.current!.data }
    },
    issueStock: async (input) => {
      const { supabase, workspaceId: ws } = withWorkspace()
      const result = await supabase.rpc('issue_stock', { p_workspace_id: ws, p_product_id: input.productId,
        p_quantity: input.quantity, p_batch_id: input.batchId, p_reason: input.reason ?? 'Customer dispatch', p_note: input.note ?? '' })
      if (result.error) return { ok: false, error: result.error.message }
      await refreshWorkspace(ws)
      return { ok: true, movement: mapMovement(result.data), data: ref.current!.data }
    },
    commitBulk: async (bulkRows) => {
      const { supabase, workspaceId: ws } = withWorkspace()
      const result = unwrap(await supabase.rpc('commit_bulk_entry', { p_workspace_id: ws, p_rows: bulkRows.map((row) => ({
        productId: row.productId, product: row.product, quantity: row.quantity, batchNumber: row.batchNumber,
        expiryDate: row.expiryDate, supplier: row.supplier,
      })) })) as { created: number; received: number }
      await refreshWorkspace(ws); return result
    },
    createReorder: async (productId, quantity, basis) => {
      const { supabase, workspaceId: ws, current } = withWorkspace()
      const product = current.data.products.find((p) => p.id === productId)
      if (!product) throw new Error('Product not found.')
      const row = { id: uid('r'), workspace_id: ws, product_id: product.id, product_name: product.name,
        sku: product.sku, unit: product.unit, quantity, status: 'Requested', basis, created_at: new Date().toISOString() }
      unwrap(await supabase.from('reorder_requests').insert(row)); await refreshWorkspace(ws)
    },
    setReorderStatus: async (id, status) => {
      const { supabase, workspaceId: ws } = withWorkspace()
      unwrap(await supabase.from('reorder_requests').update({ status }).eq('workspace_id', ws).eq('id', id)); await refreshWorkspace(ws)
    },
    setDispatchPriority: async (batchId, value) => {
      const { supabase, workspaceId: ws } = withWorkspace()
      unwrap(await supabase.rpc('set_batch_dispatch_priority', { p_workspace_id: ws, p_batch_id: batchId, p_value: value })); await refreshWorkspace(ws)
    },
    updateSettings: async (patch) => {
      const { supabase, workspaceId: ws, current } = withWorkspace()
      const next = { ...current.settings, ...patch }
      unwrap(await supabase.from('workspace_settings').upsert(settingsToRow(next, ws))); await refreshWorkspace(ws)
    },
    resetDemo: async () => {
      const { supabase, workspaceId: ws, current } = withWorkspace()
      const sample = buildSeed()
      const result = unwrap(await supabase.rpc('reset_workspace_demo', { p_workspace_id: ws,
        p_products: sample.data.products.map((p) => ({ id: p.id, name: p.name, sku: p.sku, category: p.category, unit: p.unit,
          reorder_point: p.reorderPoint, daily_usage: p.dailyUsage, unit_cost: p.unitCost, supplier: p.supplier,
          tracks_expiry: p.tracksExpiry, created_at: p.createdAt, updated_at: p.updatedAt })),
        p_batches: sample.data.batches.map((b) => ({ id: b.id, product_id: b.productId, batch_number: b.batchNumber,
          quantity: b.quantity, received_qty: b.receivedQty, expiry_date: b.expiryDate, received_at: b.receivedAt,
          supplier: b.supplier, dispatch_priority: b.dispatchPriority })),
        p_movements: sample.data.movements.map((m) => ({ id: m.id, type: m.type, product_id: m.productId,
          product_name: m.productName, sku: m.sku, unit: m.unit, quantity: m.quantity,
          previous_stock: m.previousStock, new_stock: m.newStock, batch_summary: m.batchSummary,
          reason: m.reason, note: m.note, created_at: m.createdAt })),
        p_settings: settingsToRow(current.settings, ws),
      }))
      void result
      await refreshWorkspace(ws)
    },
  }), [authReady, supabaseEnabled, user, state, data, settings, rows, authError, workspaceId, localMigrationAvailable, withWorkspace, refreshWorkspace])

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}

function buildMigrationSql(persisted: Persisted, workspaceId: string | null): string {
  const data = persisted.data
  const trash = pruneTrash(persisted.trash ?? [])
  const lines = [
    '-- StockSense localStorage import. Generated for the currently signed-in workspace.',
    '-- Run only after schema.sql. This replaces current workspace inventory data with this browser snapshot.',
    'begin;',
    `do $$ declare target_workspace uuid := ${workspaceId ? `'${workspaceId}'::uuid` : 'null::uuid'}; begin`,
    "  if target_workspace is null then raise exception 'Sign in to StockSense before generating mig.sql'; end if;",
    '  delete from public.recycle_bin_entries where workspace_id = target_workspace;',
    '  delete from public.reorder_requests where workspace_id = target_workspace;',
    '  delete from public.stock_movements where workspace_id = target_workspace;',
    '  delete from public.batches where workspace_id = target_workspace;',
    '  delete from public.products where workspace_id = target_workspace;',
  ]
  const emit = (table: string, rows: Record<string, unknown>[], columns: string[]) => {
    for (const row of rows) lines.push(`  insert into public.${table} (${columns.join(', ')}) values (${columns.map((c) => sqlLiteral(row[c])).join(', ')});`)
  }
  for (const p of data.products) lines.push(`  insert into public.products (id, workspace_id, name, sku, category, unit, reorder_point, daily_usage, unit_cost, supplier, tracks_expiry, created_at, updated_at) values (${[p.id, null, p.name, p.sku, p.category, p.unit, p.reorderPoint, p.dailyUsage, p.unitCost, p.supplier, p.tracksExpiry, p.createdAt, p.updatedAt].map((v, i) => i === 1 ? 'target_workspace' : sqlLiteral(v)).join(', ')});`)
  const rowInsert = (table: string, values: (string | number | boolean | null)[]) => lines.push(`  insert into public.${table} values (${values.map((v) => v === null ? 'null' : typeof v === 'string' && v.startsWith('SQL:') ? v.slice(4) : sqlLiteral(v)).join(', ')});`)
  for (const b of data.batches) rowInsert('batches (id, workspace_id, product_id, batch_number, quantity, received_qty, expiry_date, received_at, supplier, dispatch_priority)', [b.id, 'SQL:target_workspace', b.productId,b.batchNumber,b.quantity,b.receivedQty,b.expiryDate,b.receivedAt,b.supplier,b.dispatchPriority])
  for (const m of data.movements) rowInsert('stock_movements (id, workspace_id, type, product_id, product_name, sku, unit, quantity, previous_stock, new_stock, batch_summary, reason, note, created_at)', [m.id,'SQL:target_workspace',m.type,m.productId,m.productName,m.sku,m.unit,m.quantity,m.previousStock,m.newStock,m.batchSummary,m.reason,m.note,m.createdAt])
  for (const r of data.reorders) rowInsert('reorder_requests (id, workspace_id, product_id, product_name, sku, unit, quantity, status, basis, created_at)', [r.id,'SQL:target_workspace',r.productId,r.productName,r.sku,r.unit,r.quantity,r.status,r.basis,r.createdAt])
  for (const item of trash) {
    const p = item.product
    const pSnapshot = { id:p.id,name:p.name,sku:p.sku,category:p.category,unit:p.unit,reorder_point:p.reorderPoint,daily_usage:p.dailyUsage,unit_cost:p.unitCost,supplier:p.supplier,tracks_expiry:p.tracksExpiry,created_at:p.createdAt,updated_at:p.updatedAt }
    const bSnapshots = item.batches.map((b) => ({ id:b.id,product_id:b.productId,batch_number:b.batchNumber,quantity:b.quantity,received_qty:b.receivedQty,expiry_date:b.expiryDate,received_at:b.receivedAt,supplier:b.supplier,dispatch_priority:b.dispatchPriority }))
    rowInsert('recycle_bin_entries (id, workspace_id, product_id, product_snapshot, batches_snapshot, deleted_at)', [item.id,'SQL:target_workspace',item.product.id,`SQL:${sqlLiteral(JSON.stringify(pSnapshot))}::jsonb`,`SQL:${sqlLiteral(JSON.stringify(bSnapshots))}::jsonb`,item.deletedAt])
  }
  lines.push(`  update public.workspace_settings set expiry_window_days = ${persisted.settings.expiryWindowDays}, stockout_horizon_days = ${persisted.settings.stockoutHorizonDays}, target_cover_days = ${persisted.settings.targetCoverDays}, sample_data_initialized = true, updated_at = now() where workspace_id = target_workspace;`, 'end; $$;', 'commit;')
  return lines.join('\n')
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return `'${String(value).replace(/'/g, "''")}'`
}

export function useStore(): StoreApi {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useStore must be used within StoreProvider')
  return ctx
}
