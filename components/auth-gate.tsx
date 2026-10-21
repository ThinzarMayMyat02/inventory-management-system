'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Boxes } from 'lucide-react'
import { useStore } from '@/lib/store'
import { Button } from '@/components/ui/button'

export function AuthGate() {
  const { authEnabled, authError, signIn, signUp } = useStore()
  const router = useRouter()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage('')
    try {
      if (mode === 'signin') { await signIn(email, password); router.replace('/dashboard') }
      else { await signUp(email, password); setMessage('Account created. Confirm your email if prompted, then sign in.') }
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Authentication failed.') }
    finally { setBusy(false) }
  }

  return <main className="grid min-h-screen place-items-center bg-background px-4 py-10">
    <section className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-sm">
      <div className="mb-6 flex items-center gap-3"><span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground"><Boxes className="size-5" /></span><div><h1 className="text-lg font-semibold">StockSense AI</h1><p className="text-sm text-muted-foreground">{authEnabled ? 'Sign in to your inventory workspace' : 'Connect your Supabase project to continue'}</p></div></div>
      {!authEnabled ? <div className="space-y-4 text-sm text-muted-foreground"><p>Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and the Supabase publishable/anon key in <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>. Do not put a secret/service-role key in a <code>NEXT_PUBLIC_</code> variable. Then restart the app.</p><p>Your existing browser inventory remains in localStorage and can be exported after connecting and signing in.</p></div> : <>
        <form className="space-y-4" onSubmit={submit}>
          <label className="block text-sm font-medium">Email<input required type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 h-10 w-full rounded-lg border border-input bg-background px-3" /></label>
          <label className="block text-sm font-medium">Password<input required minLength={6} type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 h-10 w-full rounded-lg border border-input bg-background px-3" /></label>
          {(message || authError) && <p role="alert" className="text-sm text-danger-text">{message || authError}</p>}
          <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create admin account'}</Button>
        </form>
        <button type="button" className="mt-4 w-full text-center text-sm text-primary hover:underline" onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setMessage('') }}>{mode === 'signin' ? 'First time? Create your admin account' : 'Already have an account? Sign in'}</button>
      </>}
    </section>
  </main>
}
