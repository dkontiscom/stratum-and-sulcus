/**
 * sync.mjs — soulsync DB → Garage S3 + Cloudflare D1
 * Runs inside Docker. Triggered by the Mac app on demand.
 *
 * Env vars (set in docker-compose):
 *   CF_API_TOKEN, CF_ACCOUNT, D1_DATABASE_ID
 *   S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY
 *   MUSIC_DIR   — path to organized music inside container (default: /music)
 *   SOULSYNC_DB — path to soulsync DB inside container (default: /soulsync/music_library.db)
 */

import Database from 'better-sqlite3';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createReadStream, statSync, readdirSync, rmSync } from 'fs';
import { join, relative } from 'path';
import crypto from 'crypto';

const SOULSYNC_DB  = process.env.SOULSYNC_DB  ?? '/soulsync/music_library.db';
const MUSIC_DIR    = process.env.MUSIC_DIR    ?? '/music';

const S3_ENDPOINT = process.env.S3_ENDPOINT ;
const S3_BUCKET   = process.env.S3_BUCKET   ?? 'stratum-audio';
const S3_REGION   = process.env.S3_REGION   ?? 'garage';
const S3_ACCESS_KEY   = process.env.S3_ACCESS_KEY;
const S3_SECRET_KEY   = process.env.S3_SECRET_KEY;

const CF_ACCOUNT      = process.env.CF_ACCOUNT;
const CF_API_TOKEN    = process.env.CF_API_TOKEN;
const D1_DATABASE_ID  = process.env.D1_DATABASE_ID;

const DRY_RUN = process.argv.includes('--dry-run');

for (const [k, v] of Object.entries({ CF_ACCOUNT, CF_API_TOKEN, D1_DATABASE_ID, S3_ACCESS_KEY, S3_SECRET_KEY })) {
  if (!v) { console.error('Missing env var: ' + k); process.exit(1); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeId(str) {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 24);
}

async function d1Batch(statements) {
  if (DRY_RUN) { console.log('[dry-run] D1 batch: ' + statements.length + ' statements'); return; }
  for (const stmt of statements) {
    const res = await fetch(
      'https://api.cloudflare.com/client/v4/accounts/' + CF_ACCOUNT + '/d1/database/' + D1_DATABASE_ID + '/query',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + CF_API_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: stmt.sql, params: stmt.params }),
      }
    );
    const j = await res.json();
    if (!res.ok || !j.success) throw new Error('D1 error: ' + JSON.stringify(j.errors));
  }
}

async function d1Query(sql) {
  if (DRY_RUN) { console.log('[dry-run] D1: ' + sql.slice(0, 80)); return; }
  const res = await fetch(
    'https://api.cloudflare.com/client/v4/accounts/' + CF_ACCOUNT + '/d1/database/' + D1_DATABASE_ID + '/query',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + CF_API_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql }),
    }
  );
  const j = await res.json();
  if (!res.ok || !j.success) throw new Error('D1 error: ' + JSON.stringify(j.errors));
}

// ── Step 1: Sync audio files → Garage S3 ─────────────────────────────────────

async function syncFiles() {
  const s3 = new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
    forcePathStyle: true,
  });

  const audioExts = new Set(['.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wav']);
  const mimeMap = { flac:'audio/flac', mp3:'audio/mpeg', m4a:'audio/mp4',
                    aac:'audio/aac', ogg:'audio/ogg', opus:'audio/opus', wav:'audio/wav' };

  function* walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) yield* walk(full);
      else {
        const ext = e.name.slice(e.name.lastIndexOf('.')).toLowerCase();
        if (audioExts.has(ext)) yield { full, ext };
      }
    }
  }

  let uploaded = 0, skipped = 0, errors = 0;
  for (const { full, ext } of walk(MUSIC_DIR)) {
    const rel = relative(MUSIC_DIR, full);
    const key = 'audio/' + rel;

    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
      const localSize = statSync(full).size;
      if (head.ContentLength === localSize) {
        skipped++;
        if (!DRY_RUN) rmSync(full);
        continue;
      }
    } catch (_) {}

    if (DRY_RUN) { console.log('  [dry-run] upload: ' + key); uploaded++; continue; }

    try {
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET, Key: key,
        Body: createReadStream(full),
        ContentType: mimeMap[ext.slice(1)] ?? 'audio/mpeg',
        ContentLength: statSync(full).size,
      }));
      const verify = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
      const localSize = statSync(full).size;
      if (verify.ContentLength !== localSize) {
        console.error('  x ' + key + ': size mismatch after upload');
        errors++;
      } else {
        console.log('  + ' + key);
        uploaded++;
        if (!DRY_RUN) rmSync(full);
      }
    } catch (e) {
      console.error('  x ' + key + ': ' + e.message);
      errors++;
    }
  }
  return { uploaded, skipped, errors };
}

// ── Step 2: Sync cover art → Garage S3 + D1 ──────────────────────────────────

async function syncCoverArt() {
  const s3 = new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
    forcePathStyle: true,
  });

  const coverNames = new Set(['cover.jpg','cover.jpeg','cover.png','cover.webp',
                               'folder.jpg','folder.jpeg','folder.png',
                               'front.jpg','front.jpeg','artwork.jpg','artwork.jpeg']);
  const imgMime = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp' };

  let uploaded = 0, skipped = 0, d1Updates = 0;

  let artistDirs;
  try { artistDirs = readdirSync(MUSIC_DIR, { withFileTypes: true }).filter(e => e.isDirectory()); }
  catch (_) { return { uploaded: 0, skipped: 0, d1Updates: 0 }; }

  for (const artistDir of artistDirs) {
    const artistPath = join(MUSIC_DIR, artistDir.name);
    let albumDirs;
    try { albumDirs = readdirSync(artistPath, { withFileTypes: true }).filter(e => e.isDirectory()); }
    catch (_) { continue; }

    for (const albumDir of albumDirs) {
      const albumPath = join(artistPath, albumDir.name);
      let files;
      try { files = readdirSync(albumPath); } catch (_) { continue; }

      const garageKey = 'audio/' + artistDir.name + '/' + albumDir.name + '/cover.jpg';
      const albumId = makeId(artistDir.name + '::' + albumDir.name);

      const coverFile = files.find(f => coverNames.has(f.toLowerCase()));
      if (coverFile) {
        // Upload local cover file
        const localPath = join(albumPath, coverFile);
        const ext = coverFile.split('.').pop().toLowerCase();
        const mime = imgMime[ext] ?? 'image/jpeg';

        try {
          const head = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: garageKey }));
          if (head.ContentLength === statSync(localPath).size) { skipped++; continue; }
        } catch (_) {}

        if (DRY_RUN) { console.log('  [dry-run] cover: ' + garageKey); uploaded++; continue; }

        try {
          await s3.send(new PutObjectCommand({
            Bucket: S3_BUCKET, Key: garageKey,
            Body: createReadStream(localPath),
            ContentType: mime,
            ContentLength: statSync(localPath).size,
          }));
          console.log('  + cover (local): ' + garageKey);
          uploaded++;
          await d1Batch([{ sql: 'UPDATE albums SET cover_art_key = ? WHERE id = ?', params: [garageKey, albumId] }]);
          d1Updates++;
        } catch (e) {
          console.error('  x cover ' + garageKey + ': ' + e.message);
        }
      } else {
        // No local file — check if Garage already has it
        try {
          await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: garageKey }));
          // Already in Garage — just ensure D1 is updated
          await d1Batch([{ sql: "UPDATE albums SET cover_art_key = ? WHERE id = ? AND (cover_art_key IS NULL OR cover_art_key = '')", params: [garageKey, albumId] }]);
          skipped++;
          continue;
        } catch (_) {}

        // Fall back: download thumb_url from soulsync CDN and upload to Garage
        if (DRY_RUN) continue;
        try {
          const albumRow = await (async () => {
            const res = await fetch(
              'https://api.cloudflare.com/client/v4/accounts/' + process.env.CF_ACCOUNT + '/d1/database/' + process.env.D1_DATABASE_ID + '/query',
              { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.CF_API_TOKEN, 'Content-Type': 'application/json' },
                body: JSON.stringify({ sql: 'SELECT thumb_url FROM albums WHERE id = ? AND thumb_url IS NOT NULL AND cover_art_key IS NULL', params: [albumId] }) }
            );
            const j = await res.json();
            return j?.result?.[0]?.results?.[0] ?? null;
          })();
          if (!albumRow?.thumb_url) continue;

          const imgRes = await fetch(albumRow.thumb_url);
          if (!imgRes.ok) continue;
          const buf = await imgRes.arrayBuffer();
          await s3.send(new PutObjectCommand({
            Bucket: S3_BUCKET, Key: garageKey,
            Body: Buffer.from(buf),
            ContentType: 'image/jpeg',
            ContentLength: buf.byteLength,
          }));
          console.log('  + cover (cdn): ' + garageKey);
          uploaded++;
          await d1Batch([{ sql: 'UPDATE albums SET cover_art_key = ? WHERE id = ?', params: [garageKey, albumId] }]);
          d1Updates++;
        } catch (e) {
          // CDN fetch failed — not critical
        }
      }
    }
  }
  return { uploaded, skipped, d1Updates };
}

// ── Step 3: Sync soulsync DB → D1 ────────────────────────────────────────────

async function syncMetadata() {
  const db = new Database(SOULSYNC_DB, { readonly: true, fileMustExist: true });

  const migrations = [
    'ALTER TABLE tracks ADD COLUMN mood TEXT',
    'ALTER TABLE tracks ADD COLUMN style TEXT',
    'ALTER TABLE tracks ADD COLUMN genius_id TEXT',
    'ALTER TABLE tracks ADD COLUMN genius_description TEXT',
    'ALTER TABLE tracks ADD COLUMN lastfm_url TEXT',
    'ALTER TABLE albums ADD COLUMN thumb_url TEXT',
    'ALTER TABLE albums ADD COLUMN lastfm_wiki TEXT',
    'ALTER TABLE albums ADD COLUMN lastfm_url TEXT',
    'ALTER TABLE albums ADD COLUMN discogs_catno TEXT',
    'ALTER TABLE albums ADD COLUMN discogs_country TEXT',
    'ALTER TABLE albums ADD COLUMN spotify_album_id TEXT',
    'ALTER TABLE artists ADD COLUMN genius_id TEXT',
    'ALTER TABLE artists ADD COLUMN genius_description TEXT',
    'ALTER TABLE artists ADD COLUMN genius_url TEXT',
    'ALTER TABLE artists ADD COLUMN genius_alt_names TEXT',
    'ALTER TABLE artists ADD COLUMN banner_url TEXT',
    'ALTER TABLE artists ADD COLUMN discogs_bio TEXT',
    'ALTER TABLE artists ADD COLUMN discogs_urls TEXT',
    'ALTER TABLE artists ADD COLUMN lastfm_url TEXT',
    'ALTER TABLE artists ADD COLUMN summary TEXT',
  ];
  for (const sql of migrations) { try { await d1Query(sql); } catch (_) {} }

  const artists = db.prepare('SELECT id,name,thumb_url,banner_url,summary,aliases,genres,style,mood,musicbrainz_id mbz_id,deezer_id,itunes_artist_id itunes_id,discogs_id,discogs_bio,discogs_members members,discogs_urls,lastfm_listeners,lastfm_playcount,lastfm_tags,lastfm_bio,lastfm_similar,lastfm_url,genius_id,genius_description,genius_alt_names,genius_url,soul_id FROM artists').all();

  const albums = db.prepare('SELECT al.id,al.title,al.artist_id,al.year,al.release_date,al.thumb_url,al.genres,al.style,al.discogs_styles styles,al.label,al.record_type,al.explicit,al.track_count,al.duration,al.musicbrainz_release_id mbz_release_id,al.deezer_id,al.itunes_album_id itunes_id,al.discogs_id,al.discogs_catno,al.discogs_country,al.discogs_rating,al.discogs_rating_count,al.spotify_album_id,al.lastfm_listeners,al.lastfm_playcount,al.lastfm_tags,al.lastfm_wiki,al.lastfm_url,al.soul_id,ar.name artist_name FROM albums al JOIN artists ar ON ar.id=al.artist_id').all();

  const tracks = db.prepare("SELECT t.id,t.title,t.album_id,t.artist_id,t.track_number,t.disc_number,t.duration,t.bitrate,t.file_size,t.year,t.bpm,t.explicit,t.isrc,t.file_path,t.mood,t.style,t.lastfm_tags,t.lastfm_listeners,t.lastfm_playcount,t.lastfm_url,t.genius_id,t.genius_lyrics,t.genius_description,t.genius_url,t.musicbrainz_recording_id mbz_recording_id,t.deezer_id,t.itunes_track_id itunes_id,t.soul_id,ar.name artist_name,al.title album_name FROM tracks t JOIN artists ar ON ar.id=t.artist_id JOIN albums al ON al.id=t.album_id WHERE t.file_path IS NOT NULL AND t.file_path != ''''''").all();

  db.close();

  function toGarageKey(t) {
    const fp = t.file_path;
    if (!fp) return null;
    const m = fp.match(/\/(?:music|Music|Transfer|transfer)\/(.+)$/i);
    if (m) return 'audio/' + m[1];
    const artist = t.artist_name;
    const album  = t.album_name;
    const file   = fp.replace(/^\/+/, '');
    if (artist && album && artist !== 'Unknown Artist' && album !== 'Unknown Album') {
      return 'audio/' + artist + '/' + album + '/' + file;
    }
    return 'audio/' + file;
  }

  const mimeMap = { flac:'audio/flac', mp3:'audio/mpeg', m4a:'audio/mp4',
                    aac:'audio/aac', ogg:'audio/ogg', opus:'audio/opus', wav:'audio/wav' };

  async function batchUpsert(rows) {
    for (let i = 0; i < rows.length; i += 100) {
      await d1Batch(rows.slice(i, i + 100));
    }
  }

  console.log('  Artists: ' + artists.length);
  await batchUpsert(artists.map(a => ({
    sql: 'INSERT INTO artists (id,name,sort_name,biography,image_url,banner_url,summary,mbz_artist_id,aliases,genres,style,mood,deezer_id,itunes_id,discogs_id,discogs_bio,members,discogs_urls,lastfm_listeners,lastfm_playcount,lastfm_tags,lastfm_bio,lastfm_similar,lastfm_url,genius_id,genius_description,genius_alt_names,genius_url,soul_id,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime(\'now\')) ON CONFLICT(id) DO UPDATE SET name=excluded.name,biography=excluded.biography,image_url=excluded.image_url,banner_url=excluded.banner_url,summary=excluded.summary,aliases=excluded.aliases,genres=excluded.genres,style=excluded.style,mood=excluded.mood,deezer_id=excluded.deezer_id,itunes_id=excluded.itunes_id,discogs_id=excluded.discogs_id,discogs_bio=excluded.discogs_bio,members=excluded.members,discogs_urls=excluded.discogs_urls,lastfm_listeners=excluded.lastfm_listeners,lastfm_playcount=excluded.lastfm_playcount,lastfm_tags=excluded.lastfm_tags,lastfm_bio=excluded.lastfm_bio,lastfm_similar=excluded.lastfm_similar,lastfm_url=excluded.lastfm_url,genius_id=excluded.genius_id,genius_description=excluded.genius_description,genius_alt_names=excluded.genius_alt_names,genius_url=excluded.genius_url,soul_id=excluded.soul_id,updated_at=datetime(\'now\')',
    params: [makeId(a.name),a.name,a.name?.toLowerCase(),a.lastfm_bio??a.summary,a.thumb_url,a.banner_url,a.summary,a.mbz_id,a.aliases,a.genres,a.style,a.mood,a.deezer_id,a.itunes_id,a.discogs_id,a.discogs_bio,a.discogs_members,a.discogs_urls,a.lastfm_listeners,a.lastfm_playcount,a.lastfm_tags,a.lastfm_bio,a.lastfm_similar,a.lastfm_url,a.genius_id,a.genius_description,a.genius_alt_names,a.genius_url,a.soul_id],
  })));

  console.log('  Albums: ' + albums.length);
  await batchUpsert(albums.map(al => ({
    sql: 'INSERT INTO albums (id,name,sort_name,artist_id,artist_name,year,genre,genres,styles,label,record_type,explicit,song_count,duration,thumb_url,release_date,mbz_release_id,deezer_id,itunes_id,discogs_id,discogs_catno,discogs_country,discogs_rating,discogs_rating_count,spotify_album_id,lastfm_listeners,lastfm_playcount,lastfm_tags,lastfm_wiki,lastfm_url,soul_id,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime(\'now\')) ON CONFLICT(id) DO UPDATE SET name=excluded.name,artist_id=excluded.artist_id,year=excluded.year,genres=excluded.genres,styles=excluded.styles,label=excluded.label,record_type=excluded.record_type,explicit=excluded.explicit,song_count=excluded.song_count,duration=excluded.duration,thumb_url=excluded.thumb_url,release_date=excluded.release_date,mbz_release_id=excluded.mbz_release_id,deezer_id=excluded.deezer_id,itunes_id=excluded.itunes_id,discogs_id=excluded.discogs_id,discogs_catno=excluded.discogs_catno,discogs_country=excluded.discogs_country,discogs_rating=excluded.discogs_rating,discogs_rating_count=excluded.discogs_rating_count,spotify_album_id=excluded.spotify_album_id,lastfm_listeners=excluded.lastfm_listeners,lastfm_playcount=excluded.lastfm_playcount,lastfm_tags=excluded.lastfm_tags,lastfm_wiki=excluded.lastfm_wiki,lastfm_url=excluded.lastfm_url,soul_id=excluded.soul_id,updated_at=datetime(\'now\')',
    params: [makeId(al.artist_name+'::'+al.title),al.title,al.title?.toLowerCase(),makeId(al.artist_name),al.artist_name,al.year,al.genres,al.genres,al.styles,al.label,al.record_type,al.explicit??0,al.track_count??0,al.duration??0,al.thumb_url,al.release_date,al.mbz_release_id,al.deezer_id,al.itunes_id,al.discogs_id,al.discogs_catno,al.discogs_country,al.discogs_rating,al.discogs_rating_count,al.spotify_album_id,al.lastfm_listeners,al.lastfm_playcount,al.lastfm_tags,al.lastfm_wiki,al.lastfm_url,al.soul_id],
  })));

  const trackRows = tracks.map(t => {
    const key = toGarageKey(t);
    if (!key) return null;
    const suffix = key.split('.').pop()?.toLowerCase();
    return {
      sql: 'INSERT INTO tracks (id,title,sort_title,album_id,album_name,artist_id,artist_name,track_number,disc_number,year,duration,bit_rate,size,suffix,content_type,path,bpm,explicit,isrc,lyrics,genius_id,genius_description,genius_url,lastfm_listeners,lastfm_playcount,lastfm_tags,lastfm_url,mbz_recording_id,deezer_id,itunes_id,mood,style,soul_id,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime(\'now\')) ON CONFLICT(id) DO UPDATE SET title=excluded.title,album_id=excluded.album_id,artist_id=excluded.artist_id,track_number=excluded.track_number,disc_number=excluded.disc_number,year=excluded.year,duration=excluded.duration,bit_rate=excluded.bit_rate,size=excluded.size,path=excluded.path,bpm=excluded.bpm,explicit=excluded.explicit,isrc=excluded.isrc,lyrics=excluded.lyrics,genius_id=excluded.genius_id,genius_description=excluded.genius_description,genius_url=excluded.genius_url,lastfm_listeners=excluded.lastfm_listeners,lastfm_playcount=excluded.lastfm_playcount,lastfm_tags=excluded.lastfm_tags,lastfm_url=excluded.lastfm_url,mbz_recording_id=excluded.mbz_recording_id,deezer_id=excluded.deezer_id,itunes_id=excluded.itunes_id,mood=excluded.mood,style=excluded.style,soul_id=excluded.soul_id,updated_at=datetime(\'now\')',
      params: [makeId(key),t.title,t.title?.toLowerCase(),makeId(t.artist_name+'::'+t.album_name),t.album_name,makeId(t.artist_name),t.artist_name,t.track_number,t.disc_number??1,t.year,t.duration??0,t.bitrate,t.file_size,suffix,mimeMap[suffix]??'audio/mpeg',key,t.bpm,t.explicit??0,t.isrc,t.genius_lyrics,t.genius_id,t.genius_description,t.genius_url,t.lastfm_listeners,t.lastfm_playcount,t.lastfm_tags,t.lastfm_url,t.mbz_recording_id,t.deezer_id,t.itunes_id,t.mood,t.style,t.soul_id],
    };
  }).filter(Boolean);

  console.log('  Tracks: ' + trackRows.length + ' (of ' + tracks.length + ' with mappable paths)');
  await batchUpsert(trackRows);

  return { artists: artists.length, albums: albums.length, tracks: trackRows.length };
}

// ── Trigger Stratum startScan ─────────────────────────────────────────────────

async function stratumScan() {
  const STRATUM_URL  = process.env.STRATUM_URL  ;
  const STRATUM_USER = process.env.STRATUM_USER ;
  const STRATUM_PASS = process.env.STRATUM_PASS ;
  const url = STRATUM_URL + '/rest/startScan.view?u=' + STRATUM_USER + '&p=' + STRATUM_PASS + '&v=1.15.0&c=sync&f=json';
  const res = await fetch(url);
  const j = await res.json();
  return j?.['subsonic-response']?.scanStatus?.count ?? '?';
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(DRY_RUN ? '=== DRY RUN ===' : '=== Stratum Sync ===\n');

console.log('1. Uploading audio files to Garage S3...');
const s3 = await syncFiles();
console.log('   uploaded=' + s3.uploaded + ' skipped=' + s3.skipped + ' errors=' + s3.errors);

console.log('\n2. Uploading cover art to Garage S3...');
const cover = await syncCoverArt();
console.log('   uploaded=' + cover.uploaded + ' skipped=' + cover.skipped + ' d1Updates=' + cover.d1Updates);

console.log('\n3. Triggering Stratum scan...');
const added = await stratumScan();
console.log('   added ' + added + ' new tracks to D1');

console.log('\n4. Pushing soulsync metadata to D1...');
const d1 = await syncMetadata();
console.log('   artists=' + d1.artists + ' albums=' + d1.albums + ' tracks=' + d1.tracks);

console.log('\nDone');
