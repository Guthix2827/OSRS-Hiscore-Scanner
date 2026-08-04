import { mkdir, open } from 'node:fs/promises';
import process from 'node:process';

const CHARS = process.env.CHARS ?? '0123456789abcdefghijklmnopqrstuvwxyz';
const NAME_LENGTH = parsePositiveInt(process.env.NAME_LENGTH, 3);

// Keep the scan deliberately slow because the Hiscores endpoint rate-limits quickly.
const CONCURRENCY = parsePositiveInt(process.env.CONCURRENCY, 1);
const REQUEST_DELAY_MS = parseNonNegativeInt(
    process.env.REQUEST_DELAY_MS,
    2_000,
);
const TIMEOUT_MS = parsePositiveInt(process.env.TIMEOUT_MS, 20_000);
const MAX_RETRIES = parseNonNegativeInt(process.env.MAX_RETRIES, 4);
const MAX_BACKOFF_MS = parsePositiveInt(
    process.env.MAX_BACKOFF_MS,
    60_000,
);
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? './output';

const BASE_URL =
    process.env.BASE_URL ??
    'https://secure.runescape.com/m=hiscore_oldschool/index_lite.ws?player=';

const USER_AGENT =
    process.env.USER_AGENT ??
    'osrs-hiscore-scanner/1.0 (personal research; low request rate)';

const total = CHARS.length ** NAME_LENGTH;

let processed = 0;
let nextIndex = 0;
let stopping = false;

// Every worker shares the same request schedule.
// Even with CONCURRENCY above 1, requests cannot be sent in a burst.
let nextRequestAt = 0;
let rateLimitChain = Promise.resolve();

process.on('SIGINT', () => requestStop('SIGINT'));
process.on('SIGTERM', () => requestStop('SIGTERM'));

function requestStop(signal) {
  stopping = true;
  console.log(`\n${signal} received. Finishing active requests...`);
}

function parsePositiveInt(value, fallback) {
  if (value == null || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
  if (value == null || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function csvEscape(value) {
  const text = String(value ?? '');

  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}

async function writeCsvRow(handle, values) {
  const row = values.map(csvEscape).join(',');
  await handle.write(`${row}\n`);
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
  if (stopping || nextIndex >= total) {
    return null;
  }

  const name = nameFromIndex(nextIndex);
  nextIndex += 1;

  return name;
}

/**
 * Reserves one globally paced request slot.
 *
 * This ensures that multiple workers cannot send requests simultaneously.
 */
function waitForRequestSlot() {
  const reservation = rateLimitChain.then(async () => {
    const waitMs = Math.max(0, nextRequestAt - Date.now());

    if (waitMs > 0) {
      await sleep(waitMs);
    }

    nextRequestAt = Date.now() + REQUEST_DELAY_MS;
  });

  rateLimitChain = reservation.catch(() => {});

  return reservation;
}

function parseRetryAfter(value) {
  if (!value) {
    return null;
  }

  const seconds = Number.parseInt(value, 10);

  if (Number.isInteger(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const date = Date.parse(value);

  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now());
  }

  return null;
}

function retryDelay(attempt, retryAfterHeader = null) {
  const retryAfterMs = parseRetryAfter(retryAfterHeader);

  if (retryAfterMs !== null) {
    return Math.min(MAX_BACKOFF_MS, retryAfterMs);
  }

  const exponential = Math.min(
      MAX_BACKOFF_MS,
      2_000 * 2 ** attempt,
  );

  const jitter = Math.floor(Math.random() * 750);

  return exponential + jitter;
}

/**
 * Hiscores Lite responses contain comma-separated numeric rows.
 *
 * The first row normally represents the overall skill:
 * rank,level,xp
 */
function isValidHiscoreBody(body) {
  const firstLine = body.trim().split(/\r?\n/, 1)[0] ?? '';

  return /^-?\d+,-?\d+,-?\d+$/.test(firstLine);
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);

  try {
    await waitForRequestSlot();

    return await fetch(url, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/plain,*/*;q=0.1',
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

      /*
       * A player missing from the OSRS Hiscores Lite endpoint returns 404.
       *
       * This only means the player is not currently on the Hiscores.
       * It does not guarantee that the RuneScape username is available.
       */
      if (response.status === 404) {
        await response.body?.cancel();

        return {
          name,
          url,
          status: 'NOT_ON_HISCORES',
          details: 'HTTP 404',
        };
      }

      if (response.status === 200) {
        const body = await response.text();

        if (!isValidHiscoreBody(body)) {
          return {
            name,
            url,
            status: 'INVALID_RESPONSE',
            details:
                'HTTP 200 response did not match the Hiscores Lite CSV format',
          };
        }

        return {
          name,
          url,
          status: 'ON_HISCORES',
          details: '',
        };
      }

      const retryable =
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500;

      if (retryable && attempt < MAX_RETRIES) {
        const delay = retryDelay(
            attempt,
            response.headers.get('retry-after'),
        );

        await response.body?.cancel();

        console.warn(
            `${name}: HTTP ${response.status}; ` +
            `retry ${attempt + 1}/${MAX_RETRIES} ` +
            `after ${delay.toLocaleString()} ms`,
        );

        await sleep(delay);
        continue;
      }

      await response.body?.cancel();

      return {
        name,
        url,
        status:
            response.status === 429
                ? 'RATE_LIMITED'
                : 'HTTP_ERROR',
        details: `HTTP ${response.status}`,
      };
    } catch (error) {
      const isAbort = error?.name === 'AbortError';

      if (attempt < MAX_RETRIES) {
        const delay = retryDelay(attempt);

        console.warn(
            `${name}: ${isAbort ? 'timeout' : 'request error'}; ` +
            `retry ${attempt + 1}/${MAX_RETRIES} ` +
            `after ${delay.toLocaleString()} ms`,
        );

        await sleep(delay);
        continue;
      }

      return {
        name,
        url,
        status: isAbort ? 'TIMEOUT' : 'REQUEST_ERROR',
        details:
            `${error?.name ?? 'Error'}: ` +
            `${error?.message ?? String(error)}`,
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
  await mkdir(OUTPUT_DIR, {
    recursive: true,
  });

  const resultsFile = await open(
      `${OUTPUT_DIR}/results.csv`,
      'w',
  );

  const errorsFile = await open(
      `${OUTPUT_DIR}/errors.csv`,
      'w',
  );

  await writeCsvRow(resultsFile, [
    'name',
    'hiscores_url',
    'status',
  ]);

  await writeCsvRow(errorsFile, [
    'name',
    'hiscores_url',
    'status',
    'details',
  ]);

  let writeChain = Promise.resolve();

  function saveResult(result) {
    writeChain = writeChain.then(async () => {
      processed += 1;

      if (
          result.status === 'ON_HISCORES' ||
          result.status === 'NOT_ON_HISCORES'
      ) {
        await writeCsvRow(resultsFile, [
          result.name,
          result.url,
          result.status,
        ]);
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
          `${percent.toFixed(2).padStart(6)}% ` +
          `${result.name} -> ${result.status}`,
      );
    });

    return writeChain;
  }

  async function worker(workerId) {
    while (!stopping) {
      const name = claimNextName();

      if (name === null) {
        return;
      }

      const result = await scanName(name);
      await saveResult(result);
    }

    console.log(`Worker ${workerId} stopped.`);
  }

  try {
    console.log(`Scanning ${total.toLocaleString()} combinations.`);
    console.log(`Endpoint: ${BASE_URL}<name>`);
    console.log(`Concurrency: ${CONCURRENCY}`);
    console.log(
        `Global delay: ${REQUEST_DELAY_MS.toLocaleString()} ms between requests`,
    );
    console.log(`Timeout: ${TIMEOUT_MS.toLocaleString()} ms`);
    console.log(`Retries: ${MAX_RETRIES}`);
    console.log(`Output directory: ${OUTPUT_DIR}`);
    console.log('HTTP 404 is recorded as NOT_ON_HISCORES.');
    console.log(
        'NOT_ON_HISCORES does not mean the username is available.\n',
    );

    await Promise.all(
        Array.from(
            {
              length: CONCURRENCY,
            },
            (_, index) => worker(index + 1),
        ),
    );

    await writeChain;
  } finally {
    await resultsFile.close();
    await errorsFile.close();
  }

  console.log('\n====================================');
  console.log(stopping ? 'SCAN STOPPED' : 'SCAN COMPLETE');
  console.log('====================================');
  console.log(
      `Processed: ${processed.toLocaleString()}/${total.toLocaleString()}`,
  );
  console.log(`Created: ${OUTPUT_DIR}/results.csv`);
  console.log(`Created: ${OUTPUT_DIR}/errors.csv`);
  console.log('====================================');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exitCode = 1;
});