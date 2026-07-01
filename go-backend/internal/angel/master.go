package angel

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"

	"angelone-backend/internal/config"
)

// ScripRow is the slim per-contract record we keep in memory (mirrors the Node
// slimData shape: t=token, s=symbol, n=name, e=expiry, k=strike, g=segment,
// l=lotsize).
type ScripRow struct {
	Token   string  `json:"t"`
	Symbol  string  `json:"s"`
	Name    string  `json:"n"`
	Expiry  string  `json:"e"`
	Strike  float64 `json:"k"`
	Segment string  `json:"g"`
	LotSize int     `json:"l"`
}

// MasterStore owns the scrip master: the slim rows, the symbol→expiries index,
// and freshness. All reads go through Data()/Index() which lazily (and, via
// singleflight, exactly once under concurrency) load or refresh.
type MasterStore struct {
	cfg config.Config

	mu       sync.RWMutex
	rows     []ScripRow
	index    map[string][]string
	loadedAt time.Time

	group singleflight.Group // de-dupes concurrent loads/refreshes
}

// neededSpotSymbols are the index cash-segment names we keep for spot LTP.
var neededSpotSymbols = map[string]bool{
	"Nifty 50": true, "Nifty Bank": true, "Nifty Fin Service": true,
	"Nifty Mid Select": true, "SENSEX": true,
}

func NewMasterStore(cfg config.Config) *MasterStore {
	return &MasterStore{cfg: cfg, index: map[string][]string{}}
}

// Data returns the slim rows, loading/refreshing if the cache is cold or stale.
func (m *MasterStore) Data(ctx context.Context) ([]ScripRow, error) {
	if err := m.ensure(ctx); err != nil {
		return nil, err
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.rows, nil
}

// Index returns the symbol→[expiries] dropdown index.
func (m *MasterStore) Index(ctx context.Context) (map[string][]string, error) {
	if err := m.ensure(ctx); err != nil {
		return nil, err
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.index, nil
}

// Warm proactively loads the master (called on boot so the first chain is fast).
func (m *MasterStore) Warm(ctx context.Context) error { return m.ensure(ctx) }

func (m *MasterStore) fresh() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.rows) > 0 && time.Since(m.loadedAt) < config.MasterTTL
}

// ensure loads from disk (if fresh) or downloads from Angel. singleflight
// collapses concurrent first-loads into one.
func (m *MasterStore) ensure(ctx context.Context) error {
	if m.fresh() {
		return nil
	}
	_, err, _ := m.group.Do("load", func() (any, error) {
		if m.fresh() {
			return nil, nil
		}
		if m.loadFromDisk() {
			return nil, nil
		}
		return nil, m.download(ctx)
	})
	return err
}

// loadFromDisk populates the cache from the slim files if they exist and are
// within TTL. Returns true on success.
func (m *MasterStore) loadFromDisk() bool {
	stat, err := os.Stat(m.cfg.MasterFile)
	if err != nil || time.Since(stat.ModTime()) >= config.MasterTTL {
		return false
	}
	rawMaster, err := os.ReadFile(m.cfg.MasterFile)
	if err != nil {
		return false
	}
	rawIndex, err := os.ReadFile(m.cfg.IndexFile)
	if err != nil {
		return false
	}
	var rows []ScripRow
	var index map[string][]string
	if json.Unmarshal(rawMaster, &rows) != nil || json.Unmarshal(rawIndex, &index) != nil {
		return false
	}
	m.mu.Lock()
	m.rows, m.index, m.loadedAt = rows, index, time.Now()
	m.mu.Unlock()
	return true
}

// Refresh forces a re-download and returns a small summary (for /refresh-master).
func (m *MasterStore) Refresh(ctx context.Context) (map[string]any, error) {
	res, err, _ := m.group.Do("refresh", func() (any, error) {
		if err := m.download(ctx); err != nil {
			return nil, err
		}
		m.mu.RLock()
		defer m.mu.RUnlock()
		return map[string]any{
			"status":      true,
			"symbolCount": len(m.index),
			"totalTokens": len(m.rows),
		}, nil
	})
	if err != nil {
		return nil, err
	}
	return res.(map[string]any), nil
}

// download fetches the full master, slims it to derivatives + needed spots,
// builds the expiry index, writes both slim files, and updates the cache.
func (m *MasterStore) download(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, "GET", config.MasterURL, nil)
	if err != nil {
		return err
	}
	// The master is ~8.8 MB; give it a generous timeout independent of API calls.
	httpClient := &http.Client{Timeout: 60 * time.Second}
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Master download failed: HTTP %d", resp.StatusCode)
	}

	// Stream-decode the array to keep peak memory reasonable.
	dec := json.NewDecoder(resp.Body)
	dec.UseNumber()
	if _, err := dec.Token(); err != nil { // opening '['
		return err
	}

	rows := make([]ScripRow, 0, 200_000)
	indexSet := map[string]map[string]bool{}
	for dec.More() {
		var raw map[string]any
		if err := dec.Decode(&raw); err != nil {
			return err
		}
		seg, _ := raw["exch_seg"].(string)
		name, _ := raw["name"].(string)
		isDerivative := seg == "NFO" || seg == "BFO" || seg == "MCX"
		isNeededSpot := (seg == "NSE" || seg == "BSE") && neededSpotSymbols[name]
		if !isDerivative && !isNeededSpot {
			continue
		}
		expiry := strings.ToUpper(strOr(raw["expiry"], ""))
		lot := int(toFloat(raw["lotsize"]))
		if lot == 0 {
			lot = 1
		}
		rows = append(rows, ScripRow{
			Token:   strOr(raw["token"], ""),
			Symbol:  strOr(raw["symbol"], ""),
			Name:    name,
			Expiry:  expiry,
			Strike:  toFloat(raw["strike"]),
			Segment: seg,
			LotSize: lot,
		})
		if isDerivative && expiry != "" {
			if indexSet[name] == nil {
				indexSet[name] = map[string]bool{}
			}
			indexSet[name][expiry] = true
		}
	}

	index := make(map[string][]string, len(indexSet))
	for name, set := range indexSet {
		list := make([]string, 0, len(set))
		for e := range set {
			list = append(list, e)
		}
		sort.Slice(list, func(i, j int) bool { return parseExpiryMs(list[i]) < parseExpiryMs(list[j]) })
		index[name] = list
	}

	// Persist slim files (best-effort; cache is authoritative in memory).
	if data, err := json.Marshal(rows); err == nil {
		_ = os.WriteFile(m.cfg.MasterFile, data, 0o644)
	}
	if data, err := json.Marshal(index); err == nil {
		_ = os.WriteFile(m.cfg.IndexFile, data, 0o644)
	}

	m.mu.Lock()
	m.rows, m.index, m.loadedAt = rows, index, time.Now()
	m.mu.Unlock()
	return nil
}
