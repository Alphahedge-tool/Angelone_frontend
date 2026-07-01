package angel

import (
	"context"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// ChargesReq is the request body for /charges.
type ChargesReq struct {
	Client ClientCreds `json:"client"`
	Legs   []Leg       `json:"legs"`
}

// GetCharges estimates brokerage + statutory charges via Angel's estimateCharges
// calculator — the port of getCharges. Angel is picky: quantity and price must
// be STRINGS and price an INTEGER string, or it returns AB2001.
func (c *Client) GetCharges(ctx context.Context, req ChargesReq) (map[string]any, error) {
	orders := make([]map[string]any, 0, len(req.Legs))
	for _, leg := range req.Legs {
		if leg.Token == "" || leg.Symbol == "" {
			continue
		}
		units := int(math.Trunc(leg.Qty * maxFloat(leg.LotSize, 1)))
		if units <= 0 {
			continue
		}
		orders = append(orders, map[string]any{
			"product_type":     mapChargeProduct(leg.ProductType, leg.Exchange),
			"transaction_type": tradeType(leg.TradeType),
			"quantity":         strconv.Itoa(units),
			"price":            strconv.Itoa(int(math.Round(maxFloat(leg.Price, 0)))), // integer string
			"exchange":         orDefault(leg.Exchange, "NFO"),
			"symbol_name":      leg.Symbol,
			"token":            leg.Token,
		})
		if len(orders) >= 50 {
			break
		}
	}
	if len(orders) == 0 {
		return map[string]any{"status": true, "totalCharges": 0, "breakup": nil, "empty": true}, nil
	}

	session, err := c.sessionOrLogin(ctx, req.Client)
	if err != nil {
		return nil, fmt.Errorf("Angel session unavailable for charges")
	}
	headers := c.smartHeaders(req.Client.APIKey)
	body := map[string]any{"orders": orders}

	result, err := c.doJSON(ctx, "POST", "/rest/secure/angelbroking/brokerage/v1/estimateCharges", authHeaders(headers, session.JWTToken), body)
	if err != nil {
		relogin, rerr := c.AutoLogin(ctx, withoutSession(req.Client))
		if rerr != nil {
			return nil, err
		}
		session = sessionFromResponse(relogin)
		result, err = c.doJSON(ctx, "POST", "/rest/secure/angelbroking/brokerage/v1/estimateCharges", authHeaders(headers, session.JWTToken), body)
		if err != nil {
			return nil, err
		}
	}

	data := mapData(result)
	summary, _ := data["summary"].(map[string]any)
	var total float64
	var breakup any
	if summary != nil {
		total = toFloat(summary["total_charges"])
		breakup = summary["breakup"]
	}
	if breakup == nil {
		breakup = data["charges"]
	}
	return map[string]any{
		"status":       true,
		"totalCharges": total,
		"breakup":      breakup,
		"orderCount":   len(orders),
		"session":      session,
	}, nil
}

// mapChargeProduct maps to Angel's estimateCharges product_type enum.
func mapChargeProduct(value, exchange string) string {
	v := strings.ToUpper(orDefault(value, "CF"))
	derivative := map[string]bool{"NFO": true, "BFO": true, "MCX": true, "CDS": true}[strings.ToUpper(exchange)]
	switch v {
	case "MIS", "INTRADAY":
		return "INTRADAY"
	case "CF", "NRML", "CARRYFORWARD":
		if derivative {
			return "CARRYFORWARD"
		}
		return "DELIVERY"
	case "DELIVERY", "CNC":
		return "DELIVERY"
	default:
		if derivative {
			return "CARRYFORWARD"
		}
		return "DELIVERY"
	}
}
