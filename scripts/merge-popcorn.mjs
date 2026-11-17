import fs from 'node:fs';

const LOCAL_RT_CSV = 'rt_scores.csv';

const RT_CSV_MIRRORS = [
  'https://raw.githubusercontent.com/rfordatascience/tidytuesday/master/data/2020/2020-04-21/gdpr_violations.csv', // placeholder check skipped below
  'https://raw.githubusercontent.com/erikgregorywebb/datasets/master/rotten-tomatoes.csv',
  'https://raw.githubusercontent.com/prasertcbs/basic-dataset/master/rotten_tomatoes_movies.csv',
  'https://raw.githubusercontent.com/sharmaroshan/Rotten-Tomatoes-Movies-Dataset/master/rotten_tomatoes_movies.csv'
].slice(1);

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

const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function loadCsvText() {
  if (fs.existsSync(LOCAL_RT_CSV)) {
    console.log(`Reading local ${LOCAL_RT_CSV}...`);
    return fs.readFileSync(LOCAL_RT_CSV, 'utf8');
  }

  for (const url of RT_CSV_MIRRORS) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const text = await res.text();
        if (text.includes(',')) {
          console.log(`Fetched RT dataset from ${url}`);
          return text;
        }
      } else {
        console.warn(`Mirror returned HTTP ${res.status}: ${url}`);
      }
    } catch (err) {
      console.warn(`Mirror failed (${err.message}): ${url}`);
    }
  }
  return null;
}

async function main() {
  if (!fs.existsSync('movies.json')) {
    console.warn('movies.json not found; skipping Popcornmeter merge.');
    return;
  }

  const csvText = await loadCsvText();
  if (!csvText) {
    console.warn('No external RT CSV available right now; keeping existing Popcornmeter scores and continuing.');
    return;
  }

  const lines = csvText.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return;

  const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const titleIdx = headers.findIndex((h) => ['title', 'movie_title', 'name'].includes(h));
  const yearIdx = headers.findIndex((h) => ['release_year', 'year', 'original_release_date', 'release_date'].includes(h));
  const verIdx = headers.findIndex((h) => h === 'verified_audience_score');
  const audIdx = headers.findIndex((h) => ['audience_score', 'audience_rating', 'popcorn', 'audience'].includes(h));

  if (titleIdx === -1 || (verIdx === -1 && audIdx === -1)) {
    console.warn('CSV headers did not include expected audience score columns:', headers.join(', '));
    return;
  }

  const lookup = new Map();
  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    const title = normalize(cols[titleIdx]);
    const yearMatch = yearIdx !== -1 ? String(cols[yearIdx] || '').match(/\d{4}/) : null;
    const year = yearMatch ? yearMatch[0] : '';
    const verified = verIdx !== -1 ? parseFloat(cols[verIdx]) : NaN;
    const audience = audIdx !== -1 ? parseFloat(cols[audIdx]) : NaN;
    const score = !Number.isNaN(verified)
      ? Math.round(verified)
      : !Number.isNaN(audience)
        ? Math.round(audience)
        : null;

    if (title && score !== null && score >= 0 && score <= 100) {
      if (year) lookup.set(`${title}_${year}`, score);
      if (!lookup.has(title)) lookup.set(title, score);
    }
  }

  const movies = JSON.parse(fs.readFileSync('movies.json', 'utf8'));
  let updated = 0;

  for (const m of movies) {
    const normTitle = normalize(m.title);
    const score = lookup.get(`${normTitle}_${m.year}`) ?? lookup.get(normTitle);
    if (typeof score === 'number') {
      m.popcorn = score;
      const imdb10 = typeof m.imdb10 === 'number' ? m.imdb10 : null;
      m.audienceAvg = imdb10 !== null ? Number(((m.popcorn + imdb10) / 2).toFixed(1)) : m.popcorn;
      updated++;
    }
  }

  fs.writeFileSync('movies.json', `${JSON.stringify(movies, null, 2)}\n`, 'utf8');
  console.log(`Merged Popcornmeter scores into ${updated} movies (lookup entries: ${lookup.size}).`);
}

main().catch((err) => {
  console.warn('Non-fatal Popcornmeter merge warning:', err.message);
});
