import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { Readable } from 'node:stream';

const RATINGS_URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
const BASICS_URL = 'https://datasets.imdbws.com/title.basics.tsv.gz';
const RT_LOCAL_CSV = 'rt_scores.csv';

const MIN_VOTES = Number(process.env.MIN_VOTES || 15000);
const MAX_NEW_MOVIES = Number(process.env.MAX_NEW_MOVIES || 3000);

const GRADIENTS = [
  'linear-gradient(135deg, #1a73e8 0%, #0d47a1 100%)',
  'linear-gradient(135deg, #188038 0%, #0d5323 100%)',
  'linear-gradient(135deg, #d93025 0%, #7f1d1d 100%)',
  'linear-gradient(135deg, #e37400 0%, #7c2d12 100%)',
  'linear-gradient(135deg, #5e35b1 0%, #311b92 100%)',
  'linear-gradient(135deg, #00838f 0%, #004d40 100%)'
];

const GENRE_MAP = {
  Action: 'Action',
  Adventure: 'Action',
  'Sci-Fi': 'Sci-Fi',
  Comedy: 'Comedy',
  Romance: 'Rom-Com',
  Drama: 'Drama',
  Thriller: 'Thriller',
  Crime: 'Thriller',
  Mystery: 'Thriller',
  Horror: 'Horror',
  Animation: 'Animation'
};

const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function parseCsvLine(line) {
  const cols = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') {
      cur += '"';
      i++;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cols.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

function loadLocalRtLookup() {
  const lookup = new Map();
  if (!fs.existsSync(RT_LOCAL_CSV)) return lookup;

  const lines = fs.readFileSync(RT_LOCAL_CSV, 'utf8').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return lookup;

  const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const titleIdx = headers.findIndex((h) => ['movie_title', 'title', 'name'].includes(h));
  const yearIdx = headers.findIndex((h) => ['original_release_date', 'release_year', 'year', 'release_date'].includes(h));
  const audIdx = headers.findIndex((h) => ['audience_rating', 'audience_score', 'popcorn'].includes(h));
  const critIdx = headers.findIndex((h) => ['tomatometer_rating', 'critic_score', 'tomatometer'].includes(h));
  const dirIdx = headers.findIndex((h) => ['directors', 'director'].includes(h));
  const castIdx = headers.findIndex((h) => ['actors', 'cast'].includes(h));
  const infoIdx = headers.findIndex((h) => ['movie_info', 'synopsis', 'plot'].includes(h));

  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    const title = normalize(cols[titleIdx]);
    const yearMatch = yearIdx !== -1 ? String(cols[yearIdx] || '').match(/\d{4}/) : null;
    const year = yearMatch ? yearMatch[0] : '';
    const aud = audIdx !== -1 ? parseInt(cols[audIdx], 10) : NaN;
    const crit = critIdx !== -1 ? parseInt(cols[critIdx], 10) : NaN;

    if (!title) continue;
    const entry = {
      popcorn: !Number.isNaN(aud) && aud >= 0 && aud <= 100 ? aud : null,
      tomatometer: !Number.isNaN(crit) && crit >= 0 && crit <= 100 ? crit : null,
      director: dirIdx !== -1 ? (cols[dirIdx] || '').split(',')[0].trim() : '',
      cast: castIdx !== -1 ? (cols[castIdx] || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 4) : [],
      synopsis: infoIdx !== -1 ? (cols[infoIdx] || '').trim() : ''
    };
    if (year) lookup.set(`${title}_${year}`, entry);
    if (!lookup.has(title)) lookup.set(title, entry);
  }
  console.log(`Loaded ${lookup.size} Rotten Tomatoes entries from ${RT_LOCAL_CSV}.`);
  return lookup;
}

function mapGenre(rawGenres = '') {
  const parts = rawGenres.split(',').map((g) => g.trim()).filter(Boolean);
  if (parts.includes('Comedy') && parts.includes('Romance')) return 'Rom-Com';
  for (const part of parts) {
    if (GENRE_MAP[part]) return GENRE_MAP[part];
  }
  return 'Drama';
}

function formatRuntime(minsStr) {
  const mins = parseInt(minsStr, 10);
  if (Number.isNaN(mins) || mins <= 0) return '2h 00m';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

async function streamTsvGz(url, onRow) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  const nodeStream = Readable.fromWeb(res.body).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: nodeStream, crlfDelay: Infinity });

  let isHeader = true;
  for await (const line of rl) {
    if (isHeader) {
      isHeader = false;
      continue;
    }
    if (line) onRow(line.split('\t'));
  }
}

async function main() {
  const rtLookup = loadLocalRtLookup();
  const existing = fs.existsSync('movies.json')
    ? JSON.parse(fs.readFileSync('movies.json', 'utf8'))
    : [];

  const existingByImdb = new Map();
  let maxId = 0;
  for (const m of existing) {
    if (typeof m.id === 'number' && m.id > maxId) maxId = m.id;
    if (m.imdbId) existingByImdb.set(m.imdbId, m);
  }

  const ratingsMap = new Map();
  await streamTsvGz(RATINGS_URL, ([tconst, avgRating, numVotes]) => {
    const reviews = parseInt(numVotes, 10);
    const imdbRaw = parseFloat(avgRating);
    if (!Number.isNaN(reviews) && reviews >= MIN_VOTES && !Number.isNaN(imdbRaw)) {
      ratingsMap.set(tconst, { imdbRaw, reviews });
    }
  });

  const candidates = [];
  await streamTsvGz(BASICS_URL, (cols) => {
    const [tconst, titleType, primaryTitle, , isAdult, startYear, , runtimeMinutes, genres] = cols;
    if (titleType !== 'movie' || isAdult !== '0') return;
    const rating = ratingsMap.get(tconst);
    if (!rating) return;

    const year = parseInt(startYear, 10);
    if (Number.isNaN(year) || year < 1920 || year > 2026) return;

    if (existingByImdb.has(tconst)) {
      const cur = existingByImdb.get(tconst);
      if (rating.reviews > (cur.reviews || 0)) cur.reviews = rating.reviews;
      return;
    }

    candidates.push({
      imdbId: tconst,
      title: primaryTitle,
      year,
      runtime: formatRuntime(runtimeMinutes),
      genre: mapGenre(genres === '\\N' ? '' : genres),
      imdbRaw: rating.imdbRaw,
      reviews: rating.reviews
    });
  });

  candidates.sort((a, b) => b.reviews - a.reviews);
  const selected = candidates.slice(0, MAX_NEW_MOVIES);

  for (const item of selected) {
    maxId += 1;
    const imdb10 = Math.round(item.imdbRaw * 10);
    const norm = normalize(item.title);
    const rt = rtLookup.get(`${norm}_${item.year}`) ?? rtLookup.get(norm) ?? {};
    const popcorn = typeof rt.popcorn === 'number' ? rt.popcorn : null;
    const audienceAvg = popcorn !== null ? Number(((popcorn + imdb10) / 2).toFixed(1)) : imdb10;

    existing.push({
      id: maxId,
      imdbId: item.imdbId,
      title: item.title,
      year: item.year,
      decade: `${Math.floor(item.year / 10) * 10}s`,
      genre: item.genre,
      popcorn,
      imdbRaw: item.imdbRaw,
      imdb10,
      audienceAvg,
      tomatometer: typeof rt.tomatometer === 'number' ? rt.tomatometer : null,
      reviews: item.reviews,
      runtime: item.runtime,
      director: rt.director || '',
      cast: rt.cast || [],
      synopsis: rt.synopsis || '',
      posterGradient: GRADIENTS[maxId % GRADIENTS.length],
      posterUrl: ''
    });
  }

  fs.writeFileSync('movies.json', `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  console.log(`Bulk seed complete! Added ${selected.length} movies. Total catalog: ${existing.length}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
