package angel

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"strings"
	"time"
)

// Client (login) input as sent by the frontend. Mirrors the Node `client` shape.
type ClientCreds struct {
	ClientCode string   `json:"clientCode"`
	APIKey     string   `json:"apiKey"`
	PIN        string   `json:"pin"`
	TOTPSecret string   `json:"totpSecret"`
	Session    *Session `json:"session"`
}

// Session is the logged-in token bundle returned to (and re-sent by) the client.
type Session struct {
	APIKey       string         `json:"apiKey"`
	JWTToken     string         `json:"jwtToken"`
	RefreshToken string         `json:"refreshToken"`
	FeedToken    string         `json:"feedToken"`
	LoginSource  string         `json:"loginSource,omitempty"`
	LoginAt      string         `json:"loginAt,omitempty"`
	LastUsedAt   string         `json:"lastUsedAt,omitempty"`
	LastRMS      map[string]any `json:"lastRms,omitempty"`
}

// smartHeaders builds the standard SmartAPI header set for a given API key.
func (c *Client) smartHeaders(apiKey string) map[string]string {
	return map[string]string{
		"Content-Type":     "application/json",
		"Accept":           "application/json",
		"X-UserType":       "USER",
		"X-SourceID":       "WEB",
		"X-ClientLocalIP":  c.cfg.LocalIP,
		"X-ClientPublicIP": c.cfg.PublicIP,
		"X-MACAddress":     c.cfg.MACAddress,
		"X-PrivateKey":     apiKey,
	}
}

// authHeaders clones base headers and adds the bearer token.
func authHeaders(base map[string]string, jwt string) map[string]string {
	out := make(map[string]string, len(base)+1)
	for k, v := range base {
		out[k] = v
	}
	out["Authorization"] = "Bearer " + jwt
	return out
}

// resolveSession returns the client's usable session (with API key/feed token
// filled in) or nil when there's no JWT.
func resolveSession(cc ClientCreds) *Session {
	if cc.Session != nil && cc.Session.JWTToken != "" {
		s := *cc.Session
		s.APIKey = cc.APIKey
		return &s
	}
	return nil
}

// AutoLogin reuses an existing session (validated via getRMS) or performs a
// fresh TOTP login. Returns the RMS response envelope the frontend expects.
func (c *Client) AutoLogin(ctx context.Context, cc ClientCreds) (map[string]any, error) {
	if cc.ClientCode == "" || cc.APIKey == "" {
		return nil, fmt.Errorf("User ID and API key are required")
	}
	headers := c.smartHeaders(cc.APIKey)

	if s := resolveSession(cc); s != nil {
		if res, err := c.trySessionRMS(ctx, cc, headers, s); err == nil && res != nil {
			return res, nil
		}
	}

	login, err := c.loginWithTotp(ctx, cc, headers)
	if err != nil {
		return nil, err
	}
	return c.rmsResultFromLogin(ctx, cc, headers, login, "totp-login")
}

// trySessionRMS validates an existing JWT with a getRMS call; nil result means
// the caller should fall back to a fresh login.
func (c *Client) trySessionRMS(ctx context.Context, cc ClientCreds, headers map[string]string, s *Session) (map[string]any, error) {
	rms, err := c.getRMS(ctx, headers, s.JWTToken)
	if err != nil {
		return nil, err
	}
	s.LastUsedAt = time.Now().UTC().Format(time.RFC3339)
	s.LastRMS, _ = rms["data"].(map[string]any)
	return buildRMSResponse(cc.ClientCode, mapData(rms), "session", s), nil
}

func (c *Client) loginWithTotp(ctx context.Context, cc ClientCreds, headers map[string]string) (map[string]any, error) {
	if cc.PIN == "" || cc.TOTPSecret == "" {
		return nil, fmt.Errorf("PIN and TOTP secret are required")
	}
	totp, err := generateTOTP(cc.TOTPSecret)
	if err != nil {
		return nil, err
	}
	login, err := c.doJSON(ctx, "POST", "/rest/auth/angelbroking/user/v1/loginByPassword", headers, map[string]any{
		"clientcode": cc.ClientCode,
		"password":   cc.PIN,
		"totp":       totp,
	})
	if err != nil {
		return nil, err
	}
	if status, _ := login["status"].(bool); !status {
		return nil, fmt.Errorf("%s", strOr(login["message"], "SmartAPI login failed"))
	}
	if mapData(login)["jwtToken"] == nil {
		return nil, fmt.Errorf("SmartAPI login returned no jwtToken")
	}
	return login, nil
}

func (c *Client) rmsResultFromLogin(ctx context.Context, cc ClientCreds, headers map[string]string, login map[string]any, source string) (map[string]any, error) {
	data := mapData(login)
	jwt := strOr(data["jwtToken"], "")
	rms, err := c.getRMS(ctx, headers, jwt)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	s := &Session{
		APIKey:       cc.APIKey,
		JWTToken:     jwt,
		RefreshToken: strOr(data["refreshToken"], ""),
		FeedToken:    strOr(data["feedToken"], ""),
		LoginSource:  source,
		LoginAt:      now,
		LastUsedAt:   now,
	}
	s.LastRMS, _ = rms["data"].(map[string]any)
	return buildRMSResponse(cc.ClientCode, mapData(rms), source, s), nil
}

func (c *Client) getRMS(ctx context.Context, headers map[string]string, jwt string) (map[string]any, error) {
	rms, err := c.doJSON(ctx, "GET", "/rest/secure/angelbroking/user/v1/getRMS", authHeaders(headers, jwt), nil)
	if err != nil {
		return nil, err
	}
	if status, _ := rms["status"].(bool); !status {
		return nil, fmt.Errorf("%s", strOr(rms["message"], "RMS margin request failed"))
	}
	return rms, nil
}

func buildRMSResponse(clientCode string, data map[string]any, source string, s *Session) map[string]any {
	return map[string]any{
		"status":          true,
		"clientCode":      clientCode,
		"availableMargin": pickMargin(data),
		"marginSource":    pickMarginSource(data),
		"sessionSource":   source,
		"session":         s,
		"data":            data,
	}
}

func pickMargin(data map[string]any) float64 {
	for _, k := range []string{"net", "availablecash", "availablelimitmargin", "collateral"} {
		if v, ok := data[k]; ok && v != nil {
			return toFloat(v)
		}
	}
	return 0
}

func pickMarginSource(data map[string]any) string {
	for _, k := range []string{"net", "availablecash", "availablelimitmargin", "collateral"} {
		if v, ok := data[k]; ok && v != nil {
			return k
		}
	}
	return "unknown"
}

// generateTOTP produces the current 6-digit RFC-6238 TOTP (SHA-1, 30 s step)
// for a base32 secret — the same algorithm the Node server implements by hand.
func generateTOTP(secret string) (string, error) {
	clean := strings.ToUpper(strings.ReplaceAll(secret, " ", ""))
	clean = strings.TrimRight(clean, "=")
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(clean)
	if err != nil {
		return "", fmt.Errorf("Invalid TOTP secret")
	}
	counter := uint64(time.Now().Unix() / 30)
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], counter)

	mac := hmac.New(sha1.New, key)
	mac.Write(buf[:])
	sum := mac.Sum(nil)

	offset := sum[len(sum)-1] & 0x0f
	code := (uint32(sum[offset]&0x7f) << 24) |
		(uint32(sum[offset+1]&0xff) << 16) |
		(uint32(sum[offset+2]&0xff) << 8) |
		uint32(sum[offset+3]&0xff)
	return fmt.Sprintf("%06d", code%1_000_000), nil
}
