import fs from 'node:fs';
import path from 'node:path';

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const OMDB_API_KEY = process.env.OMDB_API_KEY;
const DAILY_OMDB_CAP = Number(process.env.DAILY_OMDB_CAP || 900);
const MOVIES_FILE = path.resolve('movies.json');

if (!TMDB_API_KEY || !OMDB_API_KEY) {
  console.error('Missing TMDB_API_KEY or OMDB_API_KEY environment variables.');
  process.exit(1);
}

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
  'Science Fiction': 'Sci-Fi',
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mapGenre(omdbGenres = '', tmdbGenreIds = []) {
  const parts = omdbGenres.split(',').map((g) => g.trim()).filter(Boolean);
  if (parts.includes('Comedy') && parts.includes('Romance')) return 'Rom-Com';
  for (const part of parts) {
    if (GENRE_MAP[part]) return GENRE_MAP[part];
  }
  if (tmdbGenreIds.includes(10749) && tmdbGenreIds.includes(35)) return 'Rom-Com';
  return 'Drama';
}

function formatRuntime(rawRuntime) {
  if (!rawRuntime || rawRuntime === 'N/A') return '2h 00m';
  const mins = parseInt(rawRuntime, 10);
  if (Number.isNaN(mins)) return rawRuntime;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

async function fetchTmdbCandidates() {
  const discovered = new Map();

  // Pull up to ~3,000 unique candidate movies across 3 sorted slices
  const queries = [
    { pages: 75, params: 'sort_by=vote_count.desc&vote_count.gte=250&include_adult=false&language=en-US' },
    { pages: 40, params: 'sort_by=popularity.desc&vote_count.gte=250&include_adult=false&language=en-US' },
    { pages: 35, params: 'sort_by=vote_average.desc&vote_count.gte=1000&include_adult=false&language=en-US' }
  ];

  for (const q of queries) {
    for (let page = 1; page <= q.pages; page++) {
      const url = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&${q.params}&page=${page}`;
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`TMDB discover page ${page} returned ${res.status}`);
        break;
      }
      const data = await res.json();
      if (!data.results || data.results.length === 0) break;

      for (const item of data.results) {
        if (!discovered.has(item.id)) {
          discovered.set(item.id, {
            tmdbId: item.id,
            title: item.title,
            releaseDate: item.release_date || '',
            genreIds: item.genre_ids || []
          });
        }
      }
      await sleep(30);
    }
  }

  console.log(`Discovered ${discovered.size} unique TMDB candidate movies.`);
  return Array.from(discovered.values());
}

async function resolveImdbIdFromTmdb(tmdbId) {
  const url = `https://api.themoviedb.org/3/movie/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return data.imdb_id && data.imdb_id.startsWith('tt') ? data.imdb_id : null;
}

async function fetchOmdbByImdbId(imdbId) {
  const url = `https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(OMDB_API_KEY)}`;
  const res = await fetch(url);
  if (!res.ok) return { Response: 'False', Error: `HTTP ${res.status}` };
  return res.json();
}

async function main() {
  const existing = fs.existsSync(MOVIES_FILE)
    ? JSON.parse(fs.readFileSync(MOVIES_FILE, 'utf8'))
    : [];

  const byImdbId = new Map();
  let maxId = 0;

  for (const movie of existing) {
    if (typeof movie.id === 'number' && movie.id > maxId) maxId = movie.id;
    if (movie.imdbId) byImdbId.set(movie.imdbId, movie);
  }

  const candidates = await fetchTmdbCandidates();
  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  // Cap maintenance re-checks to max 50 movies/day so 850+ calls go to brand-new movies
  const existingNeedsEnrichment = existing
    .filter((m) => {
      if (!m.imdbId) return false;
      if (m.imdb10 == null) return true;
      const last = m.lastHydrated ? Date.parse(m.lastHydrated) : 0;
      return !m.posterUrl && now - last > THIRTY_DAYS_MS;
    })
    .slice(0, 50);

  let omdbCalls = 0;
  let addedCount = 0;
  let updatedCount = 0;
  const todayIso = new Date().toISOString().slice(0, 10);

  // Step A: Light maintenance on up to 50 unhydrated existing titles
  for (const movie of existingNeedsEnrichment) {
    if (omdbCalls >= DAILY_OMDB_CAP) break;

    const data = await fetchOmdbByImdbId(movie.imdbId);
    omdbCalls++;

    if (data.Response === 'False') {
      if ((data.Error || '').toLowerCase().includes('limit')) {
        console.warn('OMDb daily limit reached during enrichment. Stopping cleanly.');
        break;
      }
      movie.lastHydrated = todayIso;
      continue;
    }

    const rt = (data.Ratings || []).find((r) => r.Source === 'Rotten Tomatoes');
    const tomatometer = rt ? parseInt(rt.Value, 10) : movie.tomatometer;
    const imdbRaw = data.imdbRating && data.imdbRating !== 'N/A' ? parseFloat(data.imdbRating) : movie.imdbRaw;
    const imdb10 = imdbRaw != null ? Math.round(imdbRaw * 10) : movie.imdb10;
    const reviews =
      data.imdbVotes && data.imdbVotes !== 'N/A'
        ? parseInt(data.imdbVotes.replace(/,/g, ''), 10)
        : movie.reviews;

    const popcorn = typeof movie.popcorn === 'number' ? movie.popcorn : null;
    const audienceAvg =
      popcorn != null && imdb10 != null
        ? Number(((popcorn + imdb10) / 2).toFixed(1))
        : imdb10 ?? popcorn;

    Object.assign(movie, {
      tomatometer: tomatometer ?? movie.tomatometer,
      imdbRaw: imdbRaw ?? movie.imdbRaw,
      imdb10: imdb10 ?? movie.imdb10,
      audienceAvg,
      reviews: Math.max(reviews || 0, movie.reviews || 0),
      runtime: formatRuntime(data.Runtime),
      director: data.Director && data.Director !== 'N/A' ? data.Director : movie.director,
      cast:
        data.Actors && data.Actors !== 'N/A'
          ? data.Actors.split(',').map((s) => s.trim())
          : movie.cast,
      synopsis: data.Plot && data.Plot !== 'N/A' ? data.Plot : movie.synopsis,
      posterUrl: data.Poster && data.Poster !== 'N/A' ? data.Poster : movie.posterUrl || '',
      lastHydrated: todayIso
    });

    updatedCount++;
    await sleep(110);
  }

  // Step B: Discover & add new movies up to DAILY_OMDB_CAP
  for (const cand of candidates) {
    if (omdbCalls >= DAILY_OMDB_CAP) break;

    const imdbId = await resolveImdbIdFromTmdb(cand.tmdbId);
    await sleep(30);

    if (!imdbId || byImdbId.has(imdbId)) continue;

    const data = await fetchOmdbByImdbId(imdbId);
    omdbCalls++;

    if (data.Response === 'False') {
      if ((data.Error || '').toLowerCase().includes('limit')) {
        console.warn('OMDb daily limit reached during discovery. Stopping cleanly.');
        break;
      }
      continue;
    }

    const year = parseInt((data.Year || '').slice(0, 4), 10);
    if (Number.isNaN(year)) continue;

    const reviews =
      data.imdbVotes && data.imdbVotes !== 'N/A'
        ? parseInt(data.imdbVotes.replace(/,/g, ''), 10)
        : 0;
    if (reviews < 500) continue;

    const rt = (data.Ratings || []).find((r) => r.Source === 'Rotten Tomatoes');
    const tomatometer = rt ? parseInt(rt.Value, 10) : null;
    const imdbRaw = data.imdbRating && data.imdbRating !== 'N/A' ? parseFloat(data.imdbRating) : null;
    const imdb10 = imdbRaw != null ? Math.round(imdbRaw * 10) : null;
    if (imdb10 == null && tomatometer == null) continue;

    maxId += 1;
    const record = {
      id: maxId,
      imdbId,
      title: data.Title || cand.title,
      year,
      decade: `${Math.floor(year / 10) * 10}s`,
      genre: mapGenre(data.Genre, cand.genreIds),
      popcorn: null,
      imdbRaw,
      imdb10,
      audienceAvg: imdb10,
      tomatometer: tomatometer ?? imdb10,
      reviews,
      runtime: formatRuntime(data.Runtime),
      director: data.Director && data.Director !== 'N/A' ? data.Director : 'Unknown',
      cast: data.Actors && data.Actors !== 'N/A' ? data.Actors.split(',').map((s) => s.trim()) : [],
      synopsis: data.Plot && data.Plot !== 'N/A' ? data.Plot : '',
      posterGradient: GRADIENTS[maxId % GRADIENTS.length],
      posterUrl: data.Poster && data.Poster !== 'N/A' ? data.Poster : '',
      lastHydrated: todayIso
    };

    existing.push(record);
    byImdbId.set(imdbId, record);
    addedCount++;

    await sleep(110);
  }

  fs.writeFileSync(MOVIES_FILE, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  console.log(
    `Done. OMDb calls: ${omdbCalls}/${DAILY_OMDB_CAP} | Updated: ${updatedCount} | Added: ${addedCount} | Total catalog: ${existing.length}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
