import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { readFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'

function readEnvValue(source, name) {
  const match = source.match(new RegExp(`^${name}=(.*)$`, 'm'))
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? ''
}

function readHidden(label) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('Run this script in an interactive terminal so secrets stay hidden.')
  }
  stdout.write(label)
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  return new Promise((resolve, reject) => {
    let value = ''
    const finish = (error) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      stdout.write('\n')
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\u0003') return finish(new Error('Cancelled.'))
        if (char === '\r' || char === '\n') return finish()
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1)
          stdout.write('\b \b')
        } else {
          value += char
          stdout.write('*')
        }
      }
    }
    stdin.on('data', onData)
  })
}

const env = await readFile('.env.local', 'utf8')
const url = readEnvValue(env, 'NEXT_PUBLIC_SUPABASE_URL')
if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is missing from .env.local.')

const rl = createInterface({ input: stdin, output: stdout })
try {
  const email = (await rl.question('Account email to reset: ')).trim().toLowerCase()
  rl.close()
  if (!email) throw new Error('Enter the account email.')
  const serviceKey = (await readHidden('Supabase service-role/secret key (hidden): ')).trim()
  const password = await readHidden('New password (hidden, at least 6 characters): ')
  if (password.length < 6) throw new Error('Supabase passwords must be at least 6 characters.')

  const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (error) throw error
  const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email)
  if (!user) throw new Error(`No Auth user found for ${email}.`)
  const result = await supabase.auth.admin.updateUserById(user.id, { password })
  if (result.error) throw result.error
  stdout.write(`Password updated for ${email}. You can now sign in to the app.\n`)
} finally {
  rl.close()
}
