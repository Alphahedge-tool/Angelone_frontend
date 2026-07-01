package angel

import (
	"context"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"

	"angelone-backend/internal/config"
)

// quoteCache is a tiny TTL cache in front of Angel's quote endpoint, paired with
// singleflight so concurrent identical reads collapse into ONE upstream call.
//
// Why this matters for the "bottleneck": loading an option chain fires a spot
// quote and a bulk FULL quote; a basket recalc may re-read the same tokens
// milliseconds later. Without this, each pays the full Angel round-trip. With a
// 750 ms TTL, bursts of identical reads are served locally and the round-trip is
// paid at most ~once per TTL window.
type quoteCache struct {
	mu      sync.RWMutex
	entries map[string]cacheEntry
	group   singleflight.Group
}

type cacheEntry struct {
	value   any
	expires time.Time
}

func newQuoteCache() *quoteCache {
	return &quoteCache{entries: map[string]cacheEntry{}}
}

// do returns a cached value if fresh, otherwise runs fn exactly once across all
// concurrent callers with the same key and caches the result for the TTL.
func (q *quoteCache) do(ctx context.Context, key string, fn func() (any, error)) (any, error) {
	if v, ok := q.get(key); ok {
		return v, nil
	}
	// singleflight: only one in-flight fetch per key; others wait and share it.
	v, err, _ := q.group.Do(key, func() (any, error) {
		if v, ok := q.get(key); ok { // re-check: another caller may have filled it
			return v, nil
		}
		res, err := fn()
		if err != nil {
			return nil, err
		}
		q.set(key, res)
		return res, nil
	})
	return v, err
}

func (q *quoteCache) get(key string) (any, bool) {
	q.mu.RLock()
	defer q.mu.RUnlock()
	e, ok := q.entries[key]
	if !ok || time.Now().After(e.expires) {
		return nil, false
	}
	return e.value, true
}

func (q *quoteCache) set(key string, value any) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.entries[key] = cacheEntry{value: value, expires: time.Now().Add(config.QuoteCacheTTL)}
	// Opportunistic cleanup so the map can't grow unbounded across a session.
	if len(q.entries) > 512 {
		now := time.Now()
		for k, e := range q.entries {
			if now.After(e.expires) {
				delete(q.entries, k)
			}
		}
	}
}
