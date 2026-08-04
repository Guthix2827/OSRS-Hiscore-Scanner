# OSRS Hiscore Scanner

A conservative Node.js rewrite of the Python scanner. It checks whether generated names appear on the Old School RuneScape hiscore page and writes CSV output.

> `NOT_ON_HISCORES` does **not** mean that a username is available. A registered account may simply be absent from the hiscores.

## Run with Docker Compose

```bash
docker compose up --build
```

CSV files will be created in:

```text
./output/results.csv
./output/errors.csv
```

To stop gracefully:

```bash
docker compose stop
```

## Run directly with Node.js

Requires Node.js 20 or newer.

```bash
npm start
```

## Configuration

All settings are controlled through environment variables:

| Variable | Default | Meaning |
|---|---:|---|
| `CHARS` | `0123456789abcdefghijklmnopqrstuvwxyz` | Characters used to generate names |
| `NAME_LENGTH` | `3` | Generated name length |
| `CONCURRENCY` | `4` | Number of concurrent workers |
| `TIMEOUT_MS` | `15000` | Request timeout |
| `REQUEST_DELAY_MS` | `250` | Delay after each request per worker |
| `MAX_RETRIES` | `3` | Retry count for transient failures |
| `OUTPUT_DIR` | `./output` | CSV output directory |
| `BASE_URL` | RuneScape hiscore URL | Target URL prefix |
| `USER_AGENT` | Browser-like value | HTTP User-Agent header |

Example:

```bash
docker compose run --rm \
  -e CONCURRENCY=2 \
  -e REQUEST_DELAY_MS=500 \
  scanner
```

## Result statuses

- `ON_HISCORES`: The page returned successfully and no known missing-player marker was found.
- `NOT_ON_HISCORES`: A known missing-player marker appeared in the response.
- `RATE_LIMITED`: The server returned HTTP 429 after retries.
- `HTTP_ERROR`: A non-success HTTP response was returned.
- `TIMEOUT`: The request timed out after retries.
- `REQUEST_ERROR`: A network or fetch error occurred after retries.

## Important limitations

The RuneScape page is HTML and its wording may change. The classifier is therefore intentionally conservative. HTTP failures are saved in `errors.csv`; they are never treated as missing players.
