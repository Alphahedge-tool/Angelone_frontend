// Package config centralizes runtime configuration and the fixed Angel SmartAPI
// constants. Values come from the environment (matching the Node server's env
// vars) with sane defaults so the server runs with zero configuration.
package config

import (
	"net"
	"os"
	"strconv"
	"time"
)

const (
	// SmartAPIBase is the REST root for all secured/auth calls.
	SmartAPIBase = "https://apiconnect.angelone.in"
	// SmartStreamURL is the SmartWebSocket V2 endpoint for the live feed.
	SmartStreamURL = "wss://smartapisocket.angelone.in/smart-stream"
	// MasterURL is Angel's full scrip-master (symbol→token) JSON (~8.8 MB).
	MasterURL = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"

	// MasterTTL is how long the on-disk/in-memory scrip master stays fresh.
	MasterTTL = 24 * time.Hour
	// QuoteCacheTTL is the short window during which repeated identical quote
	// reads are served from cache instead of re-hitting Angel. This is the main
	// lever against the "same round-trip paid over and over" bottleneck.
	QuoteCacheTTL = 750 * time.Millisecond
)

// Config holds resolved runtime settings.
type Config struct {
	Port         int
	MasterFile   string
	IndexFile    string
	StaticRoot   string
	LocalIP      string
	PublicIP     string
	MACAddress   string
	FeedDebug    bool
}

// Load builds a Config from the environment, mirroring the Node server's knobs
// (PORT, ANGEL_LOCAL_IP, ANGEL_PUBLIC_IP, ANGEL_MAC_ADDRESS, FEED_DEBUG).
func Load() Config {
	ip := envOr("ANGEL_LOCAL_IP", localIPv4())
	return Config{
		Port:       envInt("PORT", 3001),
		MasterFile: envOr("ANGEL_MASTER_FILE", "scrip_master.json"),
		IndexFile:  envOr("ANGEL_INDEX_FILE", "scrip_index.json"),
		StaticRoot: envOr("ANGEL_STATIC_ROOT", "../dist"),
		LocalIP:    ip,
		PublicIP:   envOr("ANGEL_PUBLIC_IP", ip),
		MACAddress: os.Getenv("ANGEL_MAC_ADDRESS"),
		FeedDebug:  os.Getenv("FEED_DEBUG") == "1",
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

// localIPv4 returns the first non-loopback IPv4 address, or 127.0.0.1. Angel
// requires an X-ClientLocalIP header; it doesn't have to be routable.
func localIPv4() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "127.0.0.1"
	}
	for _, addr := range addrs {
		if ipnet, ok := addr.(*net.IPNet); ok && !ipnet.IP.IsLoopback() {
			if ip4 := ipnet.IP.To4(); ip4 != nil {
				return ip4.String()
			}
		}
	}
	return "127.0.0.1"
}
