export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows
    .map((r) =>
      r
        .map((cell) => {
          const s = cell === null || cell === undefined ? '' : String(cell)
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
        })
        .join(','),
    )
    .join('\n')
}

export function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]) {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell.length || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

export const BULK_TEMPLATE_HEADERS = [
  'Product Name',
  'SKU',
  'Category',
  'Unit',
  'Initial Quantity',
  'Reorder Point',
  'Supplier',
  'Batch Number',
  'Expiry Date',
]

export function getBulkSampleRows(now = new Date()): (string | number)[][] {
  const expiryAfter = (days: number) => {
    const date = new Date(now)
    date.setDate(date.getDate() + days)
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }

  return [
    ['Strawberry Juice', 'P002', 'Beverages', 'L', 50, 1, 'FL-B02', '25', expiryAfter(1)],
    ['Cola', 'P003', 'Beverages', 'L', 50, 2, 'FL-B02', '26', expiryAfter(5)],
    ['Orange Soda', 'P004', 'Beverages', 'L', 75, 10, 'FL-B02', '27', expiryAfter(30)],
  ]
}
