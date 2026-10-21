import { parseCsv } from '@/lib/csv'
import { parseBulkGrid } from '@/components/bulk/bulk-logic'
import type { BulkSeed } from '@/lib/ui'

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10)
  return String(value).trim()
}

/** Read CSV or the first worksheet in an XLSX file into the existing bulk-entry flow. */
export async function readBulkImportFile(file: File): Promise<BulkSeed[]> {
  const name = file.name.toLowerCase()
  let grid: string[][]

  if (name.endsWith('.csv')) {
    grid = parseCsv(await file.text())
  } else if (name.endsWith('.xlsx')) {
    const { readSheet } = await import('read-excel-file/browser')
    const rows = await readSheet(file)
    grid = rows.map((row) => row.map(cellText))
  } else {
    throw new Error('Choose a CSV (.csv) or Excel workbook (.xlsx) file.')
  }

  const seeds = parseBulkGrid(grid)
  if (!seeds.length) throw new Error('No import rows found. Add product data below the header row and try again.')
  return seeds
}
