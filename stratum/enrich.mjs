// SPDX-License-Identifier: MIT
/**
 * Stratum enrich — reads SoulSync SQLite DB → pushes enriched data to D1
 *
 * Usage:
 *   node enrich.mjs [--dry-run]
 *
 * Env vars:
 *   SOULSYNC_DB      path to SoulSync music_library.db (default: /mnt/data/soulsync/music_library.db)
 *   CF_ACCOUNT_ID    (default: YOUR-CF-ACCOUNT-ID)
 *   CF_API_TOKEN     wrangler oauth token or API token with d1:write
 *   D1_DATABASE_ID   (default: YOUR-D1-DATABASE-ID)
 */

import Database from 'better-sqlite3';

const SOULSYNC_DB = process.env.SOULSYNC_DB ?? '/mnt/data/soulsync/music_library.db';
const CF_ACCOUNT  = process.env.CF_ACCOUNT_ID    ?? 'YOUR-CF-ACCOUNT-ID';
const CF_TOKEN    = process.env.CF_API_TOKEN;
const D1_ID       = process.env.D1_DATABASE_ID   ?? 'YOUR-D1-DATABASE-ID';
const DRY_RUN     = process.argv.includes('--dry-run');

if (!CF_TOKEN) { console.error('CF_API_TOKEN required'); process.exit(1); }

// ── D1 ───────────────────────────────────────────────────────────────────────

async function d1(sql, params = []) {
  if (DRY_RUN) { console.log('[D1]', sql.slice(0, 80), params.slice(0, 3)); return; }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/d1/database/${D1_ID}/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }) }
  );
  const data = await res.json();
  if (!data.success) throw new Error(`D1: ${JSON.stringify(data.errors)}`);
  return data.result?.[0];
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Reading SoulSync DB: ${SOULSYNC_DB}${DRY_RUN ? ' [DRY RUN]' : ''}`);

  const db = new Database(SOULSYNC_DB, { readonly: true });

  // ── Artists ───────────────────────────────────────────────────────────────
  const artists = db.prepare('SELECT * FROM artists').all();
  console.log(`${artists.length} artists`);

  for (const a of artists) {
    await d1(`
      UPDATE artists SET
        aliases          = ?,
        bio              = ?,
        members          = ?,
        external_urls    = ?,
        genres           = ?,
        style            = ?,
        mood             = ?,
        deezer_id        = ?,
        itunes_id        = ?,
        discogs_id       = ?,
        lastfm_listeners = ?,
        lastfm_playcount = ?,
        lastfm_tags      = ?,
        lastfm_bio       = ?,
        lastfm_similar   = ?,
        mbz_artist_id    = ?,
        soul_id          = ?
      WHERE id = ?`,
      [
        a.aliases,
        a.discogs_bio ?? a.lastfm_bio ?? a.genius_description,
        a.discogs_members,
        a.discogs_urls,
        a.lastfm_tags,
        a.style,
        a.mood,
        a.deezer_id ? String(a.deezer_id) : null,
        a.itunes_artist_id ? String(a.itunes_artist_id) : null,
        a.discogs_id ? String(a.discogs_id) : null,
        a.lastfm_listeners,
        a.lastfm_playcount,
        a.lastfm_tags,
        a.lastfm_bio,
        a.lastfm_similar,
        a.musicbrainz_id,
        a.soul_id,
        a.id,
      ]
    );
    console.log(`  artist: ${a.name}`);
  }

  // ── Albums ────────────────────────────────────────────────────────────────
  const albums = db.prepare('SELECT * FROM albums').all();
  console.log(`${albums.length} albums`);

  for (const a of albums) {
    await d1(`
      UPDATE albums SET
        mbz_release_id       = ?,
        deezer_id            = ?,
        itunes_id            = ?,
        discogs_id           = ?,
        genres               = ?,
        styles               = ?,
        label                = ?,
        release_date         = ?,
        discogs_rating       = ?,
        discogs_rating_count = ?,
        explicit             = ?,
        record_type          = ?,
        lastfm_listeners     = ?,
        lastfm_playcount     = ?,
        lastfm_tags          = ?,
        soul_id              = ?
      WHERE id = ?`,
      [
        a.musicbrainz_release_id,
        a.deezer_id ? String(a.deezer_id) : null,
        a.itunes_album_id ? String(a.itunes_album_id) : null,
        a.discogs_id,
        a.discogs_genres,
        a.discogs_styles,
        a.label ?? a.discogs_label,
        a.release_date,
        a.discogs_rating,
        a.discogs_rating_count,
        a.explicit ?? 0,
        a.record_type,
        a.lastfm_listeners,
        a.lastfm_playcount,
        a.lastfm_tags,
        a.soul_id,
        a.id,
      ]
    );
    console.log(`  album: ${a.title}`);
  }

  // ── Tracks ────────────────────────────────────────────────────────────────
  const tracks = db.prepare('SELECT * FROM tracks').all();
  console.log(`${tracks.length} tracks`);

  for (const t of tracks) {
    await d1(`
      UPDATE tracks SET
        mbz_recording_id = ?,
        deezer_id        = ?,
        itunes_id        = ?,
        bpm              = ?,
        explicit         = ?,
        isrc             = ?,
        lyrics           = ?,
        genius_url       = ?,
        lastfm_listeners = ?,
        lastfm_playcount = ?,
        lastfm_tags      = ?,
        soul_id          = ?
      WHERE id = ?`,
      [
        t.musicbrainz_recording_id,
        t.deezer_id ? String(t.deezer_id) : null,
        t.itunes_track_id ? String(t.itunes_track_id) : null,
        t.bpm,
        t.explicit ?? 0,
        t.isrc,
        t.genius_lyrics,
        t.genius_url,
        t.lastfm_listeners,
        t.lastfm_playcount,
        t.lastfm_tags,
        t.soul_id,
        t.id,
      ]
    );
    console.log(`  track: ${t.title}`);
  }

  db.close();
  console.log('\nEnrichment sync done.');
}

main().catch(err => { console.error(err); process.exit(1); });
