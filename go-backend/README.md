# Angel One backend — Go

A drop-in Go port of the Node `server.js` SmartAPI proxy. Same `/api/angel/*`
routes and JSON shapes, so the existing React frontend works against it **with
zero changes**. Built to attack the round-trip bottleneck, not to "be faster
because Go" — see below.

## Run

```bash
cd go-backend
go run .            # or: go build -o angelone-backend.exe . && ./angelone-backend.exe
```

Then point the frontend's dev proxy / API base at this server's port (default
`3001`, same as Node). Serves the built SPA from `../dist` too.

### Environment

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `3001` | HTTP port |
| `ANGEL_MASTER_FILE` | `scrip_master.json` | slim scrip master cache path |
| `ANGEL_INDEX_FILE` | `scrip_index.json` | symbol→expiry index cache path |
| `ANGEL_STATIC_ROOT` | `../dist` | built SPA to serve |
| `ANGEL_LOCAL_IP` / `ANGEL_PUBLIC_IP` / `ANGEL_MAC_ADDRESS` | auto / — | Angel headers |
| `FEED_DEBUG` | — | `1` logs the live feed |

## Endpoints (identical to Node)

`POST /api/angel/auto-login` · `POST /logout` · `GET /master-index` ·
`POST /refresh-master` · `POST /option-chain` · `POST /margin` · `POST /charges` ·
`POST /resolve-leg` · `POST /subscribe` · `POST /subscribe-more` ·
`GET /stream` (SSE).

## How the round-trip bottleneck is addressed

The network hop to Angel is fixed latency — no language removes it. What this
backend removes is **paying it more often than necessary**:

1. **Connection pooling + keep-alive** (`internal/angel/client.go`): one shared
   `http.Transport` reuses warm TCP+TLS connections (HTTP/2 multiplexed) across
   every call and every goroutine, skipping the handshake that can add
   100–300 ms per request.
2. **Per-endpoint rate limiting** (token buckets from the documented SmartAPI
   limits): we shape our own traffic to stay under the caps, so we never eat a
   429/ban — which costs far more than any single call.
3. **Short-TTL quote cache + singleflight coalescing** (`internal/angel/cache.go`):
   identical concurrent quote reads (the option chain's spot + bulk quote, a
   basket recalc moments later) collapse into **one** upstream call and share
   the result for `QuoteCacheTTL` (750 ms).
4. **Push, not poll** for live prices: the SmartWebSocket feed
   (`internal/angel/feed.go`) streams ticks; the additive union means every
   basket leg keeps ticking without re-fetching quotes.

Bonus: it compiles to a single ~10 MB static binary (`angelone-backend.exe`),
so deployment is "copy one file."
