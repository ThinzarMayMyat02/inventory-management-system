'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Field, TextInput } from '@/components/ui/fields'
import { Modal } from '@/components/ui/overlay'
import { PageHeader, PageSkeleton, Panel, PanelHeader } from '@/components/page-kit'
import { useStore } from '@/lib/store'
import { useUI } from '@/lib/ui'
import { DEFAULT_SETTINGS, type Settings } from '@/lib/types'

const FIELDS: { key: keyof Settings; label: string; help: string; min: number; max: number }[] = [
  { key: 'expiryWindowDays', label: 'Expiry warning window (days)', help: 'Batches expiring within this many days are flagged as expiring soon.', min: 1, max: 90 },
  { key: 'stockoutHorizonDays', label: 'Stockout horizon (days)', help: 'A product with fewer days of cover than this is flagged as a stockout risk.', min: 1, max: 30 },
  { key: 'targetCoverDays', label: 'Target cover for reorders (days)', help: 'Suggested reorder quantities aim to reach this many days of cover.', min: 1, max: 120 },
]

export function SettingsView() {
  const { ready, settings, updateSettings, resetDemo, exportLocalSql, localMigrationAvailable } = useStore()
  const { toast } = useUI()
  const [draft, setDraft] = useState<Record<keyof Settings, string> | null>(null)
  const [errors, setErrors] = useState<Partial<Record<keyof Settings, string>>>({})
  const [confirmReset, setConfirmReset] = useState(false)

  if (!ready) return <PageSkeleton />

  const values = draft ?? (Object.fromEntries(FIELDS.map((f) => [f.key, String(settings[f.key])])) as Record<keyof Settings, string>)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    const next: Partial<Settings> = {}
    const errs: typeof errors = {}
    for (const f of FIELDS) {
      const n = Number(values[f.key])
      if (!Number.isInteger(n) || n < f.min || n > f.max) errs[f.key] = `Enter a whole number from ${f.min} to ${f.max}.`
      else next[f.key] = n
    }
    setErrors(errs)
    if (Object.keys(errs).length) return
    try { await updateSettings(next) }
    catch (error) { toast(error instanceof Error ? error.message : 'Could not save settings.', 'error'); return }
    setDraft(null)
    toast('Settings saved. Alerts and insights now use the new thresholds.')
  }

  return (
    <>
      <PageHeader title="Settings" description="Thresholds used to flag risks and suggest reorders."
        actions={localMigrationAvailable ? <Button variant="outline" size="lg" onClick={async () => { try { await exportLocalSql(); toast('Downloaded mig.sql. Run it in the Supabase SQL Editor after schema.sql.') } catch (error) { toast(error instanceof Error ? error.message : 'Could not export local data.', 'error') } }}>Download local data SQL</Button> : undefined} />

      <div className="grid max-w-3xl gap-5">
        <Panel>
          <PanelHeader title="Alert thresholds" />
          <form onSubmit={save} className="flex flex-col gap-4 p-4" noValidate>
            {FIELDS.map((f) => (
              <Field key={f.key} label={f.label} htmlFor={`s-${f.key}`} error={errors[f.key] ?? null}>
                <TextInput
                  id={`s-${f.key}`}
                  inputMode="numeric"
                  className="tabular max-w-32"
                  value={values[f.key]}
                  onChange={(e) => setDraft({ ...values, [f.key]: e.target.value })}
                  aria-describedby={`s-${f.key}-help`}
                />
                <p id={`s-${f.key}-help`} className="mt-1 text-xs text-muted-foreground">{f.help}</p>
              </Field>
            ))}
            <div className="flex gap-2">
              <Button type="submit" size="lg">Save settings</Button>
              <Button
                type="button"
                variant="outline"
                size="lg"
                onClick={async () => {
                  try { await updateSettings(DEFAULT_SETTINGS) }
                  catch (error) { toast(error instanceof Error ? error.message : 'Could not restore defaults.', 'error'); return }
                  setDraft(null)
                  setErrors({})
                  toast('Thresholds restored to defaults.')
                }}
              >
                Restore defaults
              </Button>
            </div>
          </form>
        </Panel>

        <Panel>
          <PanelHeader title="Sample inventory" description="Supabase is the source of truth for this workspace." />
          <div className="flex flex-col items-start gap-3 p-4">
            <p className="text-sm text-muted-foreground text-pretty">
              Resetting replaces all products, batches, movements and reorder requests with the original sample data. This cannot be undone.
            </p>
            <Button variant="destructive" size="lg" onClick={() => setConfirmReset(true)}>
              Reset sample data
            </Button>
          </div>
        </Panel>
      </div>

      {confirmReset ? (
        <Modal
          open
          size="sm"
          onClose={() => setConfirmReset(false)}
          title="Reset all data?"
          description="Your changes will be replaced by the original sample data."
          footer={
            <>
              <Button variant="outline" size="lg" onClick={() => setConfirmReset(false)}>Cancel</Button>
              <Button
                variant="destructive"
                size="lg"
                onClick={async () => {
                  try { await resetDemo() }
                  catch (error) { toast(error instanceof Error ? error.message : 'Could not reset sample data.', 'error'); return }
                  setConfirmReset(false)
                  toast('Sample data restored.')
                }}
              >
                Reset
              </Button>
            </>
          }
        >
          <p className="text-sm text-muted-foreground">Settings are kept. Products, stock, movements and reorder requests are reset.</p>
        </Modal>
      ) : null}
    </>
  )
}
