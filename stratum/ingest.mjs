// SPDX-License-Identifier: MIT
/**
 * Stratum ingest — reads audio files from Garage S3 → parses tags → D1
 * No Navidrome dependency.
 *
 * Usage:
 *   node ingest.mjs [--dry-run]
 *
 * Env vars (all defaulted for this project):
 *   S3_ENDPOINT       https://YOUR-S3-ENDPOINT
 *   S3_ACCESS_KEY     YOUR-S3-ACCESS-KEY
 *   S3_SECRET_KEY     YOUR-S3-SECRET-KEY
 *   S3_BUCKET         stratum-audio
 *   S3_REGION         garage
 *   CF_ACCOUNT_ID         YOUR-CF-ACCOUNT-ID
 *   CF_API_TOKEN          wrangler oauth token (needs d1:write)
 *   D1_DATABASE_ID        YOUR-D1-DATABASE-ID
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import * as mm from 'music-metadata';
import crypto from 'crypto';
import { Readable } from 'stream';

const S3_ENDPOINT   = process.env.S3_ENDPOINT   ;
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY ;
const S3_SECRET_KEY = process.env.S3_SECRET_KEY ;
const S3_BUCKET     = process.env.S3_BUCKET     ?? 'stratum-audio';
const S3_REGION     = process.env.S3_REGION     ?? 'garage';

const CF_ACCOUNT = process.env.CF_ACCOUNT_ID    ;
const CF_TOKEN   = process.env.CF_API_TOKEN;
const D1_ID      = process.env.D1_DATABASE_ID   ;

const DRY_RUN = process.argv.includes('--dry-run');

if (!CF_TOKEN) { console.error('CF_API_TOKEN required'); process.exit(1); }

// ── S3 ───────────────────────────────────────────────────────────────────────

const s3 = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  forcePathStyle: true,
});

async function listAudioKeys() {
  const keys = [];
  let token;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET, Prefix: 'audio/', ContinuationToken: token
    }));
    for (const obj of res.Contents ?? []) {
      if (/\.(flac|mp3|m4a|aac|ogg|opus|wav)$/i.test(obj.Key)) {
        keys.push({ key: obj.Key, size: obj.Size ?? 0 });
      }
    }
    token = res.NextContinuationToken;
  } while (token);
  return keys;
}

async function getObjectStream(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  return res.Body;
}

// ── D1 ───────────────────────────────────────────────────────────────────────

async function d1(sql, params = []) {
  if (DRY_RUN) { console.log('[D1]', sql.trim().slice(0, 80)); return; }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/d1/database/${D1_ID}/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }) }
  );
  const data = await res.json();
  if (!data.success) throw new Error(`D1: ${JSON.stringify(data.errors)}`);
  return data.result?.[0];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function stableId(str) {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 24);
}

function ext2mime(suffix) {
  return { flac: 'audio/flac', mp3: 'audio/mpeg', m4a: 'audio/mp4',
           aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/opus', wav: 'audio/wav' }[suffix?.toLowerCase()] ?? 'audio/mpeg';
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Ingesting from Garage → D1${DRY_RUN ? ' [DRY RUN]' : ''}...`);

  await d1('SELECT 1');
  console.log('D1 ok');

  const objects = await listAudioKeys();
  console.log(`${objects.length} audio files in Garage\n`);

  const artistsSeen = new Map();
  const albumsSeen  = new Map();

  for (const { key, size } of objects) {
    process.stdout.write(`Processing: ${key}\n`);

    // Parse tags from S3 stream
    let meta;
    try {
      const stream = await getObjectStream(key);
      
      meta = await mm.parseStream(stream, { size, skipCovers: true });
    } catch (e) {
      console.error(`  ✗ tag parse failed: ${e.message}`);
      continue;
    }

    const t = meta.common;
    const f = meta.format;

    const artistName = t.albumartist || t.artist || 'Unknown Artist';
    const albumName  = t.album  || 'Unknown Album';
    const title      = t.title  || key.split('/').pop() || 'Unknown';
    const suffix     = key.split('.').pop()?.toLowerCase() ?? 'mp3';

    const artistId = stableId(`artist:${artistName}`);
    const albumId  = stableId(`album:${artistName}:${albumName}`);
    const trackId  = stableId(`track:${key}`);

    // Upsert artist
    if (!artistsSeen.has(artistId)) {
      artistsSeen.set(artistId, true);
      await d1(
        `INSERT OR IGNORE INTO artists (id, name, sort_name) VALUES (?, ?, ?)`,
        [artistId, artistName, t.sortedartist ?? artistName]
      );
      console.log(`  ✓ artist: ${artistName}`);
    }

    // Upsert album
    if (!albumsSeen.has(albumId)) {
      albumsSeen.set(albumId, true);
      await d1(
        `INSERT OR IGNORE INTO albums (id, name, artist_id, artist_name, year, genre) VALUES (?, ?, ?, ?, ?, ?)`,
        [albumId, albumName, artistId, artistName,
         t.year ?? null, t.genre?.[0] ?? null]
      );
      console.log(`  ✓ album: ${albumName}`);
    }

    // Upsert track
    await d1(
      `INSERT OR REPLACE INTO tracks
       (id, title, album_id, album_name, artist_id, artist_name,
        track_number, disc_number, year, genre, duration, bit_rate,
        size, suffix, content_type, path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [trackId, title, albumId, albumName, artistId, artistName,
       t.track?.no ?? null, t.disk?.no ?? 1,
       t.year ?? null, t.genre?.[0] ?? null,
       f.duration ? Math.round(f.duration) : 0,
       f.bitrate ? Math.round(f.bitrate / 1000) : 0,
       size, suffix, ext2mime(suffix),
       key]  // path = S3 key
    );
    console.log(`  ✓ track: ${title} (${suffix}, ${Math.round(size/1024)}KB)`);
  }

  console.log(`\nDone. ${objects.length} files, ${artistsSeen.size} artists, ${albumsSeen.size} albums.`);
}

main().catch(err => { console.error(err); process.exit(1); });
