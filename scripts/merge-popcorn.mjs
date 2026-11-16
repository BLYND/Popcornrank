import fs from 'node:fs';

const RT_CSV_URL =
  'https://raw.githubusercontent.com/CrawlFeeds/movies-datasets/main/movies_dataset_rotten_tomatoes_1000.csv';

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

async function main() {
  const res = await fetch(RT_CSV_URL);
  if (!res.ok) throw new Error(`Failed to fetch RT CSV: HTTP ${res.status}`);
  const csvText = await res.text();

  const lines = csvText.split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());

  const titleIdx = headers.indexOf('title');
  const yearIdx = headers.indexOf('release_year');
  const audIdx = headers.indexOf('audience_score');
  const verIdx = headers.indexOf('verified_audience_score');

  const lookup = new Map();
  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    const title = normalize(cols[titleIdx]);
    const year = String(cols[yearIdx] || '').slice(0, 4);
    const verified = parseFloat(cols[verIdx]);
    const audience = parseFloat(cols[audIdx]);
    const score = !Number.isNaN(verified) ? Math.round(verified) : !Number.isNaN(audience) ? Math.round(audience) : null;

    if (title && year && score !== null) {
      lookup.set(`${title}_${year}`, score);
    }
  }

  const movies = JSON.parse(fs.readFileSync('movies.json', 'utf8'));
  let updated = 0;

  for (const m of movies) {
    const key = `${normalize(m.title)}_${m.year}`;
    if (lookup.has(key)) {
      m.popcorn = lookup.get(key);
      const imdb10 = typeof m.imdb10 === 'number' ? m.imdb10 : null;
      m.audienceAvg = imdb10 !== null ? Number(((m.popcorn + imdb10) / 2).toFixed(1)) : m.popcorn;
      updated++;
    }
  }

  fs.writeFileSync('movies.json', `${JSON.stringify(movies, null, 2)}\n`, 'utf8');
  console.log(`Merged Popcornmeter scores into ${updated} movies (lookup size: ${lookup.size}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
