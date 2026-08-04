import { mkdir, open } from 'node:fs/promises';
import process from 'node:process';

const CHARS = process.env.CHARS ?? '0123456789abcdefghijklmnopqrstuvwxyz';
const NAME_LENGTH = parsePositiveInt(process.env.NAME_LENGTH, 3);
const CONCURRENCY = parsePositiveInt(process.env.CONCURRENCY, 4);
const TIMEOUT_MS = parsePositiveInt(process.env.TIMEOUT_MS, 15_000);
const REQUEST_DELAY_MS = parseNonNegativeInt(process.env.REQUEST_DELAY_MS, 250);
const MAX_RETRIES = parseNonNegativeInt(process.env.MAX_RETRIES, 3);
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? './output';

const BASE_URL =
  process.env.BASE_URL ??
  'https://secure.runescape.com/m=hiscore_oldschool/hiscorepersonal?user1=';

const USER_AGENT =
  process.env.USER_AGENT ??
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/127.0 Safari/537.36';

const total = CHARS.length ** NAME_LENGTH;
let processed = 0;
let nextIndex = 0;
let stopping = false;

process.on('SIGINT', () => {
  stopping = true;
  console.log('\nSIGINT received. Finishing active requests...');
});

process.on('SIGTERM', () => {
  stopping = true;
  console.log('\nSIGTERM received. Finishing active requests...');
});

function parsePositiveInt(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function writeCsvRow(handle, values) {
  await handle.write(`${values.map(csvEscape).join(',')}\n`);
}

function nameFromIndex(index) {
  let remaining = index;
  const output = Array(NAME_LENGTH);

  for (let position = NAME_LENGTH - 1; position >= 0; position -= 1) {
    output[position] = CHARS[remaining % CHARS.length];
    remaining = Math.floor(remaining / CHARS.length);
  }

  return output.join('');
}

function claimNextName() {
  if (stopping || nextIndex >= total) return null;
  const name = nameFromIndex(nextIndex);
  nextIndex += 1;
  return name;
}

function classifyPage(statusCode, body) {
  if (statusCode === 429) {
    return { status: 'RATE_LIMITED', details: 'HTTP 429' };
  }

  if (statusCode !== 200) {
    return { status: 'HTTP_ERROR', details: `HTTP ${statusCode}` };
  }

  const text = body.toLowerCase();
  const missingMarkers = ['player not found', 'no player found'];

  if (missingMarkers.some((marker) => text.includes(marker))) {
    return { status: 'NOT_ON_HISCORES', details: '' };
  }

  return { status: 'ON_HISCORES', details: '' };
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    return await fetch(url, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function scanName(name) {
  const url = `${BASE_URL}${encodeURIComponent(name)}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url);
      const body = await response.text();
      const result = classifyPage(response.status, body);

      if (result.status === 'RATE_LIMITED' && attempt < MAX_RETRIES) {
        const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
        const delay = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : Math.min(30_000, 1_000 * 2 ** attempt);

        await sleep(delay);
        continue;
      }

      if (result.status === 'HTTP_ERROR' && response.status >= 500 && attempt < MAX_RETRIES) {
        await sleep(Math.min(10_000, 750 * 2 ** attempt));
        continue;
      }

      return { name, url, ...result };
    } catch (error) {
      const isAbort = error?.name === 'AbortError';

      if (attempt < MAX_RETRIES) {
        await sleep(Math.min(10_000, 750 * 2 ** attempt));
        continue;
      }

      return {
        name,
        url,
        status: isAbort ? 'TIMEOUT' : 'REQUEST_ERROR',
        details: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
      };
    }
  }

  return {
    name,
    url,
    status: 'REQUEST_ERROR',
    details: 'Retry loop exited unexpectedly',
  };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const resultsFile = await open(`${OUTPUT_DIR}/results.csv`, 'w');
  const errorsFile = await open(`${OUTPUT_DIR}/errors.csv`, 'w');

  await writeCsvRow(resultsFile, ['name', 'profile_url', 'status']);
  await writeCsvRow(errorsFile, ['name', 'profile_url', 'status', 'details']);

  let writeChain = Promise.resolve();

  const saveResult = (result) => {
    writeChain = writeChain.then(async () => {
      processed += 1;

      if (result.status === 'ON_HISCORES' || result.status === 'NOT_ON_HISCORES') {
        await writeCsvRow(resultsFile, [result.name, result.url, result.status]);
      } else {
        await writeCsvRow(errorsFile, [
          result.name,
          result.url,
          result.status,
          result.details,
        ]);
      }

      const percent = (processed / total) * 100;
      console.log(
        `[${processed.toLocaleString()}/${total.toLocaleString()}] ` +
          `${percent.toFixed(2).padStart(6)}% ${result.name} -> ${result.status}`,
      );
    });

    return writeChain;
  };

  async function worker(workerId) {
    while (!stopping) {
      const name = claimNextName();
      if (name === null) return;

      const result = await scanName(name);
      await saveResult(result);

      if (REQUEST_DELAY_MS > 0) {
        await sleep(REQUEST_DELAY_MS);
      }
    }

    console.log(`Worker ${workerId} stopped.`);
  }

  try {
    console.log(`Scanning ${total.toLocaleString()} combinations.`);
    console.log(`Concurrency: ${CONCURRENCY}`);
    console.log(`Output directory: ${OUTPUT_DIR}`);
    console.log('NOT_ON_HISCORES does not mean the username is available.\n');

    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, index) => worker(index + 1)),
    );

    await writeChain;
  } finally {
    await resultsFile.close();
    await errorsFile.close();
  }

  console.log('\n====================================');
  console.log(stopping ? 'SCAN STOPPED' : 'SCAN COMPLETE');
  console.log('====================================');
  console.log(`Processed: ${processed.toLocaleString()}/${total.toLocaleString()}`);
  console.log(`Created: ${OUTPUT_DIR}/results.csv`);
  console.log(`Created: ${OUTPUT_DIR}/errors.csv`);
  console.log('====================================');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exitCode = 1;
});
