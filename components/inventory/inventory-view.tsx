'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { ArrowLeftRight, ArrowUpDown, Download, ListChecks, Plus, SlidersHorizontal, Trash2, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Field, SearchInput, Select, TextInput } from '@/components/ui/fields'
import { IconButton } from '@/components/ui/icon-button'
import { Modal } from '@/components/ui/overlay'
import { Pagination } from '@/components/ui/pagination'
import { Popover } from '@/components/ui/popover'
import { EmptyState, KpiStrip, PageHeader, PageSkeleton, Panel } from '@/components/page-kit'
import { InventoryTable, type ColumnId } from '@/components/inventory/inventory-table'
import { useStore, type Row } from '@/lib/store'
import { useUI, type BulkSeed } from '@/lib/ui'
import { BULK_TEMPLATE_HEADERS, downloadCsv, getBulkSampleRows } from '@/lib/csv'
import { readBulkImportFile } from '@/lib/import-file'
import { fmtDate, fmtInt } from '@/lib/calc'
import { summarize, summaryItems } from '@/lib/summary'
import { uniqueSkuVariant } from '@/lib/ops'
import { CATEGORIES, UNITS, type Product } from '@/lib/types'
import { cn } from '@/lib/utils'

type StockFilter = 'all' | 'healthy' | 'low' | 'stockout'
type ExpiryFilter = 'all' | 'expiring' | 'expired' | 'ok' | 'none'
const STOCK_VALUES: StockFilter[] = ['all', 'healthy', 'low', 'stockout']
const EXPIRY_VALUES: ExpiryFilter[] = ['all', 'expiring', 'expired', 'ok', 'none']

const SORTS: { key: string; label: string }[] = [
  { key: 'name', label: 'Product name' },
  { key: 'sku', label: 'SKU' },
  { key: 'category', label: 'Category' },
  { key: 'stock', label: 'Current stock' },
  { key: 'status', label: 'Stock status' },
  { key: 'expiry', label: 'Next expiry' },
  { key: 'updated', label: 'Updated at' },
]

const STATUS_RANK = { stockout: 0, low: 1, healthy: 2 } as const
const DEFAULT_COLUMNS: ColumnId[] = ['sku', 'category', 'stock', 'unit', 'reorder', 'expiry', 'status']

function compare(a: Row, b: Row, key: string): number {
  switch (key) {
    case 'name':
      return a.product.name.localeCompare(b.product.name)
    case 'sku':
      return a.product.sku.localeCompare(b.product.sku)
    case 'category':
      return a.product.category.localeCompare(b.product.category) || a.product.name.localeCompare(b.product.name)
    case 'stock':
      return a.m.stock - b.m.stock
    case 'usage':
      return a.product.dailyUsage - b.product.dailyUsage
    case 'reorder':
      return a.product.reorderPoint - b.product.reorderPoint
    case 'status':
      return STATUS_RANK[a.m.stockStatus] - STATUS_RANK[b.m.stockStatus]
    case 'expiry':
      return (a.m.nextExpiry?.days ?? Infinity) - (b.m.nextExpiry?.days ?? Infinity)
    case 'updated':
      return a.product.updatedAt.localeCompare(b.product.updatedAt)
    default:
      return 0
  }
}

export function InventoryView() {
  const { ready, rows, data, updateProduct, updateProducts, deleteProducts } = useStore()
  const { openProduct, openMovement, openBulk, toast } = useUI()
  const params = useSearchParams()

  const [q, setQ] = useState('')
  const [category, setCategory] = useState('all')
  const [stock, setStock] = useState<StockFilter>('all')
  const [expiry, setExpiry] = useState<ExpiryFilter>('all')
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' })
  const columns = useMemo(() => new Set(DEFAULT_COLUMNS), [])
  const dense = false
  const inlineEdit = false
  const [showFilters, setShowFilters] = useState(true)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const s = params.get('status')
    const e = params.get('expiry')
    if (s || e) {
      setStock(STOCK_VALUES.includes(s as StockFilter) ? (s as StockFilter) : 'all')
      setExpiry(EXPIRY_VALUES.includes(e as ExpiryFilter) ? (e as ExpiryFilter) : 'all')
      setPage(1)
    }
  }, [params])

  const summary = useMemo(() => summarize(rows), [rows])

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    const out = rows.filter(({ product, m }) => {
      if (term && !`${product.name} ${product.sku} ${product.supplier}`.toLowerCase().includes(term)) return false
      if (category !== 'all' && product.category !== category) return false
      if (stock !== 'all' && m.stockStatus !== stock) return false
      if (expiry === 'expiring' && m.expiryStatus !== 'expiring' && m.expiryStatus !== 'expired') return false
      if (expiry !== 'all' && expiry !== 'expiring' && m.expiryStatus !== expiry) return false
      return true
    })
    const dir = sort.dir === 'asc' ? 1 : -1
    return out.sort((a, b) => compare(a, b, sort.key) * dir || a.product.name.localeCompare(b.product.name))
  }, [rows, q, category, stock, expiry, sort])

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, pages)
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize)
  const hasFilters = q !== '' || category !== 'all' || stock !== 'all' || expiry !== 'all'
  const selectedRows = rows.filter((r) => selected.has(r.product.id))

  const clearFilters = () => {
    setQ('')
    setCategory('all')
    setStock('all')
    setExpiry('all')
    setPage(1)
  }

  const applyKpi = (key: 'all' | 'low' | 'expiring' | 'stockout') => ({
    onClick: () => {
      setStock(key === 'low' || key === 'stockout' ? key : 'all')
      setExpiry(key === 'expiring' ? 'expiring' : 'all')
      setQ('')
      setCategory('all')
      setPage(1)
    },
  })

  const onSort = (key: string) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
    setPage(1)
  }

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const togglePage = (checked: boolean) =>
    setSelected((s) => {
      const n = new Set(s)
      for (const r of pageRows) {
        if (checked) n.add(r.product.id)
        else n.delete(r.product.id)
      }
      return n
    })

  const duplicate = ({ product }: Row) => {
    const taken = new Set(data.products.map((p) => p.sku))
    const seed: BulkSeed = {
      productId: null,
      name: `${product.name} (copy)`,
      sku: uniqueSkuVariant(product.sku, taken),
      category: product.category,
      unit: product.unit,
      reorder: String(product.reorderPoint),
      supplier: product.supplier,
    }
    openBulk([seed])
  }

  const updateInline = async (id: string, patch: Partial<Omit<Product, 'id' | 'createdAt'>>) => {
    let result
    try { result = await updateProduct(id, patch) }
    catch (error) { toast(error instanceof Error ? error.message : 'Could not update this product.', 'error'); return false }
    if (!result.ok) {
      toast(result.error ?? 'Could not update this product.', 'error')
      return false
    }
    return true
  }

  const exportCsv = (list: Row[], name: string) => {
    downloadCsv(name, [
      ['Product', 'SKU', 'Category', 'Current stock', 'Unit', 'Daily usage', 'Reorder point', 'Next expiry', 'Stock status'],
      ...list.map(({ product, m }) => [product.name, product.sku, product.category, m.stock, product.unit, product.dailyUsage, product.reorderPoint, m.nextExpiry ? fmtDate(m.nextExpiry.date) : '', m.stockStatus]),
    ])
    toast(`Exported ${fmtInt(list.length)} products.`)
  }

  const importCsv = async (file: File | undefined) => {
    if (!file) return
    try {
      const seeds = await readBulkImportFile(file)
      openBulk(seeds)
      toast(`Loaded ${fmtInt(seeds.length)} rows from ${file.name}. Review them before saving.`)
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not read this import file.', 'error')
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const downloadImportSample = () => {
    downloadCsv('stocksense-import-sample.csv', [BULK_TEMPLATE_HEADERS, ...getBulkSampleRows()])
  }

  if (!ready) return <PageSkeleton />

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Manage products, stock levels, and expiry dates."
        actions={
          <>
            <input ref={fileRef} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" tabIndex={-1} aria-label="Choose a CSV or Excel file to import" onChange={(e) => importCsv(e.target.files?.[0])} />
            <Button variant="outline" size="lg" onClick={() => openMovement('in')}>
              <ArrowLeftRight aria-hidden="true" />
              Stock In / Out
            </Button>
            <Button variant="outline" size="lg" onClick={() => fileRef.current?.click()}>
              <Upload aria-hidden="true" />
              Import CSV / Excel
            </Button>
            <Button variant="outline" size="lg" onClick={downloadImportSample}>
              <Download aria-hidden="true" />
              Sample file
            </Button>
            <Button size="lg" onClick={() => openBulk()}>
              <Plus aria-hidden="true" />
              Add Products
            </Button>
          </>
        }
      />

      <KpiStrip items={summaryItems(summary, applyKpi)} variant="cards" />

      <Panel className="overflow-hidden rounded-2xl border-border/80 shadow-sm transition-shadow hover:shadow-md">
        <div className="flex flex-wrap items-center gap-2 border-b border-border/80 bg-card p-3 sm:gap-4 sm:p-4">
          <div className="min-w-[220px] flex-1">
            <SearchInput
              aria-label="Search products"
              placeholder="Search name, SKU or supplier"
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                setPage(1)
              }}
            />
          </div>
          <Button variant="ghost" size="lg" onClick={() => exportCsv(filtered, 'stocksense-inventory.csv')} disabled={!filtered.length} className="shrink-0">
            <Download aria-hidden="true" />
            Export as CSV
          </Button>
          <Popover
            align="end"
            width={220}
            label="Sort products"
            trigger={(p) => (
              <Button {...p} variant="ghost" size="lg" className="shrink-0">
                <ArrowUpDown aria-hidden="true" />
                Sort by {SORTS.find((s) => s.key === sort.key)?.label ?? 'product name'}
              </Button>
            )}
          >
            {(close) => (
              <div role="group" aria-label="Sort by" className="p-1">
                {SORTS.map((s) => (
                  <MenuItem key={s.key} checked={sort.key === s.key} onClick={() => { onSort(s.key); close() }}>
                    {s.label}
                    {sort.key === s.key ? <span className="ml-auto text-xs text-muted-foreground">{sort.dir === 'asc' ? 'A–Z' : 'Z–A'}</span> : null}
                  </MenuItem>
                ))}
              </div>
            )}
          </Popover>
          <Button variant={showFilters || category !== 'all' || stock !== 'all' || expiry !== 'all' ? 'secondary' : 'ghost'} size="lg" onClick={() => setShowFilters((visible) => !visible)} aria-expanded={showFilters} className="shrink-0">
            <SlidersHorizontal aria-hidden="true" />
            Filter
          </Button>
        </div>

        {showFilters ? <div className="flex flex-wrap items-center gap-2 border-b border-border/80 bg-muted/20 p-3 sm:px-4">
          <div className="w-full sm:w-40">
            <Select
              aria-label="Filter by category"
              value={category}
              onChange={(e) => {
                setCategory(e.target.value)
                setPage(1)
              }}
            >
              <option value="all">All categories</option>
              {CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </div>
          <div className="w-full sm:w-40">
            <Select
              aria-label="Filter by stock status"
              value={stock}
              onChange={(e) => {
                setStock(e.target.value as StockFilter)
                setPage(1)
              }}
            >
              <option value="all">All stock levels</option>
              <option value="healthy">Healthy</option>
              <option value="low">Low stock</option>
              <option value="stockout">Stockout risk</option>
            </Select>
          </div>
          <div className="w-full sm:w-40">
            <Select
              aria-label="Filter by expiry"
              value={expiry}
              onChange={(e) => {
                setExpiry(e.target.value as ExpiryFilter)
                setPage(1)
              }}
            >
              <option value="all">All expiry</option>
              <option value="expiring">Expiring or expired</option>
              <option value="expired">Expired</option>
              <option value="ok">Not expiring soon</option>
              <option value="none">No expiry date</option>
            </Select>
          </div>
          {hasFilters ? (
            <Button variant="ghost" onClick={clearFilters}>
              <X aria-hidden="true" />
              Clear
            </Button>
          ) : null}
        </div> : null}

        {selected.size > 0 ? (
          <div className="animate-in fade-in flex flex-wrap items-center gap-3 border-b border-border bg-primary-soft px-4 py-2 text-sm duration-150" role="status">
            <span className="font-medium text-primary">{fmtInt(selected.size)} selected</span>
            <IconButton
              label={`Delete ${selected.size} selected ${selected.size === 1 ? 'product' : 'products'}`}
              onClick={() => setDeleteOpen(true)}
              className="text-danger-text hover:bg-danger-soft hover:text-danger-text focus-visible:ring-danger"
            >
              <Trash2 />
            </IconButton>
            <Popover
              label="Bulk actions"
              trigger={(p) => (
                <Button {...p} variant="outline" size="sm">
                  <ListChecks aria-hidden="true" />
                  Bulk actions
                </Button>
              )}
            >
              {(close) => (
                <div className="p-1">
                  <MenuItem
                    onClick={() => {
                      close()
                      setEditOpen(true)
                    }}
                  >
                    Edit category, unit or reorder point
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      close()
                      exportCsv(selectedRows, 'stocksense-selected.csv')
                    }}
                  >
                    Export selected
                  </MenuItem>
                  <MenuItem
                    danger
                    onClick={() => {
                      close()
                      setDeleteOpen(true)
                    }}
                  >
                    Delete selected
                  </MenuItem>
                </div>
              )}
            </Popover>
            <button type="button" onClick={() => setSelected(new Set())} className="rounded text-sm font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
              Clear selection
            </button>
          </div>
        ) : null}

        {rows.length === 0 ? (
          <EmptyState
            title="No products yet"
            description="Add your first products to start tracking stock, expiry dates and reorder needs."
            action={
              <Button size="lg" onClick={() => openBulk()}>
                <Plus aria-hidden="true" />
                Add Products
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="No products match these filters"
            description="Try a different search term or clear the filters to see every product."
            action={
              <Button variant="outline" size="lg" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <>
            <InventoryTable
              rows={pageRows}
              visible={columns}
              dense={dense}
              selected={selected}
              sort={sort}
              onSort={onSort}
              onToggle={toggle}
              onTogglePage={togglePage}
              onOpen={openProduct}
              onStock={openMovement}
              onDuplicate={duplicate}
              editMode={inlineEdit}
              onUpdate={updateInline}
            />
            <Pagination page={safePage} pageSize={pageSize} total={filtered.length} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1) }} />
          </>
        )}
      </Panel>

      {editOpen ? (
        <BulkEditModal
          count={selected.size}
          onClose={() => setEditOpen(false)}
          onApply={async (patch) => {
            try {
              await updateProducts([...selected], patch)
              toast(`Updated ${fmtInt(selected.size)} products.`)
              setEditOpen(false)
            } catch (error) { toast(error instanceof Error ? error.message : 'Could not update products.', 'error') }
          }}
        />
      ) : null}

      {deleteOpen ? (
        <Modal
          open
          onClose={() => setDeleteOpen(false)}
          title={`Delete ${fmtInt(selected.size)} ${selected.size === 1 ? 'product' : 'products'}?`}
          description="The selected products and batches will move to the Recycle Bin for 7 days. Past movement history is kept."
          size="sm"
          footer={
            <>
              <Button variant="outline" size="lg" onClick={() => setDeleteOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="lg"
                onClick={async () => {
                  const n = selected.size
                  try {
                    await deleteProducts([...selected])
                    setSelected(new Set())
                    setDeleteOpen(false)
                    toast(`Moved ${fmtInt(n)} ${n === 1 ? 'product' : 'products'} to the Recycle Bin.`)
                  } catch (error) { toast(error instanceof Error ? error.message : 'Could not delete products.', 'error') }
                }}
              >
                Delete
              </Button>
            </>
          }
        >
          <ul className="max-h-40 list-disc overflow-y-auto pl-4 text-sm text-foreground">
            {selectedRows.slice(0, 8).map((r) => (
              <li key={r.product.id}>
                {r.product.name} <span className="text-muted-foreground">({fmtInt(r.m.stock)} {r.product.unit} on hand)</span>
              </li>
            ))}
            {selectedRows.length > 8 ? <li className="text-muted-foreground">and {selectedRows.length - 8} more</li> : null}
          </ul>
        </Modal>
      ) : null}
    </>
  )
}

function MenuItem({ children, onClick, checked, danger }: { children: React.ReactNode; onClick: () => void; checked?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted',
        checked && 'font-medium text-primary',
        danger ? 'text-danger-text' : 'text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function BulkEditModal({ count, onClose, onApply }: { count: number; onClose: () => void; onApply: (patch: { category?: string; unit?: string; reorderPoint?: number }) => void }) {
  const [category, setCategory] = useState('')
  const [unit, setUnit] = useState('')
  const [reorder, setReorder] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const patch: { category?: string; unit?: string; reorderPoint?: number } = {}
    if (category) patch.category = category
    if (unit) patch.unit = unit
    if (reorder.trim() !== '') {
      const n = Number(reorder)
      if (!Number.isFinite(n) || n < 0) {
        setError('Enter 0 or more.')
        return
      }
      patch.reorderPoint = n
    }
    if (!Object.keys(patch).length) {
      setError('Choose at least one field to change.')
      return
    }
    onApply(patch)
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${fmtInt(count)} ${count === 1 ? 'product' : 'products'}`}
      description="Only the fields you change are applied. Stock quantities are not affected."
      size="sm"
      footer={
        <>
          <Button variant="outline" size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button size="lg" type="submit" form="bulk-edit-form">
            Apply changes
          </Button>
        </>
      }
    >
      <form id="bulk-edit-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Category" htmlFor="be-cat">
          <Select id="be-cat" value={category} onChange={(e) => { setCategory(e.target.value); setError(null) }}>
            <option value="">Keep current</option>
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Field>
        <Field label="Unit" htmlFor="be-unit">
          <Select id="be-unit" value={unit} onChange={(e) => { setUnit(e.target.value); setError(null) }}>
            <option value="">Keep current</option>
            {UNITS.map((u) => (
              <option key={u}>{u}</option>
            ))}
          </Select>
        </Field>
        <Field label="Reorder point" htmlFor="be-rp" error={error}>
          <TextInput id="be-rp" inputMode="decimal" placeholder="Keep current" value={reorder} onChange={(e) => { setReorder(e.target.value); setError(null) }} className="tabular" />
        </Field>
      </form>
    </Modal>
  )
}
