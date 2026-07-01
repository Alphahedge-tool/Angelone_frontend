// Package angel is the SmartAPI client: pooled HTTP transport, rate limiting,
// request coalescing, auth, market data, and the live WebSocket→SSE feed.
package angel

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"

	"golang.org/x/time/rate"

	"angelone-backend/internal/config"
)

// ── The bottleneck fixes live here ──────────────────────────────────────────
//
// The network round-trip to Angel is fixed latency we can't remove. What we CAN
// remove is paying it more often than necessary:
//
//  1. Connection pooling + keep-alive (the Transport below): every call to
//     Angel reuses a warm TCP+TLS connection instead of doing a fresh DNS →
//     TCP handshake → TLS handshake (which alone can add 100–300 ms per call).
//     Node's global fetch does NOT pool aggressively by default; this does.
//
//  2. Per-endpoint rate limiting (limiters): Angel throttles per endpoint
//     (placeOrder 20/s, getOrderBook 1/s, order-status 10/s). We shape our own
//     traffic to stay just under those limits so we never eat a 429/ban — which
//     would cost far more than any per-call latency.
//
//  3. Request coalescing + short-TTL caching (see cache.go / singleflight in the
//     market layer): when 30 option rows all want the same spot quote in the
//     same 750 ms, we make ONE upstream call and share the result.
//
// None of this is Go-specific — but Go's std lib makes it clean, and a single
// shared Transport across all goroutines pools connections for the whole
// process for free.

// endpointLimits are conservative request/second caps per SmartAPI endpoint
// prefix, from the documented rate limits (kept just under the real ceiling).
var endpointLimits = map[string]rate.Limit{
	"/rest/secure/angelbroking/order/v1/placeOrder":     18, // doc: 20/s
	"/rest/secure/angelbroking/order/v1/getOrderBook":   1,  // doc: 1/s
	"/rest/secure/angelbroking/order/v1/getTradeBook":   1,
	"/rest/secure/angelbroking/order/v1/details":        9, // doc: 10/s
	"/rest/secure/angelbroking/market/v1/quote":         9, // fair-use ~10/s
	"/rest/secure/angelbroking/order/v1/getLtpData":     9,
	"/rest/secure/angelbroking/margin/v1/batch":         9,
	"/rest/secure/angelbroking/brokerage/v1/estimateCharges": 9,
	"/rest/secure/angelbroking/marketData/v1/optionGreek":    9,
}

// defaultLimit applies to any endpoint without a specific rule (general order
// fair-use cap ~10/s historically).
const defaultLimit rate.Limit = 8

// Client is a rate-limited, connection-pooling SmartAPI HTTP client. One Client
// is shared across the whole server; it is safe for concurrent use.
type Client struct {
	http     *http.Client
	cfg      config.Config
	limiters *limiterSet
	cache    *quoteCache
}

// NewClient builds the shared client with a tuned, pooling Transport.
func NewClient(cfg config.Config) *Client {
	transport := &http.Transport{
		// Reuse connections aggressively so we skip the TCP/TLS handshake on
		// the hot path (option-chain, quotes, margin all hit the same host).
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 100, // all our traffic goes to one host → keep many warm
		MaxConnsPerHost:     0,   // unlimited concurrent; the rate limiter is the throttle
		IdleConnTimeout:     90 * time.Second,
		ForceAttemptHTTP2:   true, // multiplex many requests over one connection
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout:   5 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	return &Client{
		http: &http.Client{
			Transport: transport,
			Timeout:   15 * time.Second,
		},
		cfg:      cfg,
		limiters: newLimiterSet(),
		cache:    newQuoteCache(),
	}
}

// doJSON performs a rate-limited request to a SmartAPI endpoint and decodes the
// JSON envelope. It blocks (briefly) if the endpoint's rate budget is spent,
// rather than firing and getting throttled.
func (c *Client) doJSON(ctx context.Context, method, endpoint string, headers map[string]string, body any) (map[string]any, error) {
	if err := c.limiters.wait(ctx, endpoint); err != nil {
		return nil, err
	}

	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(raw)
	}

	req, err := http.NewRequestWithContext(ctx, method, config.SmartAPIBase+endpoint, reader)
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out) // tolerate non-JSON error bodies
	}
	if out == nil {
		out = map[string]any{}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg, _ := out["message"].(string)
		if msg == "" {
			msg = fmt.Sprintf("SmartAPI HTTP %d", resp.StatusCode)
		}
		return out, fmt.Errorf("%s", msg)
	}
	return out, nil
}

// limiterSet holds one token-bucket limiter per endpoint, created lazily.
type limiterSet struct {
	limiters map[string]*rate.Limiter
	mu       chan struct{} // 1-slot channel as a lightweight mutex
}

func newLimiterSet() *limiterSet {
	return &limiterSet{
		limiters: make(map[string]*rate.Limiter),
		mu:       make(chan struct{}, 1),
	}
}

func (s *limiterSet) wait(ctx context.Context, endpoint string) error {
	return s.get(endpoint).Wait(ctx)
}

func (s *limiterSet) get(endpoint string) *rate.Limiter {
	key := limitKey(endpoint)
	s.mu <- struct{}{}
	defer func() { <-s.mu }()
	if lim, ok := s.limiters[key]; ok {
		return lim
	}
	limit, ok := endpointLimits[key]
	if !ok {
		limit = defaultLimit
	}
	// Burst = ceil(limit) so a short burst is allowed, then it smooths out.
	burst := int(limit)
	if burst < 1 {
		burst = 1
	}
	lim := rate.NewLimiter(limit, burst)
	s.limiters[key] = lim
	return lim
}

// limitKey maps a full endpoint path to its rate-limit bucket. Order-status
// includes the order id as a suffix, so match on the documented prefix.
func limitKey(endpoint string) string {
	const orderDetails = "/rest/secure/angelbroking/order/v1/details"
	if len(endpoint) >= len(orderDetails) && endpoint[:len(orderDetails)] == orderDetails {
		return orderDetails
	}
	return endpoint
}
