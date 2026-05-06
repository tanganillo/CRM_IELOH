# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install dependencies
npm run dev          # start local server at localhost:8888 via netlify dev
npm run lint         # eslint on functions and lib
```

To test a function locally hit `http://localhost:8888/api/<name>` or `http://localhost:8888/webhook`.

There are no automated tests. Validate by calling the functions directly.

## Architecture

The project is a serverless CRM for IELOH, an ice factory. All backend logic lives in **Netlify Functions** (`netlify/functions/`); the frontend is a static single-page dashboard (`src/`). The PWA for delivery drivers is at `src/repartidor.html`.

### Request flow

```
WhatsApp → POST /webhook → whatsapp-webhook.js
                               ├── lib/whatsapp.js   (parse incoming, send replies)
                               ├── lib/claude.js     (NLP intent classification)
                               └── lib/supabase.js   (read/write DB)

Dashboard SPA (admin) → /api/* → orders.js / clients.js / catalog.js / dashboard.js
                               └── lib/supabase.js

Repartidor PWA        → /api/repartidores   → repartidores.js
                      → /api/location-update → location-update.js  (GPS cada 30s)
                      → /api/orders          → orders.js (ver y actualizar estado)

Dashboard: notificar cercano → /api/nearby-delivery → nearby-delivery.js
                                                           └── Nominatim geocoding
                                                           └── haversine distance
                                                           └── lib/whatsapp.js (notify)

Cron (8am ART)  → broadcast.js     → lib/supabase.js + lib/whatsapp.js
Cron (1ro mes)  → archive-orders.js → lib/supabase.js + lib/sheets.js → Sheets "Archivo"
POST /api/sync-sheets → sync-sheets.js → lib/supabase.js + lib/sheets.js
```

### Auth (Google OAuth via Supabase)

The dashboard (`index.html`) requires Google login. Auth is handled client-side:
1. `app.js` calls `/api/config` to get `SUPABASE_URL` + `SUPABASE_ANON_KEY`
2. Initializes `@supabase/supabase-js` (CDN) and calls `auth.onAuthStateChange`
3. `signInWithOAuth({ provider: 'google' })` redirects to Google, then back
4. On return, session is stored in `localStorage` by Supabase SDK automatically

Supabase setup required:
- Dashboard → Authentication → Providers → Google → enable + paste Client ID/Secret
- Dashboard → Authentication → URL Configuration → add `https://crm-ieloh.netlify.app` to redirect URLs

### Repartidor PWA (`/repartidor.html`)

- Mobile-first app for delivery drivers — no login required
- Drivers identify by entering their repartidor ID (1–4), stored in `localStorage`
- GPS tracked via `navigator.geolocation.watchPosition`, POSTed to `/api/location-update` every 30s (throttled)
- Shows all `pendiente` and `confirmado` orders; drivers can mark as `en_camino` and `entregado`
- Service worker (`service-worker.js`) caches the app for offline use

### Conversation logic (`whatsapp-webhook.js`)

Short-circuit keywords (`catalogo`, `estado`, `hola`, etc.) are handled before calling Claude to reduce latency. For everything else, `lib/claude.js` returns a structured JSON with an `intent` field:

| intent | action |
|--------|--------|
| `catalogo` | send interactive list |
| `nuevo_pedido` | store draft in `sessions{}`, send confirmation buttons |
| `confirmacion_pedido` | write order to Supabase, clear session |
| `consultar_estado` | fetch last 5 orders, send text |
| `otro` / `saludo` | relay Claude's `message` field as-is |

`sessions` is a module-level object — it persists across warm invocations of the same function instance but is lost on cold starts. This is intentional and acceptable for short-lived order flows.

### Claude integration (`lib/claude.js`)

`processMessage` injects live catalog and last-3-orders history into the system prompt before every call. The model is always `claude-sonnet-4-6`. The response is expected to be JSON; a regex fallback extracts it if Claude wraps it in prose.

### Data model

- `clientes`: WhatsApp contacts (telefono, nombre, direccion)
- `catalogo`: ice products (nombre, descripcion, precio, disponible)
- `pedidos`: orders with JSONB `items: [{ nombre, cantidad, precio }]`
  - `estado` CHECK: `pendiente → confirmado → en_camino → entregado | cancelado`
  - `archived BOOLEAN`: set to true after 90-day archiving (records kept for audit)
- `repartidores`: delivery drivers (nombre, telefono, camioneta, turno, latitud, longitud, disponible, pedidos_del_dia, ultima_actualizacion)
  - `camioneta` CHECK: `camioneta_1 | camioneta_2`
  - `turno` CHECK: `manana | tarde`

All functions use the **service_role** Supabase key (bypasses RLS). The frontend uses `SUPABASE_ANON_KEY` only for auth.

### Nearby delivery logic (`nearby-delivery.js`)

1. Fetches the pedido + client address
2. Geocodes address via Nominatim (free OSM API) — `countrycodes=ar` for accuracy
3. Finds `disponible=true` repartidores with GPS updated within last 15 minutes
4. Calculates haversine distance for each
5. If nearest is ≤ 5 km, sends WhatsApp notification with Google Maps link
6. Dashboard shows 📍 button on pending/confirmed orders to trigger this manually

### Google Sheets sync

`lib/sheets.js` authenticates via a Service Account JSON stored entirely in the `GOOGLE_SERVICE_ACCOUNT_KEY` env var.
- `syncOrdersToSheet` / `syncClientsToSheet`: overwrite `Pedidos!A:G` and `Clientes!A:E`
- `appendArchivedOrders`: **appends** to `Archivo!A:H` (never overwrites — preserves history)

### Scheduled functions

`netlify.toml` defines two schedules:
- `broadcast`: `0 11 * * *` (UTC) = 8am ART daily
- `archive-orders`: `0 10 1 * *` (UTC) = 7am ART on the 1st of each month

Both can also be triggered manually via POST to `/api/broadcast` and `/api/archive-orders`.

## Environment variables

All required vars are documented in `.env.example`. For local dev, copy to `.env` — `netlify dev` loads it automatically.

| Variable | Description |
|----------|-------------|
| `WHATSAPP_TOKEN` | Permanent WhatsApp Cloud API token |
| `WHATSAPP_PHONE_NUMBER_ID` | Phone number ID from Meta |
| `WHATSAPP_VERIFY_TOKEN` | Custom string for webhook verification (must match Meta config) |
| `ANTHROPIC_API_KEY` | Claude API key |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SECRET_KEY` | service_role key (server-side only) |
| `SUPABASE_ANON_KEY` | anon/public key (safe for frontend, used for auth only) |
| `GOOGLE_SHEET_ID` | Google Sheets document ID |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Full JSON of service account credentials |
| `APP_URL` | Deployed Netlify URL |

## Deployment checklist (first time)

1. Push to GitHub → connect repo in Netlify → set build command to `echo ok`, publish dir to `src`
2. Add all env vars in Netlify → Site settings → Environment variables
3. Add `SUPABASE_ANON_KEY` to env vars (get from Supabase → Settings → API)
4. Configure Supabase Auth: enable Google provider, add Netlify URL to redirect URLs
5. Run `supabase/schema.sql` in Supabase SQL editor
6. Update repartidores table with real names and phones
7. Register webhook in Meta Developers: URL = `https://crm-ieloh.netlify.app/webhook`, verify token = `WHATSAPP_VERIFY_TOKEN`
8. Create a "Archivo" sheet in the Google Spreadsheet (for the archive function)
