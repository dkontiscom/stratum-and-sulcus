// SPDX-License-Identifier: MIT
import { Md5 } from "ts-md5";
export interface Env {
  DB: D1Database;
  MUSIC: R2Bucket;
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD: string;
  NAVIDROME_URL: string;
  NAVIDROME_PASS: string;
  S3_ENDPOINT: string;
  S3_BUCKET: string;
  S3_REGION: string;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
}

// ── Auth ─────────────────────────────────────────────────────────────────────
// Subsonic token auth: client sends t = MD5(password + salt). The server must
// hold the original plaintext to verify, so passwords cannot be hashed at rest.
// This is a protocol-level constraint shared by all Subsonic-compatible servers.

async function checkAuth(params: URLSearchParams, env: Env): Promise<{ ok: boolean; username: string }> {
  const apiKey = params.get('apiKey');
  if (apiKey) {
    const user = await env.DB.prepare('SELECT username FROM users WHERE api_key = ?').bind(apiKey).first<any>();
    if (user) return { ok: true, username: user.username };
    return { ok: false, username: '' };
  }
  const u = params.get('u');
  const p = params.get('p');
  const t = params.get('t');
  const s = params.get('s');
  if (!u) return { ok: false, username: '' };
  // Check DB first, fall back to env vars for bootstrap
  const user = await env.DB.prepare('SELECT username, password_hash FROM users WHERE username = ?').bind(u).first<any>();
  const storedPass = user?.password_hash ?? (u === env.ADMIN_USERNAME ? env.ADMIN_PASSWORD : null);
  if (!storedPass) return { ok: false, username: '' };
  if (p) {
    const pass = p.startsWith('enc:') ? hexDecode(p.slice(4)) : p;
    return { ok: pass === storedPass, username: u };
  }
  if (t && s) {
    return { ok: t === md5(storedPass + s), username: u };
  }
  return { ok: false, username: '' };
}

function hexDecode(hex: string): string {
  let str = '';
  for (let i = 0; i < hex.length; i += 2)
    str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  return str;
}

function md5(str: string): string { return Md5.hashStr(str); }

// ── Response helpers ──────────────────────────────────────────────────────────

function xmlResponse(body: string): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<subsonic-response xmlns="http://subsonic.org/restapi" status="ok" version="1.16.1" type="stratum" serverVersion="0.1.0" openSubsonic="true">${body}</subsonic-response>`,
    { headers: { 'Content-Type': 'text/xml; charset=utf-8' } }
  );
}

function jsonResponse(data: object): Response {
  return new Response(JSON.stringify({
    'subsonic-response': {
      status: 'ok',
      version: '1.16.1',
      type: 'stratum',
      serverVersion: '0.1.0',
      openSubsonic: true,
      ...data
    }
  }), { headers: { 'Content-Type': 'application/json' } });
}

function errorXml(code: number, message: string): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<subsonic-response xmlns="http://subsonic.org/restapi" status="failed" version="1.16.1"><error code="${code}" message="${message}"/></subsonic-response>`,
    { headers: { 'Content-Type': 'text/xml; charset=utf-8' } }
  );
}

function errorJson(code: number, message: string): Response {
  return new Response(JSON.stringify({
    'subsonic-response': {
      status: 'failed',
      version: '1.16.1',
      error: { code, message }
    }
  }), { headers: { 'Content-Type': 'application/json' } });
}

function respond(params: URLSearchParams, xml: string): Response;
function respond(params: URLSearchParams, data: object): Response;
function respond(params: URLSearchParams, payload: string | object): Response {
  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json' || fmt === 'jsonp') {
    return jsonResponse(typeof payload === 'string' ? {} : payload);
  }
  return xmlResponse(typeof payload === 'string' ? payload : '');
}

function respondError(params: URLSearchParams, code: number, message: string): Response {
  const fmt = params.get('f') ?? 'xml';
  return fmt === 'json' ? errorJson(code, message) : errorXml(code, message);
}

// ── Serializers ───────────────────────────────────────────────────────────────

function esc(s: string): string {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseJsonArray(val: any): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try { const p = JSON.parse(val); return Array.isArray(p) ? p : [String(val)]; } catch { return [String(val)]; }
}

function albumJson(a: any) {
  const genres = parseJsonArray(a.genres ?? a.genre);
  return {
    id: a.id, name: a.name, artist: a.artist_name, artistId: a.artist_id,
    year: a.year, genre: a.genre, songCount: a.song_count ?? 0, duration: a.duration ?? 0,
    coverArt: a.cover_art_id ?? a.id, created: a.created_at,
    played: a.last_played_at ?? undefined,
    userRating: a.user_rating || undefined,
    musicBrainzId: a.mbz_release_id ?? undefined,
    genres: genres.length ? genres.map((g: string) => ({ name: g })) : undefined,
    recordLabels: a.label ? [{ name: a.label }] : undefined,
    releaseDate: a.release_date ? { year: parseInt(a.release_date) || undefined } : undefined,
    explicit: a.explicit ? true : undefined,
  };
}

function albumXml(a: any, artistName?: string): string {
  const art = a.cover_art_id ?? a.id;
  const extras = [
    a.mbz_release_id ? `musicBrainzId="${esc(a.mbz_release_id)}"` : '',
    a.user_rating ? `userRating="${a.user_rating}"` : '',
    a.last_played_at ? `played="${a.last_played_at}"` : '',
    a.label ? `recordLabel="${esc(a.label)}"` : '',
    a.explicit ? 'explicit="true"' : '',
  ].filter(Boolean).join(' ');
  return `<album id="${esc(a.id)}" name="${esc(a.name)}" artist="${esc(artistName ?? a.artist_name)}" artistId="${esc(a.artist_id)}" year="${a.year ?? ''}" songCount="${a.song_count ?? 0}" duration="${a.duration ?? 0}" coverArt="${esc(art)}"${extras ? ' ' + extras : ''}>`;
}

function trackJson(t: any) {
  const genres = parseJsonArray(t.genres ?? t.genre);
  return {
    id: t.id, title: t.title, album: t.album_name, albumId: t.album_id,
    artist: t.artist_name, artistId: t.artist_id, track: t.track_number, discNumber: t.disc_number ?? 1,
    year: t.year, genre: t.genre, duration: t.duration ?? 0, bitRate: t.bit_rate ?? 0,
    size: t.size ?? 0, suffix: t.suffix, contentType: t.content_type ?? 'audio/mpeg',
    coverArt: t.cover_art_id ?? t.album_id, playCount: t.play_count ?? 0, created: t.created_at,
    played: t.last_played_at ?? undefined,
    userRating: t.user_rating || undefined,
    starred: t.starred_at ?? undefined,
    musicBrainzId: t.mbz_recording_id ?? undefined,
    bpm: t.bpm ? Math.round(t.bpm) : undefined,
    mood: t.mood ?? undefined,
    isrc: t.isrc ?? undefined,
    genres: genres.length ? genres.map((g: string) => ({ name: g })) : undefined,
    replayGain: undefined,
  };
}

function trackXml(t: any): string {
  const art = t.cover_art_id ?? t.album_id;
  return `<song id="${esc(t.id)}" title="${esc(t.title)}" album="${esc(t.album_name)}" albumId="${esc(t.album_id)}" artist="${esc(t.artist_name)}" artistId="${esc(t.artist_id)}" track="${t.track_number ?? ''}" discNumber="${t.disc_number ?? 1}" year="${t.year ?? ''}" duration="${t.duration ?? 0}" bitRate="${t.bit_rate ?? 0}" size="${t.size ?? 0}" suffix="${esc(t.suffix ?? '')}" contentType="${esc(t.content_type ?? 'audio/mpeg')}" coverArt="${esc(art)}" playCount="${t.play_count ?? 0}" isDir="false" type="music"${t.bpm ? ` bpm="${t.bpm}"` : ''}${t.mood ? ` mood="${esc(t.mood)}"` : ''}/>`;
}

function playlistJson(p: any) {
  return { id: p.id, name: p.name, comment: p.comment ?? '', owner: p.owner ?? 'admin',
    public: !!p.public, songCount: p.song_count ?? 0, duration: p.duration ?? 0, created: p.created_at };
}

function playlistXml(p: any): string {
  return `<playlist id="${esc(p.id)}" name="${esc(p.name)}" owner="${esc(p.owner ?? 'admin')}" public="${!!p.public}" songCount="${p.song_count ?? 0}" duration="${p.duration ?? 0}" created="${p.created_at}"/>`;
}

// ── Endpoint handlers ─────────────────────────────────────────────────────────

async function handlePing(params: URLSearchParams, _env: Env): Promise<Response> {
  return respond(params, {});
}

async function handleGetLicense(params: URLSearchParams, _env: Env): Promise<Response> {
  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') return jsonResponse({ license: { valid: true, email: 'admin@stratum', licenseExpires: '2099-01-01T00:00:00' } });
  return xmlResponse('<license valid="true" email="admin@stratum" licenseExpires="2099-01-01T00:00:00"/>');
}

async function handleGetOpenSubsonicExtensions(_params: URLSearchParams, _env: Env): Promise<Response> {
  return jsonResponse({
    openSubsonicExtensions: [
      { name: 'formPost', versions: [1] },
      { name: 'songLyrics', versions: [1] },
      { name: 'apiKeyAuthentication', versions: [1] },
      { name: 'transcodeOffset', versions: [1] },
      { name: 'playbackReport', versions: [1] },
      { name: 'songSimilarity', versions: [1] },
      { name: 'indexBasedQueue', versions: [1] },
    ]
  });
}

async function handleGetMusicFolders(params: URLSearchParams, _env: Env): Promise<Response> {
  return respond(params, {
    musicFolders: { musicFolder: [{ id: '1', name: 'Music' }] }
  });
}

// getIndexes — same data as getArtists, older Subsonic clients use this
async function handleGetIndexes(params: URLSearchParams, env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    'SELECT id, name FROM artists ORDER BY name COLLATE NOCASE'
  ).all<{ id: string; name: string }>();

  const byLetter: Record<string, { id: string; name: string }[]> = {};
  for (const a of rows.results) {
    const letter = a.name.match(/^[A-Z]/i) ? a.name[0].toUpperCase() : '#';
    (byLetter[letter] ??= []).push(a);
  }

  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') {
    return jsonResponse({
      indexes: {
        ignoredArticles: 'The An A',
        lastModified: Date.now(),
        index: Object.entries(byLetter).sort().map(([name, artists]) => ({
          name,
          artist: artists.map(a => ({ id: a.id, name: a.name, albumCount: 0 }))
        }))
      }
    });
  }
  const indexXml = Object.entries(byLetter).sort().map(([letter, artists]) =>
    `<index name="${letter}">${artists.map(a => `<artist id="${esc(a.id)}" name="${esc(a.name)}" albumCount="0"/>`).join('')}</index>`
  ).join('');
  return xmlResponse(`<indexes ignoredArticles="The An A" lastModified="${Date.now()}">${indexXml}</indexes>`);
}

// getMusicDirectory — browse artist→albums or album→tracks folder-style
async function handleGetMusicDirectory(params: URLSearchParams, env: Env): Promise<Response> {
  const id = params.get('id');
  if (!id) return respondError(params, 10, 'Missing parameter: id');

  // Try artist first
  const artist = await env.DB.prepare('SELECT * FROM artists WHERE id = ?').bind(id).first<any>();
  if (artist) {
    const albums = await env.DB.prepare(
      'SELECT id, name, year, genre, song_count, duration, cover_art_id FROM albums WHERE artist_id = ? ORDER BY year DESC, name'
    ).bind(id).all<any>();
    const fmt = params.get('f') ?? 'xml';
    if (fmt === 'json') {
      return jsonResponse({ directory: {
        id, name: artist.name, parent: '1',
        child: albums.results.map(a => ({
          id: a.id, parent: id, title: a.name, isDir: true, album: a.name,
          artist: artist.name, year: a.year, coverArt: a.cover_art_id ?? a.id
        }))
      }});
    }
    const children = albums.results.map(a =>
      `<child id="${esc(a.id)}" parent="${esc(id)}" title="${esc(a.name)}" isDir="true" album="${esc(a.name)}" artist="${esc(artist.name)}" year="${a.year ?? ''}" coverArt="${esc(a.cover_art_id ?? a.id)}"/>`
    ).join('');
    return xmlResponse(`<directory id="${esc(id)}" name="${esc(artist.name)}" parent="1">${children}</directory>`);
  }

  // Try album
  const album = await env.DB.prepare('SELECT * FROM albums WHERE id = ?').bind(id).first<any>();
  if (album) {
    const tracks = await env.DB.prepare(
      'SELECT * FROM tracks WHERE album_id = ? ORDER BY disc_number, track_number'
    ).bind(id).all<any>();
    const fmt = params.get('f') ?? 'xml';
    if (fmt === 'json') {
      return jsonResponse({ directory: {
        id, name: album.name, parent: album.artist_id,
        child: tracks.results.map(t => ({ ...trackJson(t), isDir: false, parent: id }))
      }});
    }
    const children = tracks.results.map(t =>
      `<child id="${esc(t.id)}" parent="${esc(id)}" title="${esc(t.title)}" isDir="false" album="${esc(t.album_name)}" artist="${esc(t.artist_name)}" track="${t.track_number ?? ''}" year="${t.year ?? ''}" duration="${t.duration ?? 0}" suffix="${esc(t.suffix ?? '')}" contentType="${esc(t.content_type ?? 'audio/mpeg')}" coverArt="${esc(t.cover_art_id ?? id)}" size="${t.size ?? 0}"/>`
    ).join('');
    return xmlResponse(`<directory id="${esc(id)}" name="${esc(album.name)}" parent="${esc(album.artist_id)}">${children}</directory>`);
  }

  return respondError(params, 70, 'Directory not found');
}

async function handleGetArtists(params: URLSearchParams, env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    'SELECT id, name FROM artists ORDER BY name COLLATE NOCASE'
  ).all<{ id: string; name: string }>();

  const byLetter: Record<string, { id: string; name: string }[]> = {};
  for (const a of rows.results) {
    const letter = a.name.match(/^[A-Z]/i) ? a.name[0].toUpperCase() : '#';
    (byLetter[letter] ??= []).push(a);
  }

  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') {
    return jsonResponse({
      artists: {
        ignoredArticles: 'The An A',
        index: Object.entries(byLetter).sort().map(([name, artists]) => ({
          name,
          artist: artists.map(a => ({ id: a.id, name: a.name, albumCount: 0 }))
        }))
      }
    });
  }
  const indexXml = Object.entries(byLetter).sort().map(([letter, artists]) =>
    `<index name="${letter}">${artists.map(a => `<artist id="${esc(a.id)}" name="${esc(a.name)}" albumCount="0"/>`).join('')}</index>`
  ).join('');
  return xmlResponse(`<artists ignoredArticles="The An A">${indexXml}</artists>`);
}

async function handleGetArtist(params: URLSearchParams, env: Env): Promise<Response> {
  const id = params.get('id');
  if (!id) return respondError(params, 10, 'Missing parameter: id');

  const artist = await env.DB.prepare('SELECT * FROM artists WHERE id = ?').bind(id).first<any>();
  if (!artist) return respondError(params, 70, 'Artist not found');

  const albums = await env.DB.prepare(
    'SELECT id, name, year, genre, song_count, duration, cover_art_id FROM albums WHERE artist_id = ? ORDER BY year DESC, name'
  ).bind(id).all<any>();

  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') {
    return jsonResponse({
      artist: {
        id: artist.id, name: artist.name,
        albumCount: albums.results.length,
        coverArt: artist.image_url ?? undefined,
        album: albums.results.map(albumJson)
      }
    });
  }
  const albumsXml = albums.results.map(a => albumXml(a, artist.name) + '</album>').join('');
  return xmlResponse(`<artist id="${esc(artist.id)}" name="${esc(artist.name)}" albumCount="${albums.results.length}">${albumsXml}</artist>`);
}

async function handleGetArtistInfo2(params: URLSearchParams, env: Env): Promise<Response> {
  const id = params.get('id');
  if (!id) return respondError(params, 10, 'Missing parameter: id');

  const artist = await env.DB.prepare('SELECT * FROM artists WHERE id = ?').bind(id).first<any>();
  if (!artist) return respondError(params, 70, 'Artist not found');

  const bio = artist.lastfm_bio || artist.biography || artist.bio || artist.genius_description || '';
  const imageUrl = artist.image_url || artist.banner_url || '';
  const mbzId = artist.mbz_artist_id || '';
  const lastfmUrl = artist.lastfm_url || '';

  // Parse similar artists if stored as JSON
  let similarArtists: any[] = [];
  try {
    if (artist.lastfm_similar) similarArtists = JSON.parse(artist.lastfm_similar).slice(0, 5);
  } catch {}

  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') {
    return jsonResponse({
      artistInfo2: {
        biography: bio,
        musicBrainzId: mbzId,
        lastFmUrl: lastfmUrl,
        smallImageUrl: imageUrl,
        mediumImageUrl: imageUrl,
        largeImageUrl: imageUrl,
        similarArtist: similarArtists.map((s: any) => ({ id: s.id ?? '', name: s.name ?? s }))
      }
    });
  }
  const similarXml = similarArtists.map((s: any) =>
    `<similarArtist id="${esc(s.id ?? '')}" name="${esc(s.name ?? s)}"/>`
  ).join('');
  return xmlResponse(`<artistInfo2>${bio ? `<biography>${esc(bio)}</biography>` : ''}<musicBrainzId>${esc(mbzId)}</musicBrainzId><lastFmUrl>${esc(lastfmUrl)}</lastFmUrl><smallImageUrl>${esc(imageUrl)}</smallImageUrl><mediumImageUrl>${esc(imageUrl)}</mediumImageUrl><largeImageUrl>${esc(imageUrl)}</largeImageUrl>${similarXml}</artistInfo2>`);
}

async function handleGetAlbum(params: URLSearchParams, env: Env): Promise<Response> {
  const id = params.get('id');
  if (!id) return respondError(params, 10, 'Missing parameter: id');

  const album = await env.DB.prepare('SELECT * FROM albums WHERE id = ?').bind(id).first<any>();
  if (!album) return respondError(params, 70, 'Album not found');

  const tracks = await env.DB.prepare(
    'SELECT * FROM tracks WHERE album_id = ? ORDER BY disc_number, track_number'
  ).bind(id).all<any>();

  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') {
    return jsonResponse({ album: { ...albumJson(album), song: tracks.results.map(trackJson) } });
  }
  const tracksXml = tracks.results.map(t => trackXml(t)).join('');
  return xmlResponse(`${albumXml(album)}${tracksXml}</album>`);
}

async function handleGetAlbumInfo2(params: URLSearchParams, env: Env): Promise<Response> {
  const id = params.get('id');
  if (!id) return respondError(params, 10, 'Missing parameter: id');

  const album = await env.DB.prepare('SELECT * FROM albums WHERE id = ?').bind(id).first<any>();
  if (!album) return respondError(params, 70, 'Album not found');

  const notes = album.lastfm_wiki || '';
  const mbzId = album.mbz_release_id || '';
  const lastfmUrl = album.lastfm_url || '';

  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') {
    return jsonResponse({ albumInfo: { notes, musicBrainzId: mbzId, lastFmUrl: lastfmUrl } });
  }
  return xmlResponse(`<albumInfo>${notes ? `<notes>${esc(notes)}</notes>` : ''}<musicBrainzId>${esc(mbzId)}</musicBrainzId><lastFmUrl>${esc(lastfmUrl)}</lastFmUrl></albumInfo>`);
}

async function handleGetAlbumList2(params: URLSearchParams, env: Env): Promise<Response> {
  const type = params.get('type') ?? 'newest';
  const size = Math.min(parseInt(params.get('size') ?? '10'), 500);
  const offset = parseInt(params.get('offset') ?? '0');

  let query = '';
  switch (type) {
    case 'newest':   query = 'SELECT * FROM albums ORDER BY created_at DESC'; break;
    case 'recent':   query = 'SELECT * FROM albums ORDER BY updated_at DESC'; break;
    case 'frequent': query = 'SELECT * FROM albums ORDER BY play_count DESC'; break;
    case 'random':   query = 'SELECT * FROM albums ORDER BY RANDOM()'; break;
    case 'alphabeticalByName': query = 'SELECT * FROM albums ORDER BY name COLLATE NOCASE'; break;
    case 'alphabeticalByArtist': query = 'SELECT * FROM albums ORDER BY artist_name COLLATE NOCASE, name COLLATE NOCASE'; break;
    case 'starred':  query = 'SELECT a.* FROM albums a JOIN starred s ON s.item_id = a.id'; break;
    case 'byYear': {
      const from = params.get('fromYear') ?? '0';
      const to = params.get('toYear') ?? '9999';
      query = `SELECT * FROM albums WHERE year BETWEEN ${from} AND ${to} ORDER BY year`;
      break;
    }
    case 'highest':  query = 'SELECT * FROM albums ORDER BY user_rating DESC NULLS LAST'; break;
    case 'byGenre': {
      const genre = params.get('genre') ?? '';
      query = `SELECT * FROM albums WHERE (genre LIKE '%' || ? || '%' OR genres LIKE '%' || ? || '%') ORDER BY name`;
      const rows2 = await env.DB.prepare(query + ' LIMIT ? OFFSET ?').bind(genre, genre, size, offset).all<any>();
      const fmt2 = params.get('f') ?? 'xml';
      if (fmt2 === 'json') return jsonResponse({ albumList2: { album: rows2.results.map(albumJson) } });
      return xmlResponse('<albumList2>' + rows2.results.map((a: any) => albumXml(a) + '</album>').join('') + '</albumList2>');
    }
    default: query = 'SELECT * FROM albums ORDER BY created_at DESC';
  }

  const rows = await env.DB.prepare(`${query} LIMIT ? OFFSET ?`).bind(size, offset).all<any>();
  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') return jsonResponse({ albumList2: { album: rows.results.map(albumJson) } });
  return xmlResponse(`<albumList2>${rows.results.map(a => albumXml(a) + '</album>').join('')}</albumList2>`);
}

// getAlbumList — v1 alias, same data different wrapper
async function handleGetAlbumList(params: URLSearchParams, env: Env): Promise<Response> {
  const res = await handleGetAlbumList2(params, env);
  const text = await res.text();
  return new Response(
    text.replace(/<albumList2>/g, '<albumList>').replace(/<\/albumList2>/g, '</albumList>')
      .replace(/"albumList2"/, '"albumList"'),
    { headers: res.headers }
  );
}

async function handleGetSong(params: URLSearchParams, env: Env): Promise<Response> {
  const id = params.get('id');
  if (!id) return respondError(params, 10, 'Missing parameter: id');
  const track = await env.DB.prepare('SELECT * FROM tracks WHERE id = ?').bind(id).first<any>();
  if (!track) return respondError(params, 70, 'Song not found');
  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') return jsonResponse({ song: trackJson(track) });
  return xmlResponse(trackXml(track).replace('<song ', '<song ').replace('/>', '/>'));
}

async function handleGetGenres(params: URLSearchParams, env: Env): Promise<Response> {
  const rows = await env.DB.prepare(`
    SELECT genre, COUNT(*) as songCount FROM tracks WHERE genre IS NOT NULL AND genre != ''
    GROUP BY genre ORDER BY genre COLLATE NOCASE
  `).all<any>();
  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') {
    return jsonResponse({ genres: { genre: rows.results.map(g => ({ value: g.genre, songCount: g.songCount, albumCount: 0 })) } });
  }
  const xml = rows.results.map(g => `<genre songCount="${g.songCount}" albumCount="0">${esc(g.genre)}</genre>`).join('');
  return xmlResponse(`<genres>${xml}</genres>`);
}

async function handleGetSongsByGenre(params: URLSearchParams, env: Env): Promise<Response> {
  const genre = params.get('genre') ?? '';
  const count = Math.min(parseInt(params.get('count') ?? '10'), 500);
  const offset = parseInt(params.get('offset') ?? '0');
  const rows = await env.DB.prepare(
    'SELECT * FROM tracks WHERE genre LIKE ? LIMIT ? OFFSET ?'
  ).bind(`%${genre}%`, count, offset).all<any>();
  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') return jsonResponse({ songsByGenre: { song: rows.results.map(trackJson) } });
  return xmlResponse(`<songsByGenre>${rows.results.map(trackXml).join('')}</songsByGenre>`);
}

async function handleGetTopSongs(params: URLSearchParams, env: Env): Promise<Response> {
  const artistName = params.get('artist') ?? '';
  const count = Math.min(parseInt(params.get('count') ?? '50'), 500);
  const rows = await env.DB.prepare(
    'SELECT * FROM tracks WHERE artist_name LIKE ? ORDER BY play_count DESC, lastfm_playcount DESC LIMIT ?'
  ).bind(`%${artistName}%`, count).all<any>();
  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') return jsonResponse({ topSongs: { song: rows.results.map(trackJson) } });
  return xmlResponse(`<topSongs>${rows.results.map(trackXml).join('')}</topSongs>`);
}

async function getSimilarSongsRows(id: string, count: number, env: Env) {
  const track = await env.DB.prepare('SELECT * FROM tracks WHERE id = ?').bind(id).first<any>();
  if (!track) return null;
  return env.DB.prepare(
    'SELECT * FROM tracks WHERE id != ? AND (genre = ? OR artist_id = ?) ORDER BY RANDOM() LIMIT ?'
  ).bind(id, track.genre, track.artist_id, count).all<any>();
}

async function handleGetSimilarSongs(params: URLSearchParams, env: Env): Promise<Response> {
  const id = params.get('id');
  if (!id) return respondError(params, 10, 'Missing parameter: id');
  const count = Math.min(parseInt(params.get('count') ?? '50'), 500);
  const rows = await getSimilarSongsRows(id, count, env);
  if (!rows) return respondError(params, 70, 'Song not found');
  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') return jsonResponse({ similarSongs: { song: rows.results.map(trackJson) } });
  return xmlResponse(`<similarSongs>${rows.results.map(trackXml).join('')}</similarSongs>`);
}

async function handleGetSimilarSongs2(params: URLSearchParams, env: Env): Promise<Response> {
  const id = params.get('id');
  if (!id) return respondError(params, 10, 'Missing parameter: id');
  const count = Math.min(parseInt(params.get('count') ?? '50'), 500);
  const rows = await getSimilarSongsRows(id, count, env);
  if (!rows) return respondError(params, 70, 'Song not found');
  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') return jsonResponse({ similarSongs2: { song: rows.results.map(trackJson) } });
  return xmlResponse(`<similarSongs2>${rows.results.map(trackXml).join('')}</similarSongs2>`);
}



async function handleGetPlaylists(params: URLSearchParams, env: Env): Promise<Response> {
  const rows = await env.DB.prepare('SELECT * FROM playlists ORDER BY name').all<any>();
  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') return jsonResponse({ playlists: { playlist: rows.results.map(playlistJson) } });
  return xmlResponse(`<playlists>${rows.results.map(playlistXml).join('')}</playlists>`);
}

async function handleGetPlaylist(params: URLSearchParams, env: Env): Promise<Response> {
  const id = params.get('id');
  if (!id) return respondError(params, 10, 'Missing parameter: id');
  const pl = await env.DB.prepare('SELECT * FROM playlists WHERE id = ?').bind(id).first<any>();
  if (!pl) return respondError(params, 70, 'Playlist not found');
  const tracks = await env.DB.prepare(`
    SELECT t.* FROM tracks t
    JOIN playlist_tracks pt ON pt.track_id = t.id
    WHERE pt.playlist_id = ?
    ORDER BY pt.position
  `).bind(id).all<any>();
  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') return jsonResponse({ playlist: { ...playlistJson(pl), entry: tracks.results.map(trackJson) } });
  return xmlResponse(`${playlistXml(pl).replace('/>', '>')}${tracks.results.map(trackXml).join('')}</playlist>`);
}

async function handleCreatePlaylist(params: URLSearchParams, env: Env): Promise<Response> {
  const name = params.get('name');
  const playlistId = params.get('playlistId');
  const songIds = params.getAll('songId');
  if (playlistId) {
    await env.DB.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').bind(playlistId).run();
    for (let i = 0; i < songIds.length; i++)
      await env.DB.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)').bind(playlistId, songIds[i], i).run();
    await env.DB.prepare('UPDATE playlists SET song_count = ?, updated_at = datetime("now") WHERE id = ?').bind(songIds.length, playlistId).run();
    return respond(params, '');
  }
  if (!name) return respondError(params, 10, 'Missing parameter: name');
  const id = crypto.randomUUID();
  const user = params.get('u') ?? 'admin';
  await env.DB.prepare('INSERT INTO playlists (id, name, song_count, owner) VALUES (?, ?, ?, ?)').bind(id, name, songIds.length, user).run();
  for (let i = 0; i < songIds.length; i++)
    await env.DB.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)').bind(id, songIds[i], i).run();
  // Spec requires returning the created playlist
  const pl = await env.DB.prepare('SELECT * FROM playlists WHERE id = ?').bind(id).first<any>();
  const tracks = await env.DB.prepare('SELECT t.* FROM tracks t JOIN playlist_tracks pt ON pt.track_id = t.id WHERE pt.playlist_id = ? ORDER BY pt.position').bind(id).all<any>();
  const playlist = { id: pl.id, name: pl.name, songCount: pl.song_count ?? 0, duration: pl.duration ?? 0, public: !!pl.is_public, owner: pl.owner ?? user, created: pl.created_at, changed: pl.updated_at ?? pl.created_at, entry: tracks.results.map(trackJson) };
  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') return jsonResponse({ playlist });
  const tracksXml = tracks.results.map(trackXml).join('');
  return xmlResponse(`<playlist id="${esc(pl.id)}" name="${esc(pl.name)}" songCount="${playlist.songCount}" duration="${playlist.duration}" public="${playlist.public}" owner="${esc(playlist.owner)}" created="${pl.created_at}" changed="${pl.created_at}">${tracksXml}</playlist>`);
}

async function handleUpdatePlaylist(params: URLSearchParams, env: Env): Promise<Response> {
  const id = params.get('playlistId');
  if (!id) return respondError(params, 10, 'Missing parameter: playlistId');
  const name = params.get('name');
  if (name) await env.DB.prepare('UPDATE playlists SET name = ? WHERE id = ?').bind(name, id).run();
  const addIds = params.getAll('songIdToAdd');
  if (addIds.length) {
    const maxPos = await env.DB.prepare('SELECT MAX(position) as m FROM playlist_tracks WHERE playlist_id = ?').bind(id).first<{ m: number }>();
    let pos = (maxPos?.m ?? -1) + 1;
    for (const sid of addIds)
      await env.DB.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)').bind(id, sid, pos++).run();
  }
  const removeIndices = params.getAll('songIndexToRemove').map(Number).sort((a, b) => b - a);
  for (const idx of removeIndices) {
    await env.DB.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND position = ?').bind(id, idx).run();
  }
  await env.DB.prepare('UPDATE playlists SET song_count = (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = ?), updated_at = datetime("now") WHERE id = ?').bind(id, id).run();
  return respond(params, '');
}

async function handleDeletePlaylist(params: URLSearchParams, env: Env): Promise<Response> {
  const id = params.get('id');
  if (!id) return respondError(params, 10, 'Missing parameter: id');
  await env.DB.prepare('DELETE FROM playlists WHERE id = ?').bind(id).run();
  return respond(params, '');
}

async function handleSearch3(params: URLSearchParams, env: Env): Promise<Response> {
  const query = `%${params.get('query') ?? ''}%`;
  const artistCount = parseInt(params.get('artistCount') ?? '20');
  const artistOffset = parseInt(params.get('artistOffset') ?? '0');
  const albumCount = parseInt(params.get('albumCount') ?? '20');
  const albumOffset = parseInt(params.get('albumOffset') ?? '0');
  const songCount = parseInt(params.get('songCount') ?? '20');
  const songOffset = parseInt(params.get('songOffset') ?? '0');

  const [artists, albums, tracks] = await Promise.all([
    env.DB.prepare('SELECT * FROM artists WHERE name LIKE ? LIMIT ? OFFSET ?').bind(query, artistCount, artistOffset).all<any>(),
    env.DB.prepare('SELECT * FROM albums WHERE name LIKE ? OR artist_name LIKE ? LIMIT ? OFFSET ?').bind(query, query, albumCount, albumOffset).all<any>(),
    env.DB.prepare('SELECT * FROM tracks WHERE title LIKE ? OR artist_name LIKE ? OR album_name LIKE ? LIMIT ? OFFSET ?').bind(query, query, query, songCount, songOffset).all<any>(),
  ]);

  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') {
    return jsonResponse({
      searchResult3: {
        artist: artists.results.map((a: any) => ({ id: a.id, name: a.name, coverArt: a.id, albumCount: a.album_count ?? 0 })),
        album: albums.results.map(albumJson),
        song: tracks.results.map(trackJson),
      }
    });
  }
  return xmlResponse(`<searchResult3>
    ${artists.results.map((a: any) => `<artist id="${esc(a.id)}" name="${esc(a.name)}" coverArt="${esc(a.id)}" albumCount="${a.album_count ?? 0}"/>`).join('')}
    ${albums.results.map((a: any) => albumXml(a) + '</album>').join('')}
    ${tracks.results.map(trackXml).join('')}
  </searchResult3>`);
}

// search2 — v1 alias with different response wrapper
async function handleSearch2(params: URLSearchParams, env: Env): Promise<Response> {
  const query = `%${params.get('query') ?? ''}%`;
  const artistCount = parseInt(params.get('artistCount') ?? '20');
  const albumCount = parseInt(params.get('albumCount') ?? '20');
  const songCount = parseInt(params.get('songCount') ?? '20');

  const [artists, albums, tracks] = await Promise.all([
    env.DB.prepare('SELECT * FROM artists WHERE name LIKE ? LIMIT ?').bind(query, artistCount).all<any>(),
    env.DB.prepare('SELECT * FROM albums WHERE name LIKE ? OR artist_name LIKE ? LIMIT ?').bind(query, query, albumCount).all<any>(),
    env.DB.prepare('SELECT * FROM tracks WHERE title LIKE ? OR artist_name LIKE ? LIMIT ?').bind(query, query, songCount).all<any>(),
  ]);

  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') {
    return jsonResponse({
      searchResult2: {
        artist: artists.results.map((a: any) => ({ id: a.id, name: a.name, coverArt: a.id, albumCount: a.album_count ?? 0 })),
        album: albums.results.map(albumJson),
        song: tracks.results.map(trackJson),
      }
    });
  }
  return xmlResponse(`<searchResult2>
    ${artists.results.map((a: any) => `<artist id="${esc(a.id)}" name="${esc(a.name)}" coverArt="${esc(a.id)}" albumCount="${a.album_count ?? 0}"/>`).join('')}
    ${albums.results.map((a: any) => albumXml(a) + '</album>').join('')}
    ${tracks.results.map(trackXml).join('')}
  </searchResult2>`);
}

async function handleGetLyrics(params: URLSearchParams, env: Env): Promise<Response> {
  const artist = params.get('artist') ?? '';
  const title = params.get('title') ?? '';
  const track = await env.DB.prepare(
    'SELECT lyrics FROM tracks WHERE artist_name LIKE ? AND title LIKE ? LIMIT 1'
  ).bind(`%${artist}%`, `%${title}%`).first<any>();
  const lyrics = track?.lyrics ?? '';
  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') return jsonResponse({ lyrics: { artist, title, value: lyrics } });
  return xmlResponse(`<lyrics artist="${esc(artist)}" title="${esc(title)}">${esc(lyrics)}</lyrics>`);
}

// OpenSubsonic: getLyricsBySongId — returns structured lyrics object
async function handleGetLyricsBySongId(params: URLSearchParams, env: Env): Promise<Response> {
  const id = params.get('id');
  if (!id) return respondError(params, 10, 'Missing parameter: id');
  const track = await env.DB.prepare('SELECT * FROM tracks WHERE id = ?').bind(id).first<any>();
  if (!track) return respondError(params, 70, 'Song not found');
  const lyrics = track.lyrics ?? '';
  // Return unsynced lyrics (no timestamps) — upgrade to synced when we have timed data
  return jsonResponse({
    lyricsList: {
      structuredLyrics: lyrics ? [{
        displayArtist: track.artist_name,
        displayTitle: track.title,
        lang: 'xxx',
        offset: 0,
        synced: false,
        line: lyrics.split('\n').map((l: string) => ({ value: l }))
      }] : []
    }
  });
}

async function handleGetStarted2(params: URLSearchParams, env: Env): Promise<Response> {
  const user = params.get('u') ?? 'admin';
  const rows = await env.DB.prepare(`
    SELECT t.*, s.starred_at FROM tracks t
    JOIN starred s ON s.item_id = t.id
    WHERE s.user = ? AND s.item_type = 'track'
    ORDER BY s.starred_at DESC
  `).bind(user).all<any>();

  const starredAlbums = await env.DB.prepare(`
    SELECT a.*, s.starred_at FROM albums a
    JOIN starred s ON s.item_id = a.id
    WHERE s.user = ? AND s.item_type = 'album'
    ORDER BY s.starred_at DESC
  `).bind(user).all<any>();

  const starredArtists = await env.DB.prepare(`
    SELECT ar.*, s.starred_at FROM artists ar
    JOIN starred s ON s.item_id = ar.id
    WHERE s.user = ? AND s.item_type = 'artist'
    ORDER BY s.starred_at DESC
  `).bind(user).all<any>();

  // starred_at must be on each item per spec
  const starredTrackMap = new Map(rows.results.map((r: any) => [r.id, r.starred_at]));
  const starredAlbumMap = new Map(starredAlbums.results.map((r: any) => [r.id, r.starred_at]));
  const starredArtistMap = new Map(starredArtists.results.map((r: any) => [r.id, r.starred_at]));

  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') return jsonResponse({ starred2: {
    artist: starredArtists.results.map((a: any) => ({ id: a.id, name: a.name, starred: a.starred_at })),
    album: starredAlbums.results.map((a: any) => ({ ...albumJson(a), starred: a.starred_at })),
    song: rows.results.map((t: any) => ({ ...trackJson(t), starred: t.starred_at }))
  }});
  return xmlResponse(`<starred2>
    ${starredArtists.results.map((a: any) => `<artist id="${esc(a.id)}" name="${esc(a.name)}" starred="${a.starred_at ?? ''}"/>`).join('')}
    ${starredAlbums.results.map((a: any) => albumXml({ ...a, starred_at: a.starred_at }) + '</album>').join('')}
    ${rows.results.map((t: any) => trackXml({ ...t, starred_at: t.starred_at })).join('')}
  </starred2>`);
}

// getStarred — v1 alias
async function handleGetStarred(params: URLSearchParams, env: Env): Promise<Response> {
  const res = await handleGetStarted2(params, env);
  const text = await res.text();
  return new Response(
    text.replace(/<starred2>/g, '<starred>').replace(/<\/starred2>/g, '</starred>').replace(/"starred2"/, '"starred"'),
    { headers: res.headers }
  );
}

async function handleGetRandomSongs(params: URLSearchParams, env: Env): Promise<Response> {
  const size = Math.min(parseInt(params.get('size') ?? '10'), 500);
  const genre = params.get('genre');
  const fromYear = params.get('fromYear');
  const toYear = params.get('toYear');

  let sql = 'SELECT * FROM tracks WHERE 1=1';
  const binds: any[] = [];
  if (genre) { sql += ' AND genre LIKE ?'; binds.push(`%${genre}%`); }
  if (fromYear) { sql += ' AND year >= ?'; binds.push(parseInt(fromYear)); }
  if (toYear) { sql += ' AND year <= ?'; binds.push(parseInt(toYear)); }
  sql += ' ORDER BY RANDOM() LIMIT ?';
  binds.push(size);

  const rows = await env.DB.prepare(sql).bind(...binds).all<any>();
  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') return jsonResponse({ randomSongs: { song: rows.results.map(trackJson) } });
  return xmlResponse(`<randomSongs>${rows.results.map(trackXml).join('')}</randomSongs>`);
}

async function handleGetNowPlaying(params: URLSearchParams, env: Env, req: Request): Promise<Response> {
  const user = params.get('u') ?? 'admin';
  const meta = await env.DB.prepare(
    'SELECT pq.current_track_id, pq.current_position FROM play_queue pq WHERE pq.user = ? LIMIT 1'
  ).bind(user).first<any>();
  const fmt = params.get('f') ?? 'xml';
  if (!meta?.current_track_id) {
    if (fmt === 'json') return jsonResponse({ nowPlaying: { entry: [] } });
    return xmlResponse('<nowPlaying/>');
  }
  const track = await env.DB.prepare('SELECT * FROM tracks WHERE id = ?').bind(meta.current_track_id).first<any>();
  if (!track) {
    if (fmt === 'json') return jsonResponse({ nowPlaying: { entry: [] } });
    return xmlResponse('<nowPlaying/>');
  }
  const entry = { ...trackJson(track), username: user, minutesAgo: 0, playerId: 1 };
  if (fmt === 'json') return jsonResponse({ nowPlaying: { entry: [entry] } });
  return xmlResponse(`<nowPlaying><entry ${Object.entries(entry).filter(([,v])=>v!==undefined).map(([k,v])=>`${k}="${esc(String(v))}"`).join(' ')}/></nowPlaying>`);
}

// ── Bookmarks ─────────────────────────────────────────────────────────────────

async function handleGetBookmarks(params: URLSearchParams, env: Env): Promise<Response> {
  const user = params.get('u') ?? 'admin';
  const rows = await env.DB.prepare(`
    SELECT b.*, t.* FROM bookmarks b
    JOIN tracks t ON t.id = b.track_id
    WHERE b.user = ?
    ORDER BY b.changed_at DESC
  `).bind(user).all<any>();

  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') {
    return jsonResponse({ bookmarks: { bookmark: rows.results.map(b => ({
      position: b.position, username: user, comment: b.comment ?? '',
      created: b.created_at, changed: b.changed_at,
      entry: trackJson(b)
    }))}});
  }
  const xml = rows.results.map(b =>
    `<bookmark position="${b.position}" username="${esc(user)}" comment="${esc(b.comment ?? '')}" created="${b.created_at}" changed="${b.changed_at}">${trackXml(b)}</bookmark>`
  ).join('');
  return xmlResponse(`<bookmarks>${xml}</bookmarks>`);
}

async function handleCreateBookmark(params: URLSearchParams, env: Env): Promise<Response> {
  const user = params.get('u') ?? 'admin';
  const id = params.get('id');
  const position = parseInt(params.get('position') ?? '0');
  const comment = params.get('comment') ?? '';
  if (!id) return respondError(params, 10, 'Missing parameter: id');
  await env.DB.prepare(`
    INSERT INTO bookmarks (user, track_id, position, comment, changed_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user, track_id) DO UPDATE SET position=excluded.position, comment=excluded.comment, changed_at=datetime('now')
  `).bind(user, id, position, comment).run();
  return respond(params, '');
}

async function handleDeleteBookmark(params: URLSearchParams, env: Env): Promise<Response> {
  const user = params.get('u') ?? 'admin';
  const id = params.get('id');
  if (!id) return respondError(params, 10, 'Missing parameter: id');
  await env.DB.prepare('DELETE FROM bookmarks WHERE user = ? AND track_id = ?').bind(user, id).run();
  return respond(params, '');
}

// ── Play Queue ────────────────────────────────────────────────────────────────

async function handleGetPlayQueue(params: URLSearchParams, env: Env): Promise<Response> {
  const user = params.get('u') ?? 'admin';
  const meta = await env.DB.prepare(`
    SELECT current_track_id, current_position, changed_at FROM play_queue
    WHERE user = ? ORDER BY position LIMIT 1
  `).bind(user).first<any>();
  if (!meta) {
    const fmt = params.get('f') ?? 'xml';
    if (fmt === 'json') return jsonResponse({ playQueue: { entry: [] } });
    return xmlResponse('<playQueue/>');
  }
  const rows = await env.DB.prepare(`
    SELECT t.* FROM play_queue pq
    JOIN tracks t ON t.id = pq.track_id
    WHERE pq.user = ? ORDER BY pq.position
  `).bind(user).all<any>();

  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') {
    return jsonResponse({ playQueue: {
      current: meta.current_track_id, position: meta.current_position,
      username: user, changed: meta.changed_at,
      entry: rows.results.map(trackJson)
    }});
  }
  return xmlResponse(`<playQueue current="${esc(meta.current_track_id ?? '')}" position="${meta.current_position ?? 0}" username="${esc(user)}" changed="${meta.changed_at}">${rows.results.map(trackXml).join('')}</playQueue>`);
}

async function handleSavePlayQueue(params: URLSearchParams, env: Env): Promise<Response> {
  const user = params.get('u') ?? 'admin';
  const ids = params.getAll('id');
  const current = params.get('current') ?? '';
  const position = parseInt(params.get('position') ?? '0');

  await env.DB.prepare('DELETE FROM play_queue WHERE user = ?').bind(user).run();
  for (let i = 0; i < ids.length; i++) {
    await env.DB.prepare(`
      INSERT INTO play_queue (user, track_id, position, current_track_id, current_position, changed_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).bind(user, ids[i], i, current, position).run();
  }
  return respond(params, '');
}

// ── Scrobble / Star ───────────────────────────────────────────────────────────

async function handleScrobble(params: URLSearchParams, env: Env): Promise<Response> {
  const ids = params.getAll('id');
  const user = params.get('u') ?? 'admin';
  const submission = params.get('submission') !== 'false';
  for (const id of ids) {
    if (submission) {
      const track = await env.DB.prepare('SELECT album_id FROM tracks WHERE id = ?').bind(id).first<any>();
      if (track) {
        await env.DB.prepare('INSERT OR IGNORE INTO play_history (user, track_id) VALUES (?, ?)').bind(user, id).run();
        await env.DB.prepare(`UPDATE tracks SET play_count = play_count + 1, last_played_at = datetime('now') WHERE id = ?`).bind(id).run();
        await env.DB.prepare(`UPDATE albums SET play_count = play_count + 1, last_played_at = datetime('now') WHERE id = ?`).bind(track.album_id).run();
      }
    }
  }
  return respond(params, '');
}

// ── Internet radio ────────────────────────────────────────────────────────────

async function handleGetInternetRadioStations(params: URLSearchParams, env: Env): Promise<Response> {
  const rows = await env.DB.prepare('SELECT id, name, stream_url, homepage_url FROM internet_radio_stations ORDER BY name').all<any>();
  const stations = (rows.results ?? []).map((r: any) =>
    ({ id: r.id, name: r.name, streamUrl: r.stream_url, homePageUrl: r.homepage_url ?? undefined })
  );
  const fmt = params.get('f');
  if (fmt === 'json') {
    return respond(params, { internetRadioStations: { internetRadioStation: stations } });
  }
  const xml = stations.map((s: any) =>
    '<internetRadioStation id="' + esc(s.id) + '" name="' + esc(s.name) + '" streamUrl="' + esc(s.streamUrl) + '"' + (s.homePageUrl ? ' homePageUrl="' + esc(s.homePageUrl) + '"' : '') + '/>'
  ).join('');
  return xmlResponse('<internetRadioStations>' + xml + '</internetRadioStations>');
}

async function handleCreateInternetRadioStation(params: URLSearchParams, env: Env): Promise<Response> {
  const name = params.get('name');
  const streamUrl = params.get('streamUrl');
  if (!name || !streamUrl) return respondError(params, 10, 'Required: name, streamUrl');
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  await env.DB.prepare('INSERT INTO internet_radio_stations (id, name, stream_url, homepage_url) VALUES (?, ?, ?, ?)')
    .bind(id, name, streamUrl, params.get('homepageUrl') ?? null).run();
  return respond(params, '');
}

async function handleUpdateInternetRadioStation(params: URLSearchParams, env: Env): Promise<Response> {
  const id = params.get('id');
  const name = params.get('name');
  const streamUrl = params.get('streamUrl');
  if (!id || !name || !streamUrl) return respondError(params, 10, 'Required: id, name, streamUrl');
  await env.DB.prepare('UPDATE internet_radio_stations SET name = ?, stream_url = ?, homepage_url = ? WHERE id = ?')
    .bind(name, streamUrl, params.get('homepageUrl') ?? null, id).run();
  return respond(params, '');
}

async function handleDeleteInternetRadioStation(params: URLSearchParams, env: Env): Promise<Response> {
  const id = params.get('id');
  if (!id) return respondError(params, 10, 'Required: id');
  await env.DB.prepare('DELETE FROM internet_radio_stations WHERE id = ?').bind(id).run();
  return respond(params, '');
}

async function handlePlaybackReport(params: URLSearchParams, env: Env): Promise<Response> {
  const id = params.get('id');
  const user = params.get('u') ?? 'admin';
  const event = params.get('event') ?? 'play';
  if (id && event === 'play') {
    const track = await env.DB.prepare('SELECT album_id FROM tracks WHERE id = ?').bind(id).first<any>();
    if (track) {
      await env.DB.prepare('INSERT OR IGNORE INTO play_history (user, track_id) VALUES (?, ?)').bind(user, id).run();
      await env.DB.prepare(`UPDATE tracks SET play_count = play_count + 1, last_played_at = datetime('now') WHERE id = ?`).bind(id).run();
      await env.DB.prepare(`UPDATE albums SET play_count = play_count + 1, last_played_at = datetime('now') WHERE id = ?`).bind(track.album_id).run();
    }
  }
  return respond(params, '');
}

async function handleStar(params: URLSearchParams, env: Env): Promise<Response> {
  const user = params.get('u') ?? 'admin';
  for (const id of params.getAll('id'))
    await env.DB.prepare('INSERT OR IGNORE INTO starred (user, item_id, item_type) VALUES (?, ?, "track")').bind(user, id).run();
  for (const id of params.getAll('albumId'))
    await env.DB.prepare('INSERT OR IGNORE INTO starred (user, item_id, item_type) VALUES (?, ?, "album")').bind(user, id).run();
  for (const id of params.getAll('artistId'))
    await env.DB.prepare('INSERT OR IGNORE INTO starred (user, item_id, item_type) VALUES (?, ?, "artist")').bind(user, id).run();
  return respond(params, '');
}

async function handleUnstar(params: URLSearchParams, env: Env): Promise<Response> {
  const user = params.get('u') ?? 'admin';
  for (const id of [...params.getAll('id'), ...params.getAll('albumId'), ...params.getAll('artistId')])
    await env.DB.prepare('DELETE FROM starred WHERE user = ? AND item_id = ?').bind(user, id).run();
  return respond(params, '');
}

async function handleSetRating(params: URLSearchParams, env: Env): Promise<Response> {
  const id = params.get('id');
  const rating = parseInt(params.get('rating') ?? '0');
  if (!id) return respondError(params, 10, 'Missing parameter: id');
  // Try track first, then album
  const track = await env.DB.prepare('SELECT id FROM tracks WHERE id = ?').bind(id).first<any>();
  if (track) {
    await env.DB.prepare('UPDATE tracks SET user_rating = ? WHERE id = ?').bind(rating, id).run();
  } else {
    await env.DB.prepare('UPDATE albums SET user_rating = ? WHERE id = ?').bind(rating, id).run();
  }
  return respond(params, '');
}

// ── Scan ──────────────────────────────────────────────────────────────────────

async function handleStartScan(params: URLSearchParams, env: Env): Promise<Response> {
  const result = await runIngest(env).catch(e => { console.error('Ingest:', e.message); return { added: 0, total: 0 }; });
  console.log(`Ingest via startScan: +${result.added}/${result.total}`);
  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') return jsonResponse({ scanStatus: { scanning: false, count: result.added } });
  return xmlResponse(`<scanStatus scanning="false" count="${result.added}"/>`);
}

async function handleGetScanStatus(params: URLSearchParams, _env: Env): Promise<Response> {
  const fmt = params.get('f') ?? 'xml';
  if (fmt === 'json') return jsonResponse({ scanStatus: { scanning: false, count: 0 } });
  return xmlResponse('<scanStatus scanning="false" count="0"/>');
}

// ── Stream / Cover Art ────────────────────────────────────────────────────────

async function handleStream(params: URLSearchParams, env: Env, _request: Request): Promise<Response> {
  const id = params.get('id');
  if (!id) return respondError(params, 10, 'Missing parameter: id');
  const track = await env.DB.prepare('SELECT path, content_type FROM tracks WHERE id = ?').bind(id).first<any>();
  if (!track) return respondError(params, 70, 'Track not found');
  const presigned = await signS3Url(env, track.path);
  return Response.redirect(presigned, 302);
}

async function handleGetCoverArt(params: URLSearchParams, env: Env): Promise<Response> {
  const id = params.get('id');
  if (!id) return new Response('Not found', { status: 404 });

  // Helper: generate presigned URL for a Garage key and redirect
  async function garageRedirect(key: string): Promise<Response> {
    const url = await signS3Url(env, key, 3600);
    return Response.redirect(url, 302);
  }

  // 1. Try album directly by id — cover_art_key (Garage) takes priority over thumb_url (CDN)
  const album = await env.DB.prepare(
    'SELECT cover_art_key, thumb_url FROM albums WHERE id = ? OR cover_art_id = ?'
  ).bind(id, id).first<any>();
  if (album?.cover_art_key) return garageRedirect(album.cover_art_key);
  if (album?.thumb_url) return Response.redirect(album.thumb_url, 302);

  // 2. Try track → resolve to its album
  const track = await env.DB.prepare(
    'SELECT album_id FROM tracks WHERE id = ?'
  ).bind(id).first<any>();
  if (track) {
    const al = await env.DB.prepare(
      'SELECT cover_art_key, thumb_url FROM albums WHERE id = ?'
    ).bind(track.album_id).first<any>();
    if (al?.cover_art_key) return garageRedirect(al.cover_art_key);
    if (al?.thumb_url) return Response.redirect(al.thumb_url, 302);
  }

  return new Response('No cover art', { status: 404 });
}

// ── AWS S3 presigned URL ──────────────────────────────────────────────────────

async function signS3Url(env: Env, key: string, expiresIn = 3600): Promise<string> {
  const region    = env.S3_REGION;
  const bucket    = env.S3_BUCKET;
  const endpoint  = env.S3_ENDPOINT;
  const accessKey = env.S3_ACCESS_KEY;
  const secretKey = env.S3_SECRET_KEY;

  const now  = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const time = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';

  const credentialScope = `${date}/${region}/s3/aws4_request`;
  const credential      = `${accessKey}/${credentialScope}`;

  const encodedKey = key.split('/').map(s => encodeURIComponent(s)).join('/');
  const canonicalUri = `/${bucket}/${encodedKey}`;

  const url = new URL(`${endpoint}${canonicalUri}`);
  url.searchParams.set('X-Amz-Algorithm',    'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential',   credential);
  url.searchParams.set('X-Amz-Date',         time);
  url.searchParams.set('X-Amz-Expires',      String(expiresIn));
  url.searchParams.set('X-Amz-SignedHeaders', 'host');

  const canonicalQS = [...url.searchParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');

  const canonicalRequest = ['GET', canonicalUri, canonicalQS, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');

  const enc  = (s: string) => new TextEncoder().encode(s);
  const hmac = async (k: ArrayBuffer | Uint8Array, msg: string) => {
    const key = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return crypto.subtle.sign('HMAC', key, enc(msg));
  };
  const hash = async (s: string) => {
    const buf = await crypto.subtle.digest('SHA-256', enc(s));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  };

  const stringToSign = ['AWS4-HMAC-SHA256', time, credentialScope, await hash(canonicalRequest)].join('\n');
  let sigKey: ArrayBuffer = enc(`AWS4${secretKey}`);
  sigKey = await hmac(sigKey, date);
  sigKey = await hmac(sigKey, region);
  sigKey = await hmac(sigKey, 's3');
  sigKey = await hmac(sigKey, 'aws4_request');

  const sig = Array.from(new Uint8Array(await hmac(sigKey, stringToSign)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  url.searchParams.set('X-Amz-Signature', sig);
  return url.toString();
}

async function s3AuthFetch(env: Env, path: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const { S3_ENDPOINT: endpoint, S3_BUCKET: bucket, S3_REGION: region,
          S3_ACCESS_KEY: accessKey, S3_SECRET_KEY: secretKey } = env;
  const url = new URL(`${endpoint}/${bucket}${path}`);
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const time = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const credentialScope = `${date}/${region}/s3/aws4_request`;

  const hdrs: Record<string, string> = { host: url.host, 'x-amz-date': time, ...extraHeaders };
  const sortedKeys = Object.keys(hdrs).sort();
  const canonicalHeaders = sortedKeys.map(k => `${k}:${hdrs[k]}\n`).join('');
  const signedHeaders = sortedKeys.join(';');
  const canonicalQueryString = [...url.searchParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');

  const canonicalRequest = ['GET', url.pathname, canonicalQueryString,
    canonicalHeaders, signedHeaders, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'].join('\n');

  const enc = (s: string) => new TextEncoder().encode(s);
  const hmac = async (k: ArrayBuffer | Uint8Array, msg: string) => {
    const key = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return crypto.subtle.sign('HMAC', key, enc(msg));
  };
  const hashHex = async (s: string) => {
    const b = await crypto.subtle.digest('SHA-256', enc(s));
    return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
  };

  const stringToSign = ['AWS4-HMAC-SHA256', time, credentialScope, await hashHex(canonicalRequest)].join('\n');
  let sigKey: ArrayBuffer = enc(`AWS4${secretKey}`);
  sigKey = await hmac(sigKey, date);
  sigKey = await hmac(sigKey, region);
  sigKey = await hmac(sigKey, 's3');
  sigKey = await hmac(sigKey, 'aws4_request');
  const sig = Array.from(new Uint8Array(await hmac(sigKey, stringToSign)))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  return fetch(url.toString(), {
    headers: {
      ...hdrs,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
      'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
  });
}

// ── Ingest ────────────────────────────────────────────────────────────────────

async function stableId(str: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

function ext2mime(suffix: string): string {
  const m: Record<string, string> = {
    flac: 'audio/flac', mp3: 'audio/mpeg', m4a: 'audio/mp4',
    aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/opus', wav: 'audio/wav',
  };
  return m[suffix?.toLowerCase()] ?? 'audio/mpeg';
}

async function listAudioKeys(env: Env): Promise<{ key: string; size: number }[]> {
  const results: { key: string; size: number }[] = [];
  let token: string | undefined;
  do {
    const qs = `?list-type=2&prefix=audio/&max-keys=1000${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`;
    const res = await s3AuthFetch(env, qs);
    const xml = await res.text();
    if (!res.ok) { console.error('S3 list error', res.status, xml.slice(0, 500)); break; }
    const decodeXml = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => decodeXml(m[1]));
    const sizes = [...xml.matchAll(/<Size>([^<]+)<\/Size>/g)].map(m => parseInt(m[1]));
    for (let i = 0; i < keys.length; i++) {
      if (/\.(flac|mp3|m4a|aac|ogg|opus|wav)$/i.test(keys[i]))
        results.push({ key: keys[i], size: sizes[i] ?? 0 });
    }
    token = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1];
  } while (token);
  return results;
}

interface AudioTags {
  artist?: string; album?: string; title?: string;
  year?: number; trackNo?: number; discNo?: number; genre?: string;
}

function parseFLAC(buf: ArrayBuffer): AudioTags {
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 0x66 || u8[1] !== 0x4C || u8[2] !== 0x61 || u8[3] !== 0x43) return {};
  let offset = 4;
  while (offset + 4 < buf.byteLength) {
    const isLast = (u8[offset] >> 7) & 1;
    const blockType = u8[offset] & 0x7F;
    const blockLen = (u8[offset+1] << 16) | (u8[offset+2] << 8) | u8[offset+3];
    offset += 4;
    if (blockType === 4 && offset + blockLen <= buf.byteLength) {
      const view = new DataView(buf);
      const dec = new TextDecoder('utf-8');
      const vendorLen = view.getUint32(offset, true);
      let o = offset + 4 + vendorLen;
      const count = view.getUint32(o, true); o += 4;
      const tags: Record<string, string> = {};
      for (let i = 0; i < count && o + 4 <= buf.byteLength; i++) {
        const len = view.getUint32(o, true); o += 4;
        if (o + len > buf.byteLength) break;
        const s = dec.decode(new Uint8Array(buf, o, len)); o += len;
        const eq = s.indexOf('=');
        if (eq > 0) tags[s.slice(0, eq).toUpperCase()] = s.slice(eq + 1);
      }
      return {
        artist: tags['ALBUMARTIST'] || tags['ARTIST'], album: tags['ALBUM'],
        title: tags['TITLE'], year: tags['DATE'] ? parseInt(tags['DATE']) : undefined,
        trackNo: tags['TRACKNUMBER'] ? parseInt(tags['TRACKNUMBER']) : undefined,
        discNo: tags['DISCNUMBER'] ? parseInt(tags['DISCNUMBER']) : undefined,
        genre: tags['GENRE'],
      };
    }
    offset += blockLen;
    if (isLast) break;
  }
  return {};
}

function parseID3v2(buf: ArrayBuffer): AudioTags {
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 0x49 || u8[1] !== 0x44 || u8[2] !== 0x33) return {};
  const size = ((u8[6] & 0x7F) << 21) | ((u8[7] & 0x7F) << 14) | ((u8[8] & 0x7F) << 7) | (u8[9] & 0x7F);
  const view = new DataView(buf);
  let offset = 10;
  const end = Math.min(10 + size, buf.byteLength);
  const tags: Record<string, string> = {};
  while (offset + 10 < end) {
    const frameId = String.fromCharCode(u8[offset], u8[offset+1], u8[offset+2], u8[offset+3]);
    if (frameId[0] === '\0') break;
    const frameSize = view.getUint32(offset + 4, false);
    offset += 10;
    if (frameSize > 0 && offset + frameSize <= buf.byteLength && frameId.startsWith('T')) {
      const enc = u8[offset];
      const textBuf = new Uint8Array(buf, offset + 1, frameSize - 1);
      try {
        const decoder = (enc === 1 || enc === 2) ? new TextDecoder('utf-16')
          : enc === 3 ? new TextDecoder('utf-8') : new TextDecoder('latin1');
        tags[frameId] = decoder.decode(textBuf).replace(/\0/g, '').trim();
      } catch {}
    }
    offset += frameSize;
  }
  return {
    artist: tags['TPE2'] || tags['TPE1'], album: tags['TALB'], title: tags['TIT2'],
    year: tags['TDRC'] ? parseInt(tags['TDRC']) : (tags['TYER'] ? parseInt(tags['TYER']) : undefined),
    trackNo: tags['TRCK'] ? parseInt(tags['TRCK']) : undefined,
    discNo: tags['TPOS'] ? parseInt(tags['TPOS']) : undefined,
    genre: tags['TCON']?.replace(/^\(\d+\)$/, ''),
  };
}

async function parseTags(env: Env, key: string): Promise<AudioTags> {
  const encodedKey = key.split('/').map(s => encodeURIComponent(s)).join('/');
  const res = await s3AuthFetch(env, `/${encodedKey}`, { range: 'bytes=0-524287' });
  if (!res.ok) return {};
  const buf = await res.arrayBuffer();
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0x66 && u8[1] === 0x4C && u8[2] === 0x61 && u8[3] === 0x43) return parseFLAC(buf);
  if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) return parseID3v2(buf);
  return {};
}

async function runIngest(env: Env): Promise<{ added: number; total: number }> {
  const objects = await listAudioKeys(env);
  const existing = await env.DB.prepare('SELECT path FROM tracks').all<{ path: string }>();
  const existingPaths = new Set(existing.results.map(r => r.path));
  const newObjects = objects.filter(o => !existingPaths.has(o.key));
  let added = 0;

  for (const { key, size } of newObjects) {
    try {
      const tags = await parseTags(env, key);
      const suffix = key.split('.').pop()?.toLowerCase() ?? 'mp3';
      const artistName = tags.artist || 'Unknown Artist';
      const albumName  = tags.album  || 'Unknown Album';
      const title      = tags.title  || key.split('/').pop()?.replace(/\.[^.]+$/, '') || 'Unknown';
      const artistId = await stableId(`artist:${artistName}`);
      const albumId  = await stableId(`album:${artistName}:${albumName}`);
      const trackId  = await stableId(`track:${key}`);

      await env.DB.prepare('INSERT OR IGNORE INTO artists (id, name, sort_name) VALUES (?, ?, ?)').bind(artistId, artistName, artistName).run();
      await env.DB.prepare('INSERT OR IGNORE INTO albums (id, name, artist_id, artist_name, year, genre) VALUES (?, ?, ?, ?, ?, ?)').bind(albumId, albumName, artistId, artistName, tags.year ?? null, tags.genre ?? null).run();
      await env.DB.prepare(`INSERT OR REPLACE INTO tracks
        (id, title, album_id, album_name, artist_id, artist_name,
         track_number, disc_number, year, genre, duration, bit_rate,
         size, suffix, content_type, path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`)
        .bind(trackId, title, albumId, albumName, artistId, artistName,
              tags.trackNo ?? null, tags.discNo ?? 1,
              tags.year ?? null, tags.genre ?? null,
              size, suffix, ext2mime(suffix), key).run();
      added++;
    } catch (e: any) {
      console.error(`Ingest failed for ${key}:`, e.message);
    }
  }
  return { added, total: objects.length };
}

// ── User management ──────────────────────────────────────────────────────────

async function handleGetUser(params: URLSearchParams, env: Env): Promise<Response> {
  const username = params.get('username') ?? params.get('u') ?? env.ADMIN_USERNAME;
  const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<any>();
  const fmt = params.get('f') ?? 'xml';
  const u = user ?? { username, email: '', admin_role: 1, settings_role: 1, stream_role: 1,
    download_role: 1, upload_role: 1, playlist_role: 1, cover_art_role: 1,
    comment_role: 1, podcast_role: 0, scrobbling_enabled: 1 };
  const obj = {
    username: u.username, email: u.email ?? '', scrobblingEnabled: !!u.scrobbling_enabled,
    adminRole: !!u.is_admin || !!u.admin_role, settingsRole: !!u.settings_role,
    downloadRole: !!u.download_role, uploadRole: !!u.upload_role,
    playlistRole: !!u.playlist_role, coverArtRole: !!u.cover_art_role,
    commentRole: !!u.comment_role, podcastRole: !!u.podcast_role,
    streamRole: !!u.stream_role, jukeboxRole: false, shareRole: false,
    apiKey: u.api_key ?? undefined,
  };
  if (fmt === 'json') return jsonResponse({ user: obj });
  return xmlResponse(`<user username="${esc(obj.username)}" email="${esc(obj.email)}" scrobblingEnabled="${obj.scrobblingEnabled}" adminRole="${obj.adminRole}" settingsRole="${obj.settingsRole}" downloadRole="${obj.downloadRole}" uploadRole="${obj.uploadRole}" playlistRole="${obj.playlistRole}" coverArtRole="${obj.coverArtRole}" commentRole="${obj.commentRole}" podcastRole="${obj.podcastRole}" streamRole="${obj.streamRole}" jukeboxRole="false" shareRole="false"/>`);
}

async function handleGetUsers(params: URLSearchParams, env: Env): Promise<Response> {
  const rows = await env.DB.prepare('SELECT * FROM users').all<any>();
  const fmt = params.get('f') ?? 'xml';
  const mapUser = (u: any) => ({
    username: u.username, email: u.email ?? '',
    adminRole: !!u.is_admin || !!u.admin_role, streamRole: !!u.stream_role,
    downloadRole: !!u.download_role, playlistRole: !!u.playlist_role,
  });
  if (fmt === 'json') return jsonResponse({ users: { user: rows.results.map(mapUser) } });
  const xml = rows.results.map(u => `<user username="${esc(u.username)}" email="${esc(u.email ?? '')}" adminRole="${!!(u.is_admin||u.admin_role)}" streamRole="${!!u.stream_role}"/>`).join('');
  return xmlResponse(`<users>${xml}</users>`);
}

async function handleCreateUser(params: URLSearchParams, env: Env): Promise<Response> {
  const username = params.get('username');
  const password = params.get('password');
  if (!username || !password) return respondError(params, 10, 'Missing username or password');
  const apiKey = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare(`
    INSERT INTO users (id, username, password_hash, email, api_key, is_admin,
      stream_role, download_role, upload_role, playlist_role, cover_art_role, comment_role, scrobbling_enabled)
    VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, 1, ?, ?, 1, 1, 1, 1)
  `).bind(username, password, params.get('email') ?? '', apiKey,
    params.get('adminRole') === 'true' ? 1 : 0,
    params.get('downloadRole') === 'false' ? 0 : 1,
    params.get('uploadRole') === 'true' ? 1 : 0,
  ).run();
  return respond(params, '');
}

async function handleUpdateUser(params: URLSearchParams, env: Env): Promise<Response> {
  const username = params.get('username');
  if (!username) return respondError(params, 10, 'Missing parameter: username');
  const password = params.get('password');
  const email = params.get('email');
  if (password) await env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = datetime("now") WHERE username = ?').bind(password, username).run();
  if (email) await env.DB.prepare('UPDATE users SET email = ?, updated_at = datetime("now") WHERE username = ?').bind(email, username).run();
  return respond(params, '');
}

async function handleDeleteUser(params: URLSearchParams, env: Env): Promise<Response> {
  const username = params.get('username');
  if (!username) return respondError(params, 10, 'Missing parameter: username');
  if (username === env.ADMIN_USERNAME) return respondError(params, 50, 'Cannot delete admin user');
  await env.DB.prepare('DELETE FROM users WHERE username = ?').bind(username).run();
  return respond(params, '');
}

async function handleChangePassword(params: URLSearchParams, env: Env): Promise<Response> {
  const username = params.get('username');
  const password = params.get('password');
  if (!username || !password) return respondError(params, 10, 'Missing username or password');
  await env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = datetime("now") WHERE username = ?').bind(password, username).run();
  return respond(params, '');
}

async function handleGetAvatar(params: URLSearchParams, env: Env): Promise<Response> {
  const username = params.get('username') ?? '';
  const user = await env.DB.prepare('SELECT avatar_url FROM users WHERE username = ?').bind(username).first<any>();
  if (user?.avatar_url) return Response.redirect(user.avatar_url, 302);
  // Return 1x1 transparent PNG — clients expect an image, not an error
  const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const bytes = Uint8Array.from(atob(png1x1), c => c.charCodeAt(0));
  return new Response(bytes, { headers: { 'Content-Type': 'image/png' } });
}

// ── Router ────────────────────────────────────────────────────────────────────

const ROUTES: Record<string, (p: URLSearchParams, env: Env, req: Request) => Promise<Response>> = {
  // System
  'ping':                       (p, e) => handlePing(p, e),
  'getLicense':                  (p, e) => handleGetLicense(p, e),
  'getOpenSubsonicExtensions':   (p, e) => handleGetOpenSubsonicExtensions(p, e),
  // Library browsing
  'getMusicFolders':             (p, e) => handleGetMusicFolders(p, e),
  'getIndexes':                  (p, e) => handleGetIndexes(p, e),
  'getMusicDirectory':           (p, e) => handleGetMusicDirectory(p, e),
  'getArtists':                  (p, e) => handleGetArtists(p, e),
  'getArtist':                   (p, e) => handleGetArtist(p, e),
  'getArtistInfo':               (p, e) => handleGetArtistInfo2(p, e),
  'getArtistInfo2':              (p, e) => handleGetArtistInfo2(p, e),
  'getAlbum':                    (p, e) => handleGetAlbum(p, e),
  'getAlbumInfo':                (p, e) => handleGetAlbumInfo2(p, e),
  'getAlbumInfo2':               (p, e) => handleGetAlbumInfo2(p, e),
  'getSong':                     (p, e) => handleGetSong(p, e),
  'getGenres':                   (p, e) => handleGetGenres(p, e),
  'getSongsByGenre':             (p, e) => handleGetSongsByGenre(p, e),
  'getTopSongs':                 (p, e) => handleGetTopSongs(p, e),
  'getSimilarSongs':             (p, e) => handleGetSimilarSongs(p, e),
  'getSimilarSongs2':            (p, e) => handleGetSimilarSongs2(p, e),
  // Album lists
  'getAlbumList':                (p, e) => handleGetAlbumList(p, e),
  'getAlbumList2':               (p, e) => handleGetAlbumList2(p, e),
  'getRandomSongs':              (p, e) => handleGetRandomSongs(p, e),
  'getStarred':                  (p, e) => handleGetStarred(p, e),
  'getStarred2':                 (p, e) => handleGetStarted2(p, e),
  'getNowPlaying':               (p, e, r) => handleGetNowPlaying(p, e, r),
  // Search
  'search2':                     (p, e) => handleSearch2(p, e),
  'search3':                     (p, e) => handleSearch3(p, e),
  // Playlists
  'getPlaylists':                (p, e) => handleGetPlaylists(p, e),
  'getPlaylist':                 (p, e) => handleGetPlaylist(p, e),
  'createPlaylist':              (p, e) => handleCreatePlaylist(p, e),
  'updatePlaylist':              (p, e) => handleUpdatePlaylist(p, e),
  'deletePlaylist':              (p, e) => handleDeletePlaylist(p, e),
  // Media retrieval
  'stream':                      (p, e, r) => handleStream(p, e, r),
  'download':                    (p, e, r) => handleStream(p, e, r),
  'getCoverArt':                 (p, e) => handleGetCoverArt(p, e),
  // Lyrics
  'getLyrics':                   (p, e) => handleGetLyrics(p, e),
  'getLyricsBySongId':           (p, e) => handleGetLyricsBySongId(p, e),
  // Annotation
  'scrobble':                    (p, e) => handleScrobble(p, e),
  'star':                        (p, e) => handleStar(p, e),
  'unstar':                      (p, e) => handleUnstar(p, e),
  'setRating':                   (p, e) => handleSetRating(p, e),
  // Bookmarks
  'getBookmarks':                (p, e) => handleGetBookmarks(p, e),
  'createBookmark':              (p, e) => handleCreateBookmark(p, e),
  'deleteBookmark':              (p, e) => handleDeleteBookmark(p, e),
  // Play queue
  'getPlayQueue':                (p, e) => handleGetPlayQueue(p, e),
  'savePlayQueue':               (p, e) => handleSavePlayQueue(p, e),
  // Users
  'getUser':                     (p, e) => handleGetUser(p, e),
  'getUsers':                    (p, e) => handleGetUsers(p, e),
  'createUser':                  (p, e) => handleCreateUser(p, e),
  'updateUser':                  (p, e) => handleUpdateUser(p, e),
  'deleteUser':                  (p, e) => handleDeleteUser(p, e),
  'changePassword':              (p, e) => handleChangePassword(p, e),
  'getAvatar':                   (p, e) => handleGetAvatar(p, e),
  // OpenSubsonic
  'playbackReport':              (p, e) => handlePlaybackReport(p, e),
  // Scan
  'startScan':                   (p, e) => handleStartScan(p, e),
  'getScanStatus':               (p, e) => handleGetScanStatus(p, e),
  'getInternetRadioStations':    (p, e) => handleGetInternetRadioStations(p, e),
  'createInternetRadioStation':  (p, e) => handleCreateInternetRadioStation(p, e),
  'updateInternetRadioStation':  (p, e) => handleUpdateInternetRadioStation(p, e),
  'deleteInternetRadioStation':  (p, e) => handleDeleteInternetRadioStation(p, e),
};

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runIngest(env)
        .then(r => console.log(`Ingest: +${r.added}/${r.total}`))
        .catch(e => console.error('Ingest failed:', e.message, e.stack))
    );
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const match = url.pathname.match(/\/rest\/([^.]+)/);
    if (!match) return new Response('Not found', { status: 404 });
    const endpoint = match[1];

    const params = new URLSearchParams(url.search);
    if (request.method === 'POST') {
      try {
        const ct = request.headers.get('content-type') ?? '';
        const body = await request.text();
        const parsed = ct.includes('application/json')
          ? Object.entries(JSON.parse(body))
          : [...new URLSearchParams(body).entries()];
        for (const [k, v] of parsed as [string, string][]) params.set(k, v);
      } catch {}
    }

    const auth = await checkAuth(params, env);
    if (!auth.ok) {
      return respondError(params, 40, 'Wrong username or password');
    }
    // Make authenticated username available via params for handlers that need it
    if (!params.get('u') && auth.username) params.set('u', auth.username);

    const handler = ROUTES[endpoint];
    if (!handler) {
      return respondError(params, 0, `Endpoint not implemented: ${endpoint}`);
    }

    try {
      return await handler(params, env, request);
    } catch (err: any) {
      console.error(`Error in ${endpoint}:`, err);
      return respondError(params, 0, 'Internal server error');
    }
  }
};
