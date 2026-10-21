# Supabase setup

1. Open the Supabase project SQL Editor and run [`schema.sql`](./schema.sql) once.
2. Copy `.env.example` to `.env.local`. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` from the Supabase project API settings, then restart Next.js.
3. Open the app and create the admin account. The database trigger creates a private workspace and default settings. The first app load initializes the sample inventory only if the workspace is empty.
4. To preserve data from the old browser-only version, sign in and open Settings. If the browser has a localStorage snapshot, choose **Download local data SQL** once. Run the downloaded `mig.sql` in the Supabase SQL Editor. It replaces the current workspace’s data with that browser’s localStorage snapshot, including sample data if that is what the browser currently contains. The app hides this one-time action after the download to reduce the risk of replacing later Supabase changes with an old snapshot.

The anon/publishable key is safe for the browser when Row Level Security is enabled. Never put a Supabase service-role key in `NEXT_PUBLIC_*` variables.
