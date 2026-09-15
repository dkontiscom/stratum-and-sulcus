# Stratum & Sulcus

**Stratum** is a self-hosted music server that speaks the Subsonic/OpenSubsonic API — drop-in compatible with Substreamer, Symfonium, Amperfy, DSub, and any other Subsonic client. It runs entirely on Cloudflare Workers + D1 (free tier) and streams audio directly from any S3-compatible storage.

**Sulcus** is a companion PWA (work in progress) that shows deep contextual information about the currently playing track — liner notes, personnel, annotations, mood board.

## Architecture

```
Subsonic client (Substreamer, Symfonium, …)
        │  Subsonic/OpenSubsonic API
        ▼
Stratum — Cloudflare Worker
        │  D1 (SQLite) — music library metadata
        │  Cloudflare KV — sessions
        │
        └─ 302 redirect ──▶ S3-compatible storage
                            (Garage, MinIO, R2, B2, AWS S3, …)
                            audio files at audio/Artist/Album/track.flac

Mac / Linux stack (Docker)
  slskd        — Soulseek client, downloads to staging/
  soulsync     — enriches metadata, organises to transfer/
  sync         — uploads transfer/ to S3, pushes metadata to D1
  webhook      — triggers sync automatically on soulsync batch complete
  StratumApp   — macOS menu bar app (optional convenience wrapper)
```

## Features

- Full Subsonic API v1.16.1 + OpenSubsonic extensions
- Audio served via presigned S3 URLs — Worker never proxies audio bytes
- Automatic library ingestion via Cloudflare cron (every 15 min)
- Rich metadata via soulsync: Last.fm, Discogs, Genius, AcoustID, ListenBrainz, MusicBrainz, Spotify, Tidal
- Works with any S3-compatible storage (self-hosted Garage/MinIO or managed R2/B2/S3)
- Runs on Cloudflare free tier

## Quick Start

### 1. Cloudflare Worker (Stratum)

**Prerequisites:** Cloudflare account, Wrangler CLI

```bash
cd stratum
npm install

# Create D1 database
npx wrangler d1 create stratum-db

# Apply schema
npx wrangler d1 execute stratum-db --file=schema.sql

# Edit wrangler.jsonc — fill in your database_id, S3_ENDPOINT, S3_BUCKET, S3_REGION
cp wrangler.example.jsonc wrangler.jsonc
# edit wrangler.jsonc

# Set secrets (never stored in wrangler.jsonc)
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put S3_ACCESS_KEY
npx wrangler secret put S3_SECRET_KEY

# Deploy
npx wrangler deploy
```

Connect any Subsonic client to `https://your-worker.workers.dev`, user `admin`, your password.

### 2. Docker Stack

**Prerequisites:** Docker, Docker Compose

```bash
cd stack
cp .env.example .env
# edit .env — fill in your S3 credentials, Cloudflare tokens, metadata API keys

cp config/soulsync/config.example.json config/soulsync/config.json
# edit config/soulsync/config.json — fill in your Stratum URL + password, slskd URL

docker compose up -d
```

Access soulsync at `http://localhost:8008`, slskd at `http://localhost:5030`.

**Automated sync:** in soulsync, go to Settings → Automations → add a Batch Complete trigger → HTTP POST to `http://webhook-receiver:9000`. Soulsync will trigger a sync automatically after each batch completes.

**Manual sync:**
```bash
docker compose --profile sync run --rm sync
```

### 3. macOS Menu Bar App (optional)

StratumApp wraps the Docker stack with a menu bar UI — start/stop, sync button, live log.

```bash
cd stack/StratumApp
open StratumApp.xcodeproj  # build with Xcode
```

Copy the built `.app` to `/Applications/`.

## S3 Storage

Any S3-compatible provider works:

| Provider | Notes |
|----------|-------|
| [Garage HQ](https://garagehq.deuxfleurs.fr/) | Self-hosted, recommended for home servers |
| [MinIO](https://min.io/) | Self-hosted, widely used |
| Cloudflare R2 | Managed, free 10 GB, zero egress |
| Backblaze B2 | Managed, cheap (~$6/TB/mo) |
| AWS S3 | Managed, standard |

Set `S3_REGION` to `auto` for R2, `us-east-1` for most others, or your Garage/MinIO region name.

## GitHub Actions (auto-deploy)

Push to `main` automatically deploys the Stratum Worker. Add these secrets to your GitHub repository (Settings → Secrets and variables → Actions):

| Secret | Description |
|--------|-------------|
| `CF_API_TOKEN` | Cloudflare API token — needs *Workers Scripts: Edit* + *D1: Edit* permissions |
| `CF_ACCOUNT_ID` | Your Cloudflare account ID (Workers dashboard → right sidebar) |
| `STRATUM_ADMIN_PASSWORD` | Password for the `admin` user on your Stratum Worker |
| `S3_ACCESS_KEY` | S3-compatible storage access key |
| `S3_SECRET_KEY` | S3-compatible storage secret key |

Non-sensitive config (`S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, D1 database ID) lives in `wrangler.jsonc` — copy from `wrangler.example.jsonc` and fill in your values. `wrangler.jsonc` is gitignored and stays local.

## Project Status

Stratum Worker: functional, Subsonic + OpenSubsonic compliant  
Docker stack: functional  
StratumApp: functional (macOS)  
Sulcus PWA: not yet implemented

## License

MIT
