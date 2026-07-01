import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Search, X } from 'lucide-react';
import Basket from './Basket.jsx';
import './styles.css';

const STORAGE_KEY = 'angelone_react_clients_v1';
const LEGACY_STORAGE_KEY = 'angelone_multi_clients_v1';
const LEGACY_DB_NAME = 'angelone-client-panel';
const LEGACY_DB_VERSION = 1;
const LEGACY_STORE_NAME = 'state';

// Primary storage: IndexedDB (async, roomier than localStorage).
const DB_NAME = 'angelone-react-panel';
const DB_VERSION = 1;
const STORE_NAME = 'clients';
const CLIENTS_RECORD_KEY = 'clients';

const defaultClients = [
  {
    enabled: true,
    alias: 'SIMULATED1',
    clientCode: 'SIM1',
    broker: 'APITest',
    marketOrders: 'Allowed',
    apiKey: '',
    apiSecret: '',
    totpSecret: '',
    pin: '',
    historicalApi: false,
    sqoffTime: '15:16',
    loggedIn: false,
    status: 'Idle',
    netMargin: '0.00',
    availableCash: '0.00',
    collateral: '0.00',
    utilisedPayout: '0.00',
    mtmAll: '0.00',
    misMtm: '0.00',
    nrmlMtm: '0.00',
    session: null,
  },
  {
    enabled: true,
    alias: 'SEYH1006',
    clientCode: 'SEYH1006',
    broker: 'Angel',
    marketOrders: 'Allowed',
    apiKey: 'AQDK44U4',
    apiSecret: '',
    totpSecret: '',
    pin: '',
    historicalApi: false,
    sqoffTime: '00:00',
    loggedIn: false,
    status: 'Idle',
    netMargin: '0.00',
    availableCash: '0.00',
    collateral: '0.00',
    utilisedPayout: '0.00',
    mtmAll: '0.00',
    misMtm: '0.00',
    nrmlMtm: '0.00',
    session: null,
  },
];

function App() {
  const [activeTab, setActiveTab] = useState('settings');
  const [clients, setClients] = useState(defaultClients);
  const [selectedRows, setSelectedRows] = useState(new Set());
  const [demoMode, setDemoMode] = useState(false);
  const [backendUrl, setBackendUrl] = useState('/api/angel/auto-login');
  const hydrated = useRef(false);

  // Load saved clients from IndexedDB once on mount; fall back to the
  // older IndexedDB/localStorage stores if this is a first run.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let loaded = await loadClients();
      if (!loaded?.length) loaded = await migrateLegacyClients();
      if (!cancelled && loaded?.length) setClients(loaded);
      if (!cancelled) hydrated.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist to IndexedDB on change — but not before the initial load has
  // run, so we never overwrite stored data with the default seed.
  useEffect(() => {
    if (!hydrated.current) return;
    saveClients(clients).catch(() => {});
  }, [clients]);

  const selectedClientIndexes = useMemo(() => [...selectedRows], [selectedRows]);

  function updateClient(index, patch) {
    setClients((current) => current.map((client, row) => (row === index ? { ...client, ...patch } : client)));
  }

  function addClient() {
    setClients((current) => [
      ...current,
      {
        ...defaultClients[0],
        alias: '',
        clientCode: '',
        broker: 'Angel',
        status: 'Idle',
      },
    ]);
  }

  function deleteClient(index) {
    setClients((current) => current.filter((_, row) => row !== index));
    setSelectedRows((current) => {
      const next = new Set();
      current.forEach((row) => {
        if (row < index) next.add(row);
        if (row > index) next.add(row - 1);
      });
      return next;
    });
  }

  function toggleSelected(index, checked) {
    setSelectedRows((current) => {
      const next = new Set(current);
      if (checked) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  async function runAutoLogin() {
    const targetIndexes = selectedClientIndexes.length
      ? selectedClientIndexes
      : clients.map((client, index) => (client.enabled ? index : null)).filter((index) => index !== null);

    if (!targetIndexes.length) return;

    for (const index of targetIndexes) {
      const client = clients[index];
      if (!client?.enabled) continue;
      if (client.loggedIn && (demoMode || client.session?.jwtToken)) continue;

      updateClient(index, { status: 'Logging in...', loggedIn: false, netMargin: '0.00' });
      try {
        const result = demoMode ? await demoLogin(client, index) : await liveLogin(client, backendUrl);
        updateClient(index, {
          loggedIn: true,
          status: demoMode ? 'Demo login' : `Logged in - ${result.sessionSource || 'live'}`,
          netMargin: formatMoney(result.availableMargin),
          availableCash: formatMoney(result.availableCash),
          collateral: formatMoney(result.collateral),
          utilisedPayout: formatMoney(result.utilisedPayout),
          mtmAll: formatMoney(result.mtmAll),
          misMtm: formatMoney(result.misMtm),
          nrmlMtm: formatMoney(result.nrmlMtm),
          session: result.session || client.session || null,
        });
      } catch (error) {
        updateClient(index, {
          loggedIn: false,
          status: error.message || 'Login failed',
          netMargin: '0.00',
          availableCash: '0.00',
          collateral: '0.00',
          utilisedPayout: '0.00',
          session: null,
        });
      }
    }
  }

  async function logoutClient(index) {
    const client = clients[index];
    if (!demoMode && client.clientCode) {
      await fetch('/api/angel/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCode: client.clientCode }),
      }).catch(() => {});
    }

    updateClient(index, {
      loggedIn: false,
      status: 'Idle',
      netMargin: '0.00',
      availableCash: '0.00',
      collateral: '0.00',
      utilisedPayout: '0.00',
      session: null,
    });
  }

  return (
    <main className="app-shell bg-[#151819] text-slate-100">
      <header className="topbar shadow-[0_1px_0_rgba(255,255,255,.08)]">
        <nav className="tabs" aria-label="Main sections">
          {[
            ['orders', 'Order Book'],
            ['positions', 'Positions'],
            ['settings', 'User Settings'],
            ['strategies', 'Strategies'],
            ['multi-leg', 'Multi-leg'],
          ].map(([key, label]) => (
            <button
              className={`tab ${activeTab === key ? 'active' : ''}`}
              key={key}
              onClick={() => setActiveTab(key)}
              type="button"
            >
              {label}
            </button>
          ))}
        </nav>
        <section className="actions" aria-label="Account actions">
          <button className="btn secondary" onClick={addClient} type="button">Add Client</button>
          <button className="btn primary" onClick={runAutoLogin} type="button">Auto Login</button>
        </section>
      </header>

      {activeTab === 'settings' && (
        <UserSettings
          backendUrl={backendUrl}
          clients={clients}
          demoMode={demoMode}
          onBackendUrlChange={setBackendUrl}
          onClientChange={updateClient}
          onDeleteClient={deleteClient}
          onDemoModeChange={setDemoMode}
          onLogoutClient={logoutClient}
          onToggleSelected={toggleSelected}
          selectedRows={selectedRows}
        />
      )}

      {activeTab === 'strategies' && (
        <Strategies
          clients={clients}
          demoMode={demoMode}
          onClientSession={(index, session) => updateClient(index, { session })}
        />
      )}

      {activeTab === 'orders' && (
        <OrderBookView
          clients={clients}
          demoMode={demoMode}
          onClientSession={(index, session) => updateClient(index, { session })}
        />
      )}

      {activeTab !== 'settings' && activeTab !== 'strategies' && activeTab !== 'orders' && (
        <EmptyState title={activeTab === 'orders' ? 'Order Book' : activeTab === 'positions' ? 'Positions' : 'Multi-leg'} />
      )}
    </main>
  );
}

function UserSettings({
  backendUrl,
  clients,
  demoMode,
  onBackendUrlChange,
  onClientChange,
  onDeleteClient,
  onDemoModeChange,
  onLogoutClient,
  onToggleSelected,
  selectedRows,
}) {
  const allSelected = clients.length > 0 && clients.every((_, index) => selectedRows.has(index));

  return (
    <>
      <section className="config-strip" aria-label="Backend configuration">
        <label>
          Backend URL
          <input type="url" value={backendUrl} onChange={(event) => onBackendUrlChange(event.target.value)} />
        </label>
        <label className="switch">
          <input checked={demoMode} onChange={(event) => onDemoModeChange(event.target.checked)} type="checkbox" />
          <span>Demo mode - fake margins</span>
        </label>
      </section>

      <section className="grid-wrap" aria-label="Client settings">
        <table className="client-table">
          <thead>
            <tr>
              <th className="tiny">
                <input
                  checked={allSelected}
                  onChange={(event) => clients.forEach((_, index) => onToggleSelected(index, event.target.checked))}
                  type="checkbox"
                  aria-label="Select all clients"
                />
              </th>
              {['Enable', 'Delete', 'Logout', 'Manual Square Off', 'Logged In', 'MTM (All)', 'MIS MTM', 'NRML MTM', 'Net Margin', 'Cash', 'Collateral', 'Payout Used', 'Market Orders', 'User Alias', 'User ID', 'Broker', 'API Key', 'API Secret', 'TOTP Secret', 'PIN', 'Historical API', 'SqOff Time', 'Status'].map((heading) => (
                <th key={heading}>{heading}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {clients.map((client, index) => (
              <ClientRow
                client={client}
                index={index}
                key={`${client.clientCode}-${index}`}
                onChange={onClientChange}
                onDelete={onDeleteClient}
                onLogout={onLogoutClient}
                onToggleSelected={onToggleSelected}
                selected={selectedRows.has(index)}
              />
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function ClientRow({ client, index, onChange, onDelete, onLogout, onToggleSelected, selected }) {
  const stateClass = client.status?.includes('Logging') ? 'running' : client.loggedIn ? 'success' : client.status !== 'Idle' ? 'failed' : '';

  return (
    <tr className={stateClass}>
      <td className="tiny"><input checked={selected} onChange={(event) => onToggleSelected(index, event.target.checked)} type="checkbox" /></td>
      <td><input checked={client.enabled} onChange={(event) => onChange(index, { enabled: event.target.checked })} type="checkbox" /></td>
      <td><button className="icon danger" onClick={() => onDelete(index)} type="button" title="Delete client">x</button></td>
      <td><button className="icon" onClick={() => onLogout(index)} type="button" title="Logout client">o</button></td>
      <td><button className="icon" type="button" title="Manual square off">*</button></td>
      <td className="login-state">{client.loggedIn ? 'Yes' : 'No'}</td>
      <td className="money">{client.mtmAll || '0.00'}</td>
      <td className="money">{client.misMtm || '0.00'}</td>
      <td className="money">{client.nrmlMtm || '0.00'}</td>
      <td className="margin net-margin">{client.netMargin || '0.00'}</td>
      <td className="margin cash-margin">{client.availableCash || '0.00'}</td>
      <td className="margin collateral-margin">{client.collateral || '0.00'}</td>
      <td className="margin payout-margin">{client.utilisedPayout || '0.00'}</td>
      <td><Select value={client.marketOrders} onChange={(marketOrders) => onChange(index, { marketOrders })} options={['Allowed', 'Blocked']} /></td>
      <td><TextInput className="alias" value={client.alias} onChange={(alias) => onChange(index, { alias })} /></td>
      <td><TextInput className="client-code" value={client.clientCode} onChange={(clientCode) => onChange(index, { clientCode })} /></td>
      <td><Select value={client.broker} onChange={(broker) => onChange(index, { broker })} options={['Angel', 'APITest', 'KotakNeoV3']} /></td>
      <td><TextInput className={`api-key cred-box${client.apiKey ? ' filled' : ''}`} placeholder="Enter API key" value={client.apiKey} onChange={(apiKey) => onChange(index, { apiKey })} /></td>
      <td><TextInput className={`api-secret cred-box${client.apiSecret ? ' filled' : ''}`} placeholder="API secret" type="password" value={client.apiSecret} onChange={(apiSecret) => onChange(index, { apiSecret })} /></td>
      <td><TextInput className={`totp-secret cred-box${client.totpSecret ? ' filled' : ''}`} placeholder="TOTP secret" type="password" value={client.totpSecret} onChange={(totpSecret) => onChange(index, { totpSecret })} /></td>
      <td><TextInput className={`pin cred-box${client.pin ? ' filled' : ''}`} placeholder="PIN" type="password" value={client.pin} onChange={(pin) => onChange(index, { pin })} /></td>
      <td><input checked={client.historicalApi} onChange={(event) => onChange(index, { historicalApi: event.target.checked })} type="checkbox" /></td>
      <td><TextInput type="time" value={client.sqoffTime} onChange={(sqoffTime) => onChange(index, { sqoffTime })} /></td>
      <td className="status">{client.status || 'Idle'}</td>
    </tr>
  );
}

function OrderBookView({ clients, demoMode, onClientSession }) {
  const [bookTab, setBookTab] = useState('history');
  const [clientIndex, setClientIndex] = useState(0);
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState('Select a logged-in account');
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');

  const loggedInIndexes = useMemo(
    () => clients.map((client, index) => (client.loggedIn ? index : -1)).filter((index) => index >= 0),
    [clients],
  );
  const selectedClient = clients[clientIndex];

  useEffect(() => {
    if (loggedInIndexes.length && !loggedInIndexes.includes(clientIndex)) {
      setClientIndex(loggedInIndexes[0]);
    }
  }, [loggedInIndexes, clientIndex]);

  useEffect(() => {
    if (selectedClient?.loggedIn && !demoMode) loadBook(bookTab);
  }, [bookTab, clientIndex, selectedClient?.session?.jwtToken, demoMode]);

  async function loadBook(nextTab = bookTab) {
    const client = clients[clientIndex];
    if (!client?.loggedIn) {
      setRows([]);
      setStatus('Log in an account first');
      return;
    }
    if (demoMode) {
      setRows([]);
      setStatus('Disable demo mode for live order book');
      return;
    }

    setLoading(true);
    setStatus(nextTab === 'trades' ? 'Loading trade book...' : 'Loading order book...');
    try {
      const response = await fetch(nextTab === 'trades' ? '/api/angel/trade-book' : '/api/angel/order-book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.status === false) throw new Error(body.message || `HTTP ${response.status}`);
      if (body.session?.jwtToken) onClientSession?.(clientIndex, body.session);
      const nextRows = nextTab === 'trades' ? body.trades || [] : body.orders || [];
      setRows(nextRows);
      setStatus(`${nextRows.length} ${nextTab === 'trades' ? 'trades' : 'orders'} loaded`);
    } catch (error) {
      setRows([]);
      setStatus(error.message || 'Book load failed');
    } finally {
      setLoading(false);
    }
  }

  const visibleRows = useMemo(() => {
    const source = bookTab === 'open'
      ? rows.filter((row) => isOpenOrder(row))
      : rows;
    const needle = query.trim().toLowerCase();
    if (!needle) return source;
    return source.filter((row) => JSON.stringify(row).toLowerCase().includes(needle));
  }, [rows, bookTab, query]);
  const summary = useMemo(() => bookSummary(visibleRows), [visibleRows]);
  const orderHistoryCount = bookTab === 'trades' ? rows.length : rows.filter((row) => !isOpenOrder(row)).length;
  const columns = useMemo(() => bookDisplayColumns(bookTab), [bookTab]);

  return (
    <section className="book-view">
      <header className="book-top-tabs" aria-label="Order sections">
        <div className="book-tabs" role="tablist" aria-label="Order book tabs">
          <button className={bookTab === 'open' ? 'active' : ''} type="button" onClick={() => setBookTab('open')}>Open Orders</button>
          <button className={bookTab === 'history' ? 'active' : ''} type="button" onClick={() => setBookTab('history')}>Order History ({orderHistoryCount})</button>
          <button className={bookTab === 'trades' ? 'active' : ''} type="button" onClick={() => setBookTab('trades')}>Trades</button>
          {['Stock SIP', 'GTT', 'Basket Orders', 'Alerts'].map((label) => (
            <button className="muted" disabled key={label} type="button">{label}</button>
          ))}
        </div>
      </header>

      <div className="book-toolbar">
        <label className="book-search">
          <Search size={18} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" />
        </label>
        <button className="book-filter" type="button" title="Filters">≡</button>
        <div className="book-toolbar-spacer" />
        <PillSelect
          title="Account"
          value={String(clientIndex)}
          onChange={(value) => setClientIndex(Number(value))}
          options={clients.map((client, index) => ({
            value: String(index),
            label: client.alias || client.clientCode || `Client ${index + 1}`,
            pill: client.loggedIn ? 'ON' : 'OFF',
            pillClass: client.loggedIn ? 'pill-idx' : 'pill-eq',
          }))}
        />
        <button className="btn secondary" disabled={loading} type="button" onClick={() => loadBook()}>
          {loading ? 'Loading' : 'Refresh'}
        </button>
      </div>

      <div className="book-summary">
        <div>
          <span className="buy">Total Buy</span>
          <strong>{formatMoney(summary.buyValue)}</strong>
          <em>{summary.buyCount} Transactions</em>
        </div>
        <div>
          <span className="sell">Total Sell</span>
          <strong>{formatMoney(summary.sellValue)}</strong>
          <em>{summary.sellCount} Transactions</em>
        </div>
        <div>
          <span>Today's Charges</span>
          <strong>₹0.00</strong>
          <em>{visibleRows.length} Transactions</em>
        </div>
      </div>

      <div className="book-status">{status}</div>

      <div className="book-table-wrap">
        <table className="book-table">
          <thead>
            <tr>{columns.map((column) => <th key={column}>{bookLabel(column)}</th>)}</tr>
          </thead>
          <tbody>
            {visibleRows.map((row, index) => (
              <tr key={row.orderid || row.order_id || row.tradeid || row.fillid || index}>
                {columns.map((column) => <td key={column}>{renderBookCell(row, column)}</td>)}
              </tr>
            ))}
            {!visibleRows.length && (
              <tr><td className="book-empty" colSpan={Math.max(columns.length, 1)}>No {bookTab === 'trades' ? 'trades' : 'orders'} to show</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function bookDisplayColumns(tab) {
  return tab === 'trades'
    ? ['stock', 'product', 'qty', 'executedPrice', 'orderId', 'time']
    : ['stock', 'product', 'qty', 'placedPrice', 'executedPrice', 'ltp', 'status'];
}

function bookLabel(key) {
  const labels = {
    stock: 'Stock Name',
    product: 'Product Type',
    qty: 'Qty.',
    placedPrice: 'Placed Price',
    executedPrice: 'Executed Price',
    ltp: 'LTP',
    status: 'Status',
    orderId: 'Order ID',
    time: 'Time',
  };
  if (labels[key]) return labels[key];
  return String(key).replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase();
}

function renderBookCell(row, column) {
  if (column === 'stock') return <BookStockCell row={row} />;
  if (column === 'product') return <BookProductCell row={row} />;
  if (column === 'qty') return <BookQtyCell row={row} />;
  if (column === 'placedPrice') return formatOrderPrice(row.price, row.ordertype);
  if (column === 'executedPrice') return <span className="book-price-strong">{formatBookPrice(row.averageprice || row.fillprice)}</span>;
  if (column === 'ltp') return <span className="book-ltp">{formatBookPrice(row.ltp || row.close || row.averageprice || row.fillprice)}</span>;
  if (column === 'status') return <BookStatusCell row={row} />;
  if (column === 'orderId') return formatBookCell(row.orderid || row.order_id);
  if (column === 'time') return formatBookCell(row.exchtime || row.updatetime || row.filltime);
  return formatBookCell(row[column], column);
}

function BookStockCell({ row }) {
  const symbol = String(row.tradingsymbol || row.symbolname || row.symbol || '-');
  const parsed = parseTradingSymbol(symbol);
  return (
    <div className="book-stock-cell">
      <div className="book-stock-line">
        <strong>{parsed.root}</strong>
        {row.exchange && <span className="book-tag exchange">{row.exchange}</span>}
      </div>
      {parsed.detail && (
        <div className="book-stock-sub">
          <span>{parsed.detail}</span>
          {parsed.optionType && <span className={`book-tag option ${parsed.optionType.toLowerCase()}`}>{parsed.optionType}</span>}
        </div>
      )}
    </div>
  );
}

function BookProductCell({ row }) {
  const side = String(row.transactiontype || row.transaction_type || '').toUpperCase();
  const product = compactProductTag(row.producttype || row.product_type || '-');
  return (
    <div className="book-product-cell">
      {side && <span className={`book-tag side ${side === 'BUY' ? 'buy' : 'sell'}`}>{side}</span>}
      <span className="book-tag product">{product}</span>
    </div>
  );
}

function compactProductTag(value) {
  const product = String(value || '-').toUpperCase();
  if (product === 'CARRYFORWARD' || product === 'NRML') return 'CF';
  if (product === 'INTRADAY') return 'MIS';
  return product;
}

function BookQtyCell({ row }) {
  const qty = Number(row.quantity || 0) || 0;
  const filled = Number(row.filledshares || row.fillshares || 0) || 0;
  const lotSize = Number(row.lotsize || row.lotSize || row.lot_size || 0) || 0;
  const unit = lotSize > 1 ? 'Lots' : 'Shares';
  return (
    <div className="book-qty-cell">
      <span>{filled}/{qty} {unit}</span>
      {lotSize > 1 && <small>(1 Lot = {lotSize})</small>}
    </div>
  );
}

function BookStatusCell({ row }) {
  const state = String(row.status || row.orderstatus || '').toUpperCase();
  const time = row.updatetime || row.exchtime || row.filltime || '';
  const reason = orderReason(row);
  return (
    <div className="book-status-cell">
      <div className="book-status-main">
        {reason && (
          <span className="book-reason-wrap">
            <button className="book-reason-btn" type="button" aria-label={`Order reason: ${reason}`}>i</button>
            <span className="book-reason-tip" role="tooltip">{renderReasonText(reason)}</span>
          </span>
        )}
        {state ? <span className={`book-status-pill ${state.toLowerCase()}`}>{state}</span> : <span>-</span>}
      </div>
      {time && <small>{String(time)}</small>}
    </div>
  );
}

function orderReason(row) {
  return String(
    row.text ||
    row.rejreason ||
    row.rejectreason ||
    row.rejectionreason ||
    row.reason ||
    row.message ||
    ''
  ).trim();
}

function renderReasonText(reason) {
  const parts = String(reason).split(/(Insufficient Funds|Rs\.?\s*[\d,.]+)/gi);
  return parts.map((part, index) => {
    const important = /^(Insufficient Funds|Rs\.?\s*[\d,.]+)$/i.test(part);
    return important ? <mark key={index}>{part}</mark> : <span key={index}>{part}</span>;
  });
}

function inferOptionType(symbol) {
  const text = String(symbol).toUpperCase();
  if (/\bCE\b|CE$/.test(text)) return 'CE';
  if (/\bPE\b|PE$/.test(text)) return 'PE';
  return '';
}

function parseTradingSymbol(symbol) {
  const text = String(symbol || '-').trim();
  const spaced = text.match(/^([A-Z]+)\s+(.+?)\s+(CE|PE)$/i);
  if (spaced) {
    return { root: spaced[1].toUpperCase(), detail: spaced[2], optionType: spaced[3].toUpperCase() };
  }

  const compact = text.match(/^([A-Z]+)(\d+)(CE|PE)$/i);
  if (compact) {
    const [, root, digits, optionType] = compact;
    const strike = digits.length > 5 ? digits.slice(-5) : digits;
    const prefix = strike ? digits.slice(0, -strike.length) : digits;
    const detail = [formatSymbolCode(prefix), trimStrike(strike)].filter(Boolean).join(' ');
    return { root: root.toUpperCase(), detail, optionType: optionType.toUpperCase() };
  }

  const optionType = inferOptionType(text);
  return { root: optionType ? text.slice(0, -2) : text, detail: '', optionType };
}

function formatSymbolCode(value) {
  if (!value) return '';
  const weekly5 = value.match(/^(\d{2})(\d)(\d{2})$/);
  if (weekly5) return `${weekly5[3]} ${monthName(Number(weekly5[2]))} 20${weekly5[1]}`;
  const weekly6 = value.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (weekly6) return `${weekly6[3]} ${monthName(Number(weekly6[2]))} 20${weekly6[1]}`;
  if (value.length === 5) return `${value.slice(0, 2)} ${value.slice(2, 3)} ${value.slice(3)}`;
  if (value.length === 6) return `${value.slice(0, 2)} ${value.slice(2, 4)} ${value.slice(4)}`;
  return value;
}

function trimStrike(value) {
  return String(value || '').replace(/^0+(?=\d)/, '');
}

function monthName(month) {
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1] || '';
}

function formatOrderPrice(price, orderType) {
  const type = String(orderType || '').toUpperCase();
  if (type === 'MARKET' || type === 'MKT') return 'MKT';
  return formatBookPrice(price);
}

function formatBookPrice(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num === 0) return '-';
  return num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatBookCell(value, column = '') {
  if (value == null || value === '') return '-';
  if (/status/i.test(column)) {
    const state = String(value).toUpperCase();
    return <span className={`book-status-pill ${state.toLowerCase()}`}>{state}</span>;
  }
  if (/transactiontype/i.test(column)) {
    const side = String(value).toUpperCase();
    return <span className={side === 'BUY' ? 'book-buy' : side === 'SELL' ? 'book-sell' : ''}>{side}</span>;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString('en-IN') : '-';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function isOpenOrder(row) {
  const state = String(row?.status || row?.orderstatus || '').toUpperCase();
  return state && !['COMPLETE', 'COMPLETED', 'REJECTED', 'CANCELLED', 'CANCELED'].includes(state);
}

function bookSummary(rows) {
  return rows.reduce((acc, row) => {
    const side = String(row.transactiontype || row.transaction_type || '').toUpperCase();
    const qty = Number(row.quantity || row.filledshares || row.fillshares || 0) || 0;
    const price = Number(row.averageprice || row.fillprice || row.price || 0) || 0;
    const value = qty * price;
    if (side === 'BUY') {
      acc.buyCount += 1;
      acc.buyValue += value;
    }
    if (side === 'SELL') {
      acc.sellCount += 1;
      acc.sellValue += value;
    }
    return acc;
  }, { buyCount: 0, sellCount: 0, buyValue: 0, sellValue: 0 });
}

function Strategies({ clients, demoMode, onClientSession }) {
  // Basket legs live here (above the option chain) so Buy/Sell clicks from the
  // chain accumulate into the basket shown on the right.
  const [legs, setLegs] = useState([]);
  // Always-current mirror of legs so async callbacks (resolve) read the LATEST
  // leg — including changes from an earlier resolve still in flight. Capturing
  // the target inside a setLegs updater was racy when expiry AND strike changed
  // back-to-back; the ref makes each resolve see the merged, up-to-date leg.
  const legsRef = useRef([]);
  legsRef.current = legs;
  // Which logged-in client (with its session) the margin/charges calculators
  // should use — the same account that loaded the option chain.
  const [marginClient, setMarginClient] = useState(null);
  // Always-current mirror of the logged-in client so async callbacks (resolve)
  // never read a stale session from a captured closure.
  const marginClientRef = useRef(null);
  marginClientRef.current = marginClient;
  const [margin, setMargin] = useState({ status: 'idle', value: 0, message: '' });
  const [charges, setCharges] = useState({ status: 'idle', value: 0, message: '' });
  // symbol -> [expiries], shared from the option chain so the basket's expiry
  // dropdown can list the alternatives for each leg.
  const [expiryIndex, setExpiryIndex] = useState({});
  // token -> latest tick, mirrored from the option chain's live feed so basket
  // legs show a live LTP. Kept OUT of the leg state on purpose: ticks must not
  // retrigger the (expensive) margin/charges calc — that refreshes on demand.
  const [liveTicks, setLiveTicks] = useState({});
  const liveTicksRef = useRef({});
  liveTicksRef.current = liveTicks;
  // Bumped by the manual "refresh margin" button to force a recompute even when
  // no leg field changed (e.g. to re-price MARKET legs at the current tick).
  const [marginNonce, setMarginNonce] = useState(0);
  const legSeq = useRef(0);

  const addLeg = useCallback((leg) => {
    setLegs((current) => [...current, { ...leg, id: `leg-${++legSeq.current}` }]);
  }, []);

  const updateLeg = useCallback((id, patch) => {
    setLegs((current) => current.map((leg) => (leg.id === id ? { ...leg, ...patch } : leg)));
  }, []);

  // Per-leg monotonic request id, so only the LATEST resolve for a leg applies
  // its result (discards stale/overlapping responses).
  const resolveSeq = useRef({});
  // Cache of full option chains keyed by "SYMBOL|EXPIRY". Changing a leg's
  // expiry loads that expiry's chain once (in the background); strike changes
  // then read the LTP/token straight from the cache — instant, no per-strike
  // backend call, no races.
  const chainCache = useRef({});
  // In-flight chain loads keyed by "SYMBOL|EXPIRY" so a strike change that lands
  // while the same expiry's chain is still loading reuses the one request
  // instead of firing a second identical option-chain call.
  const chainPending = useRef({});

  // Pull a strike's contract (token, ltp, lotSize, etc.) out of a cached chain.
  const lookupFromChain = (chain, strike, optionType) => {
    if (!chain?.strikes?.length) return null;
    const want = Number(strike) || 0;
    // exact strike, else nearest available in this chain window
    let idx = chain.strikes.indexOf(want);
    if (idx < 0) {
      idx = chain.strikes.reduce((best, s, i) =>
        Math.abs(s - want) < Math.abs(chain.strikes[best] - want) ? i : best, 0);
    }
    const isCall = String(optionType).toUpperCase() !== 'PE';
    const ltp = (isCall ? chain.callLtp : chain.putLtp)?.[idx];
    const close = (isCall ? chain.callClose : chain.putClose)?.[idx];
    const token = (isCall ? chain.callTokens : chain.putTokens)?.[idx] || null;
    const tradingSymbol = (isCall ? chain.callSymbols : chain.putSymbols)?.[idx] || null;
    const changePct = (ltp && close) ? Number((((ltp - close) / close) * 100).toFixed(2)) : null;
    return {
      strike: chain.strikes[idx],
      ltp: ltp ?? null,
      close: close ?? null,
      changePct,
      token,
      tradingSymbol,
      exchange: chain.exchange,
      lotSize: chain.lotSize || 1,
    };
  };

  // Fetch (and cache) the full option chain for a symbol+expiry. Reused across
  // strike changes so the LTP for any strike of that expiry is already local.
  const loadExpiryChain = useCallback(async (symbol, expiry) => {
    const key = `${symbol}|${expiry}`;
    if (chainCache.current[key]) return chainCache.current[key];
    if (chainPending.current[key]) return chainPending.current[key]; // reuse in-flight
    const liveClient = marginClientRef.current;
    if (!liveClient?.session?.jwtToken) return null;
    const request = (async () => {
      const res = await fetch('/api/angel/option-chain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: liveClient, symbol, expiry, window: 30 }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status === false) throw new Error(body.message || 'Chain load failed');
      chainCache.current[key] = body;
      return body;
    })();
    chainPending.current[key] = request;
    try {
      return await request;
    } finally {
      delete chainPending.current[key];
    }
  }, []);

  // Re-resolve a leg when a contract-defining field changes (strike/expiry/side).
  // Strategy: on expiry change, background-load that expiry's full chain; then
  // read the new strike's LTP + token from that cached chain. Strike/side changes
  // are then instant local lookups. Falls back to /resolve-leg if uncached.
  const resolveLegContract = useCallback(async (id, changes = {}) => {
    // Read the target from the always-current ref (NOT inside the setLegs
    // updater) so a strike change that lands while an expiry change is still
    // resolving sees the merged leg — both edits are applied, not lost.
    const found = legsRef.current.find((leg) => leg.id === id);
    if (!found) return;
    const target = { ...found, ...changes };
    // Apply the field changes optimistically and mark the leg resolving.
    setLegs((current) => current.map((leg) => (leg.id === id ? { ...leg, ...changes, resolving: true } : leg)));

    const seq = (resolveSeq.current[id] || 0) + 1;
    resolveSeq.current[id] = seq;
    const isLatest = () => resolveSeq.current[id] === seq;
    const finish = (patch) => {
      if (!isLatest()) return;
      setLegs((current) => current.map((leg) => (leg.id === id ? { ...leg, ...patch, resolving: false } : leg)));
    };

    try {
      const key = `${target.symbol}|${target.expiry}`;
      let chain = chainCache.current[key];
      // Need the chain when switching expiry (or when this expiry isn't cached).
      if (!chain) chain = await loadExpiryChain(target.symbol, target.expiry);

      const hit = chain && lookupFromChain(chain, target.strike, target.optionType);
      if (hit && hit.token) {
        finish({
          expiry: target.expiry,
          strike: hit.strike,
          optionType: target.optionType,
          token: hit.token,
          tradingSymbol: hit.tradingSymbol,
          exchange: hit.exchange,
          lotSize: hit.lotSize,
          ltp: hit.ltp,
          close: hit.close,
          changePct: hit.changePct,
          resolveError: null,
        });
        return;
      }

      // Fallback: strike outside the cached window (or no chain) — resolve the
      // single contract directly.
      const liveClient = marginClientRef.current;
      const res = await fetch('/api/angel/resolve-leg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client: liveClient || null,
          symbol: target.symbol,
          expiry: target.expiry,
          strike: Number(target.strike) || 0,
          optionType: target.optionType,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status === false) throw new Error(body.message || 'Contract not found');
      finish({
        expiry: body.expiry || target.expiry,
        strike: body.strike ?? target.strike,
        optionType: body.optionType || target.optionType,
        token: body.token ?? target.token,
        tradingSymbol: body.tradingSymbol ?? target.tradingSymbol,
        exchange: body.exchange || target.exchange,
        lotSize: body.lotSize || target.lotSize,
        ltp: body.ltp ?? null,
        close: body.close ?? null,
        changePct: body.changePct ?? null,
        resolveError: body.quoteError || null,
      });
    } catch (error) {
      console.error('resolve-leg failed:', error);
      finish({ resolveError: error.message || 'Contract not found' });
    }
  }, [loadExpiryChain]);

  // Manual margin/charges refresh. Snapshots the latest live LTP into each leg
  // (so MARKET legs re-price at the current tick) and forces a recompute. Margin
  // deliberately does NOT follow every tick — the user pulls a fresh figure here.
  const refreshMargin = useCallback(() => {
    const ticks = liveTicksRef.current;
    setLegs((current) => current.map((leg) => {
      const tick = leg.token != null ? ticks[leg.token] : null;
      if (!tick || tick.ltp == null) return leg;
      const changePct = (tick.ltp && tick.close)
        ? Number((((tick.ltp - tick.close) / tick.close) * 100).toFixed(2))
        : leg.changePct;
      return { ...leg, ltp: tick.ltp, changePct };
    }));
    setMarginNonce((n) => n + 1);
  }, []);

  // Distinct set of basket-leg contracts to keep live: "exchange|token". A leg
  // on a different expiry/symbol than the on-screen chain has a token the chain
  // feed never subscribed, so without this its LTP would freeze. Recomputed only
  // when the leg tokens actually change (not on every tick / qty edit).
  const legFeedKey = useMemo(() => {
    const seen = new Set();
    for (const leg of legs) {
      if (leg.token != null) seen.add(`${leg.exchange || 'NFO'}|${leg.token}`);
    }
    return [...seen].sort().join(',');
  }, [legs]);

  // Keep the live feed in sync with EXACTLY the basket's current leg tokens.
  // We send the full current set and let the server reconcile: it subscribes new
  // tokens and unsubscribes ones the basket dropped. So when a leg changes strike
  // or expiry, its OLD token is released and only the NEW one stays subscribed —
  // nothing accumulates toward Angel's 1000-token cap. Fires only when the leg
  // token set actually changes (not per tick / qty edit), or on account change.
  useEffect(() => {
    const client = marginClientRef.current;
    const session = client?.session;
    if (!session?.jwtToken || !session?.feedToken) return;

    const items = (legFeedKey ? legFeedKey.split(',') : []).map((pair) => {
      const [exchange, token] = pair.split('|');
      return { exchange, token };
    });

    fetch('/api/angel/basket-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        credentials: {
          jwtToken: session.jwtToken,
          feedToken: session.feedToken,
          apiKey: client.apiKey,
          clientCode: client.clientCode,
        },
        items, // the FULL current basket set; server diffs against the previous
      }),
    }).catch((error) => console.error('basket-tokens sync failed:', error));
  }, [legFeedKey, marginClient]);

  const removeLeg = useCallback((id) => {
    setLegs((current) => current.filter((leg) => leg.id !== id));
  }, []);

  const clearLegs = useCallback(() => setLegs([]), []);

  // Price sent to Angel per leg: the typed price for limit legs, live LTP for
  // market legs. Shared by both the margin and charge calculators.
  const priceFor = (leg) => (leg.priceType === 'LIMIT' ? Number(leg.price) || 0 : Number(leg.ltp) || 0);

  // Fields that change the calculated figures. Both margin and charges depend on
  // token/qty/side/product/price; charges also need the per-leg price even on
  // market legs (margin already gets it via priceFor). A checkbox toggle alone
  // never refetches. Stringified so the debounced effect can diff cheaply.
  const calcKey = useMemo(
    () => JSON.stringify(legs.map((leg) => [
      leg.token, leg.exchange, leg.qty, leg.lotSize, leg.action, leg.product,
      leg.priceType, priceFor(leg),
    ])),
    [legs],
  );

  // Recompute real margin AND charges (debounced together) whenever the relevant
  // inputs or the account change. The margin batch endpoint nets spread benefits
  // across all legs; estimateCharges returns the basket's total brokerage + taxes.
  useEffect(() => {
    if (!legs.length) {
      setMargin({ status: 'idle', value: 0, message: '' });
      setCharges({ status: 'idle', value: 0, message: '' });
      return undefined;
    }
    if (!marginClient?.session?.jwtToken) {
      const msg = 'Load the option chain on a logged-in account to price this basket';
      setMargin({ status: 'error', value: 0, message: msg });
      setCharges({ status: 'error', value: 0, message: msg });
      return undefined;
    }

    let cancelled = false;
    const handle = setTimeout(async () => {
      setMargin((m) => ({ ...m, status: 'loading' }));
      setCharges((c) => ({ ...c, status: 'loading' }));

      const legPayload = legs.map((leg) => ({
        token: leg.token,
        symbol: leg.tradingSymbol,
        exchange: leg.exchange,
        qty: leg.qty,
        lotSize: leg.lotSize,
        price: priceFor(leg),
        tradeType: leg.action,
        productType: leg.product,
        orderType: leg.priceType === 'LIMIT' ? 'LIMIT' : 'MARKET',
      }));

      const post = (url) => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: marginClient, legs: legPayload }),
      }).then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status === false) throw new Error(body.message || `HTTP ${res.status}`);
        return body;
      });

      const [marginOut, chargesOut] = await Promise.allSettled([
        post('/api/angel/margin'),
        post('/api/angel/charges'),
      ]);
      if (cancelled) return;

      let nextSession = null;
      if (marginOut.status === 'fulfilled') {
        nextSession = marginOut.value.session || nextSession;
        setMargin({ status: 'ready', value: Number(marginOut.value.totalMarginRequired || 0), message: '' });
      } else {
        setMargin({ status: 'error', value: 0, message: marginOut.reason?.message || 'Margin failed' });
      }

      if (chargesOut.status === 'fulfilled') {
        nextSession = chargesOut.value.session || nextSession;
        setCharges({
          status: 'ready',
          value: Number(chargesOut.value.totalCharges || 0),
          breakup: chargesOut.value.breakup || null,
          message: '',
        });
      } else {
        setCharges({ status: 'error', value: 0, breakup: null, message: chargesOut.reason?.message || 'Charges failed' });
      }

      if (nextSession?.jwtToken && nextSession.jwtToken !== marginClientRef.current?.session?.jwtToken) {
        setMarginClient((current) => (current ? { ...current, session: nextSession } : current));
      }
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [calcKey, marginClient, marginNonce]);

  return (
    <section className="strategies-view">
      <OptionChainPanel
        clients={clients}
        demoMode={demoMode}
        onClientSession={onClientSession}
        onAddLeg={addLeg}
        onMarginContext={setMarginClient}
        onExpiryIndex={setExpiryIndex}
        onLiveTicks={setLiveTicks}
      />
      <Basket
        legs={legs}
        name="MY BASKET"
        margin={margin}
        charges={charges}
        expiryIndex={expiryIndex}
        liveTicks={liveTicks}
        onUpdateLeg={updateLeg}
        onResolveLeg={resolveLegContract}
        onRemoveLeg={removeLeg}
        onRefreshMargin={refreshMargin}
        onClear={clearLegs}
        onClose={clearLegs}
      />
    </section>
  );
}

const OptionChainPanel = React.memo(function OptionChainPanel({ clients, demoMode, onClientSession, onAddLeg, onMarginContext, onExpiryIndex, onLiveTicks }) {
  const [chainIndex, setChainIndex] = useState({});
  const [clientIndex, setClientIndex] = useState(0);
  const [symbol, setSymbol] = useState('');
  const [expiry, setExpiry] = useState('');
  const [status, setStatus] = useState('Loading master index...');
  const [chain, setChain] = useState(null);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState({});   // token -> { ltp, oi, dir }
  const [liveSpot, setLiveSpot] = useState(null); // live underlying price
  const [feedOn, setFeedOn] = useState(false);
  const esRef = useRef(null);              // active EventSource
  const prevRef = useRef({});              // token -> last ltp (for tick direction)
  const autoLoadRef = useRef('');

  // High-frequency tick buffering: ticks land in refs synchronously (no React
  // work), and a single rAF loop flushes them to state at most once per frame.
  // This caps re-renders at ~60fps no matter how fast the feed streams.
  const liveRef = useRef({});              // token -> latest tick (live snapshot)
  const spotRef = useRef(null);            // latest spot tick
  const dirtyRef = useRef(false);          // ticks pending since last flush
  const rafRef = useRef(0);

  // Current symbol/expiry/exchange/lotSize mirrored into refs so the memoized
  // onTrade can read them without being re-created on every selection change.
  const symbolRef = useRef('');
  const expiryRef = useRef('');
  const exchangeRef = useRef('NFO');
  const lotSizeRef = useRef(1);

  // Tear down the live feed + rAF loop on unmount.
  useEffect(() => () => {
    closeStream(esRef);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  const symbols = useMemo(() => {
    const preferred = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'CRUDEOIL', 'NATURALGAS', 'GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'COPPER'];
    const all = Object.keys(chainIndex).sort();
    return [...preferred.filter((item) => all.includes(item)), ...all.filter((item) => !preferred.includes(item))];
  }, [chainIndex]);

  // Only real, logged-in accounts may drive the option chain — never the
  // SIMULATED/demo seed or an account that hasn't authenticated yet.
  const loggedInIndexes = useMemo(
    () => clients.map((client, index) => (client.loggedIn ? index : -1)).filter((index) => index >= 0),
    [clients],
  );

  const expiries = chainIndex[symbol] || [];

  useEffect(() => {
    loadMasterIndex();
  }, []);

  useEffect(() => {
    if (!symbol && symbols.length) setSymbol(symbols[0]);
  }, [symbol, symbols]);

  // Keep the selected account pointed at a logged-in client. If the current
  // pick logs out (or was the simulated seed), jump to the first logged-in one.
  useEffect(() => {
    if (loggedInIndexes.length && !loggedInIndexes.includes(clientIndex)) {
      setClientIndex(loggedInIndexes[0]);
    }
  }, [loggedInIndexes, clientIndex]);

  useEffect(() => {
    if (expiries.length && !expiries.includes(expiry)) setExpiry(expiries[0]);
  }, [expiries, expiry]);

  async function loadMasterIndex() {
    setStatus('Loading master index...');
    try {
      const response = await fetch('/api/angel/master-index');
      const body = await response.json();
      setChainIndex(body);
      onExpiryIndex?.(body); // share symbol→expiries with the basket
      setStatus('Master ready');
    } catch (error) {
      setStatus(error.message || 'Master load failed');
    }
  }

  async function refreshMaster() {
    setLoading(true);
    setStatus('Refreshing master...');
    try {
      const response = await fetch('/api/angel/refresh-master', { method: 'POST' });
      const body = await response.json();
      if (!response.ok || body.status === false) throw new Error(body.message || 'Refresh failed');
      await loadMasterIndex();
      setStatus(`Master refreshed: ${body.totalTokens} tokens`);
    } catch (error) {
      setStatus(error.message || 'Refresh failed');
    } finally {
      setLoading(false);
    }
  }

  async function loadChain() {
    const client = clients[clientIndex];
    if (!client) {
      setStatus('Select a client');
      return;
    }
    if (!client.loggedIn) {
      setStatus('Log in an account first - option chain needs a live logged-in account');
      return;
    }
    if (demoMode) {
      setStatus('Disable demo mode for live option chain');
      return;
    }
    if (!client.apiKey) {
      setStatus('API key missing for selected client');
      return;
    }
    if (!client.session?.jwtToken && (!client.pin || !client.totpSecret)) {
      setStatus('Login first or add PIN and TOTP secret in User Settings');
      return;
    }

    setLoading(true);
    setStatus('Loading option chain...');
    try {
      // ── Phase 1: instant skeleton from OUR scrip master (no Angel round-trip
      // for the ladder). Renders every strike + tokens immediately, then the
      // live feed streams prices in — the same two-phase pattern Angel's own web
      // app uses (all-scrip-options → live). spot/atm come from one cheap quote.
      const skelRes = await fetch('/api/angel/all-scrip-options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client, TradeSymbol: symbol, ExpiryDate: expiry }),
      });
      const skeleton = await skelRes.json().catch(() => ({}));
      if (!skelRes.ok || skeleton.status === false) throw new Error(skeleton.message || `HTTP ${skelRes.status}`);

      // Reset live state for the new chain.
      setLive({});
      onLiveTicks?.({});
      setLiveSpot(null);
      prevRef.current = {};
      liveRef.current = {};
      spotRef.current = null;
      dirtyRef.current = false;

      // The skeleton endpoint logs in if needed and returns the feed block +
      // session (fresh feedToken), so the live feed can start reliably.
      const liveSession = skeleton.session || client.session || null;
      const liveClient = { ...client, session: liveSession };

      // Render the skeleton right away (OI/LTP arrays start empty; live fills them).
      setChain(skeleton);
      onClientSession(clientIndex, liveSession);
      onMarginContext?.(liveClient);
      setStatus(`Loaded ${skeleton.symbol} ${skeleton.expiry} (${skeleton.count} scrips)`);
      startLiveFeed(skeleton);

      // ── Phase 2: prices in the BACKGROUND (doesn't block the render above).
      // The ladder is already on screen; this fills LTP/OI/close for every strike
      // (live ticks overlay it during market hours; after hours it's the close).
      // Because the skeleton and this response share the same strike order, we
      // merge by INDEX. Only apply if this is still the chain on screen.
      fetch('/api/angel/chain-prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: liveClient, TradeSymbol: symbol, ExpiryDate: expiry }),
      })
        .then((r) => r.json().catch(() => ({})))
        .then((p) => {
          if (!p || p.status === false || !Array.isArray(p.strikes)) return;
          setChain((current) => {
            // Guard against a stale response for a chain the user already switched away from.
            if (!current || current.symbol !== skeleton.symbol || current.expiry !== skeleton.expiry) return current;
            return {
              ...current,
              spot: p.spot ?? current.spot,
              atm: p.atm ?? current.atm,
              pcr: p.pcr ?? current.pcr ?? 0,
              callOI: p.callOI, putOI: p.putOI,
              callLtp: p.callLtp, putLtp: p.putLtp,
              callClose: p.callClose, putClose: p.putClose,
            };
          });
        })
        .catch(() => { /* prices are best-effort; live feed still fills them */ });
    } catch (error) {
      setStatus(error.message || 'Option chain failed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const client = clients[clientIndex];
    if (!symbol || !expiry || loading || demoMode) return;
    if (!client?.loggedIn || !client.apiKey) return;
    if (!client.session?.jwtToken && (!client.pin || !client.totpSecret)) return;

    const key = `${clientIndex}|${symbol}|${expiry}`;
    if (autoLoadRef.current === key) return;
    autoLoadRef.current = key;
    loadChain();
  }, [clients, clientIndex, symbol, expiry, loading, demoMode]);

  // Keep refs current so onTrade (memoized with no deps) reads live values.
  symbolRef.current = symbol;
  expiryRef.current = expiry;
  exchangeRef.current = chain?.exchange || 'NFO';
  lotSizeRef.current = Number(chain?.lotSize) || 1;

  // Buy/Sell action buttons — push a leg into the basket. UI only (no order is
  // placed). Memoized with no deps so streaming ticks never re-render the
  // action buttons; current symbol/expiry/exchange/lotSize come from refs.
  // tradingSymbol is the per-strike contract symbol (e.g. NIFTY...CE) needed by
  // the charges estimator; passed through from the clicked row.
  const onTrade = useCallback((side, action, strike, token, ltp, changePct, tradingSymbol, close) => {
    onAddLeg?.({
      symbol: symbolRef.current,
      tradingSymbol: tradingSymbol || null,
      expiry: expiryRef.current,
      exchange: exchangeRef.current,
      lotSize: lotSizeRef.current,
      strike,
      optionType: side === 'call' ? 'CE' : 'PE',
      action,                 // 'BUY' | 'SELL'
      product: 'CF',
      qty: 1,                 // in LOTS; server multiplies by lotSize for units
      price: '',
      priceType: 'MARKET',
      ltp: ltp ?? null,
      close: close ?? null,   // day's close — LTP fallback when no live tick
      changePct: changePct ?? null,
      token: token ?? null,
      selected: true,
    });
    setStatus(`${action} ${side.toUpperCase()} ${strike} added to basket`);
  }, [onAddLeg]);

  // Subscribe to the Angel feed for this chain's tokens, then stream ticks
  // in over SSE and fold each one into `live` state (with up/down direction).
  async function startLiveFeed(body) {
    closeStream(esRef);
    setFeedOn(false);
    const tokens = body.liveTokens || [];
    if (!body.feed?.feedToken || !tokens.length) {
      setStatus('Loaded (live feed unavailable - no feed token)');
      return;
    }

    try {
      const res = await fetch('/api/angel/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credentials: body.feed,
          exchange: body.exchange,
          tokens,
          spot: body.spotToken ? { token: body.spotToken, exchange: body.spotExchange } : null,
        }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || out.status === false) throw new Error(out.message || 'Subscribe failed');
    } catch (error) {
      setStatus(`Live feed: ${error.message}`);
      return;
    }

    const source = new EventSource('/api/angel/stream');
    esRef.current = source;
    source.addEventListener('status', (event) => {
      try {
        const info = JSON.parse(event.data);
        setFeedOn(Boolean(info.connected));
      } catch {}
    });
    const spotToken = body.spotToken ? String(body.spotToken) : null;
    source.onmessage = (event) => {
      let tick;
      try { tick = JSON.parse(event.data); } catch { return; }
      const token = String(tick.token);
      const prev = prevRef.current[token];
      const dir = prev == null ? '' : tick.ltp > prev ? 'up' : tick.ltp < prev ? 'down' : '';
      prevRef.current[token] = tick.ltp;
      const at = event.timeStamp || performance.now();
      // Write to a ref only — no React state update here. Cheap and constant.
      if (token === spotToken) {
        spotRef.current = { ltp: tick.ltp, dir, at };
      } else {
        liveRef.current[token] = { ltp: tick.ltp, oi: tick.oi, close: tick.close, dir, at };
      }
      scheduleFlush();
    };
    source.onerror = () => setFeedOn(false);
  }

  // Coalesce buffered ticks into state once per animation frame.
  function scheduleFlush() {
    dirtyRef.current = true;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      if (spotRef.current) setLiveSpot(spotRef.current);
      // New object reference so memoized rows can diff by token value.
      const snapshot = { ...liveRef.current };
      setLive(snapshot);
      // Share the same tick snapshot with the basket so its legs' LTP ticks live.
      onLiveTicks?.(snapshot);
    });
  }

  const maxOi = useMemo(() => {
    const all = [...(chain?.callOI || []), ...(chain?.putOI || [])].map(Number);
    return all.length ? Math.max(...all, 0) : 0;
  }, [chain]);

  // Header badges: segment/kind of the selected symbol, and W/M per expiry.
  const symbolMeta = useMemo(() => classifySymbol(symbol), [symbol]);
  const expiryKinds = useMemo(() => classifyExpiries(expiries), [expiries]);

  // Recompute ATM as the strike nearest the live underlying price.
  const liveAtm = useMemo(() => {
    const price = liveSpot?.ltp;
    const strikes = chain?.strikes;
    if (!price || !strikes?.length) return null;
    return strikes.reduce((best, s) => (Math.abs(s - price) < Math.abs(best - price) ? s : best), strikes[0]);
  }, [liveSpot, chain]);

  // The ATM the table renders against — live value when the spot feed is up,
  // else the snapshot from load. Drives the ATM box, the highlighted ATM row and
  // the ITM shading, so all three shift together as the underlying moves.
  const atm = liveAtm ?? chain?.atm ?? 0;

  return (
    <aside className="option-chain-panel">
      <header className="chain-titlebar">
        <h1>Option Chain</h1>
        <div className="chain-window-actions">
          <span className={`live-pill ${feedOn ? 'on' : 'off'}`} title={feedOn ? 'WebSocket connected - streaming ticks' : 'Live feed disconnected'}>
            <span className="live-dot" />{feedOn ? 'LIVE' : 'OFF'}
          </span>
          <button className="window-btn" type="button" title="Pop out">□</button>
          <button className="window-btn" type="button" title="Close">×</button>
        </div>
      </header>

      <div className="chain-controls">
        <PillSelect
          title="Symbol"
          searchable
          searchPlaceholder="Search underlying..."
          value={symbol}
          onChange={setSymbol}
          options={symbols.map((item) => {
            const meta = classifySymbol(item);
            const isIndex = meta.kind === 'Index';
            return {
              value: item,
              label: item,
              pill: isIndex ? 'IDX' : meta.kind === 'Commodity' ? 'COMM' : 'EQ',
              pillClass: isIndex ? 'pill-idx' : meta.kind === 'Commodity' ? 'pill-comm' : 'pill-eq',
            };
          })}
        />
        <PillSelect
          title="Expiry"
          value={expiry}
          onChange={setExpiry}
          options={expiries.map((item) => {
            const monthly = expiryKinds[item] === 'Monthly';
            return {
              value: item,
              label: formatExpiry(item),
              pill: monthly ? 'M' : 'W',
              pillClass: monthly ? 'pill-monthly' : 'pill-weekly',
            };
          })}
        />
        <button className="chain-icon-btn" disabled={loading} onClick={refreshMaster} type="button" title="Refresh master">↻</button>
        <button className="load-chain-btn" disabled={loading} onClick={loadChain} type="button">
          {loading ? 'Loading' : 'Load'}
        </button>
      </div>

      {symbol && (
        <div className="chain-tags" aria-label="Instrument details">
          <span className="tag-symbol">{symbol}</span>
          <span className={`tag seg-${symbolMeta.segment.toLowerCase()}`}>{symbolMeta.segment}</span>
          <span className={`tag kind-${symbolMeta.kind.toLowerCase()}`}>{symbolMeta.kind}</span>
          {expiry && expiryKinds[expiry] && (
            <span className={`tag exp-${expiryKinds[expiry].toLowerCase()}`}>
              {expiryKinds[expiry]}
            </span>
          )}
        </div>
      )}

      <div className="chain-meta">
        <span>Spot
          <strong className={liveSpot?.dir ? `spot-flash-${liveSpot.dir}` : ''} key={`spot-${liveSpot?.at || 0}`}>
            {formatMoney(liveSpot?.ltp ?? chain?.spot ?? 0)}
          </strong>
        </span>
        <span>ATM <strong className={liveAtm && chain?.atm && liveAtm !== chain.atm ? 'atm-shifted' : ''}>{atm}</strong></span>
        <span>PCR <strong>{Number(chain?.pcr || 0).toFixed(2)}</strong></span>
      </div>

      <div className="chain-table-wrap">
        <table className="chain-table">
          <colgroup>
            <col className="col-oi" />
            <col className="col-chg" />
            <col className="col-ltp" />
            <col className="col-action" />
            <col className="col-strike" />
            <col className="col-action" />
            <col className="col-ltp" />
            <col className="col-chg" />
            <col className="col-oi" />
          </colgroup>
          <thead>
            <tr className="chain-side-head">
              <th className="side-call" colSpan="4">CALL</th>
              <th className="side-strike">STRIKE</th>
              <th className="side-put" colSpan="4">PUT</th>
            </tr>
            <tr>
              <th>OI</th>
              <th>Chng%</th>
              <th className="ltp-head">LTP</th>
              <th>Action</th>
              <th>Strike</th>
              <th>Action</th>
              <th className="ltp-head">LTP</th>
              <th>Chng%</th>
              <th>OI</th>
            </tr>
          </thead>
          <tbody>
            {(chain?.strikes || []).map((strike, index) => {
              // Resolve flat primitives per row so the memoized ChainRow can
              // shallow-compare and skip rows whose values didn't change.
              const callTick = live[chain.callTokens?.[index]];
              const putTick = live[chain.putTokens?.[index]];
              return (
                <ChainRow
                  key={strike}
                  strike={strike}
                  isAtm={strike === atm}
                  callItm={strike < atm}
                  putItm={strike > atm}
                  callLtp={callTick?.ltp ?? chain.callLtp?.[index]}
                  putLtp={putTick?.ltp ?? chain.putLtp?.[index]}
                  callOi={Number(callTick?.oi ?? chain.callOI?.[index] ?? 0)}
                  putOi={Number(putTick?.oi ?? chain.putOI?.[index] ?? 0)}
                  callClose={callTick?.close ?? chain.callClose?.[index]}
                  putClose={putTick?.close ?? chain.putClose?.[index]}
                  callDir={callTick?.dir || ''}
                  putDir={putTick?.dir || ''}
                  callAt={callTick?.at || 0}
                  putAt={putTick?.at || 0}
                  callToken={chain.callTokens?.[index] || null}
                  putToken={chain.putTokens?.[index] || null}
                  callSymbol={chain.callSymbols?.[index] || null}
                  putSymbol={chain.putSymbols?.[index] || null}
                  onTrade={onTrade}
                  maxOi={maxOi}
                />
              );
            })}
            {!chain && (
              <tr>
                <td className="chain-empty" colSpan="7">Select expiry and load chain</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </aside>
  );
});

function EmptyState({ title }) {
  return (
    <section className="empty-view">
      <h2>{title}</h2>
      <p>This section is ready for the next workflow.</p>
    </section>
  );
}

// One option-chain row, memoized on flat primitive props. Under a live feed,
// only rows whose values actually changed re-render; the rest are skipped by
// React.memo's shallow compare — keeping the table fast at high tick rates.
const ChainRow = React.memo(function ChainRow({
  strike, isAtm, callItm, putItm,
  callLtp, putLtp, callOi, putOi, callClose, putClose,
  callDir, putDir, callAt, putAt, callToken, putToken,
  callSymbol, putSymbol, onTrade, maxOi,
}) {
  const callChg = changePct(callLtp, callClose);
  const putChg = changePct(putLtp, putClose);
  const callWidth = maxOi ? Math.round((callOi / maxOi) * 100) : 0;
  const putWidth = maxOi ? Math.round((putOi / maxOi) * 100) : 0;
  return (
    <tr className={isAtm ? 'atm-row' : ''}>
      <td className={`oi call-oi${callItm ? ' itm-call' : ''}`}>
        <span className="oi-bar" style={{ width: `${callWidth}%` }} />
        <span className="oi-val">{formatQty(callOi)}</span>
      </td>
      <td className={`chg ${chgClass(callChg)}${callItm ? ' itm-call' : ''}`}>{formatChange(callChg)}</td>
      <td className={`ltp call-ltp${callItm ? ' itm-call' : ''}${callDir ? ` flash-${callDir}` : ''}`} key={`cl-${callAt}`}>
        <span className="ltp-val">{formatPrice(callLtp)}</span>
      </td>
      <td className={`action call-action${callItm ? ' itm-call' : ''}`}>
        <TradeActions side="call" strike={strike} token={callToken} symbol={callSymbol} ltp={callLtp} chg={callChg} close={callClose} onTrade={onTrade} />
      </td>
      <td className="strike">{strike}</td>
      <td className={`action put-action${putItm ? ' itm-put' : ''}`}>
        <TradeActions side="put" strike={strike} token={putToken} symbol={putSymbol} ltp={putLtp} chg={putChg} close={putClose} onTrade={onTrade} />
      </td>
      <td className={`ltp put-ltp${putItm ? ' itm-put' : ''}${putDir ? ` flash-${putDir}` : ''}`} key={`pl-${putAt}`}>
        <span className="ltp-val">{formatPrice(putLtp)}</span>
      </td>
      <td className={`chg ${chgClass(putChg)}${putItm ? ' itm-put' : ''}`}>{formatChange(putChg)}</td>
      <td className={`oi put-oi${putItm ? ' itm-put' : ''}`}>
        <span className="oi-bar" style={{ width: `${putWidth}%` }} />
        <span className="oi-val">{formatQty(putOi)}</span>
      </td>
    </tr>
  );
});

// Always-visible Buy/Sell pair in the Action column. Memoized on stable props
// (side/strike/token/onTrade) so live ticks never re-render the buttons — the
// streaming ltp/chg are mirrored into refs and only read at click time, so they
// don't count toward the memo's shallow compare.
// Default React.memo (shallow compare): the buttons re-render when ltp/chg
// change so a click always captures the CURRENT live price for the basket leg.
// These are two tiny buttons, so per-tick re-rendering is cheap.
const TradeActions = React.memo(function TradeActions({ side, strike, token, symbol, ltp, chg, close, onTrade }) {
  const label = side === 'call' ? 'Call' : 'Put';
  const disabled = !token;
  return (
    <div className="trade-actions" role="group" aria-label={`${label} actions`}>
      <button
        className="trade-btn buy"
        type="button"
        title={`Buy ${label} ${strike}`}
        disabled={disabled}
        onClick={() => onTrade?.(side, 'BUY', strike, token, ltp, chg, symbol, close)}
      >B</button>
      <button
        className="trade-btn sell"
        type="button"
        title={`Sell ${label} ${strike}`}
        disabled={disabled}
        onClick={() => onTrade?.(side, 'SELL', strike, token, ltp, chg, symbol, close)}
      >S</button>
    </div>
  );
});

function closeStream(ref) {
  if (ref.current) {
    ref.current.close();
    ref.current = null;
  }
}

function TextInput({ className = '', onChange, placeholder, type = 'text', value }) {
  return (
    <input
      className={className}
      type={type}
      value={value || ''}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function Select({ onChange, options, value }) {
  return (
    <select value={value || options[0]} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => <option key={option}>{option}</option>)}
    </select>
  );
}

// Custom dropdown that renders a colored pill badge beside each option —
// native <option> can't show styled badges, so we build our own panel.
function PillSelect({ title, value, onChange, options, searchable = false, searchPlaceholder = 'Search...' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef(null);
  const searchRef = useRef(null);
  const selected = options.find((o) => o.value === value);

  // Case-insensitive filter over the option label/value when searching.
  const visibleOptions = useMemo(() => {
    if (!searchable || !query.trim()) return options;
    const needle = query.trim().toLowerCase();
    return options.filter((o) =>
      String(o.label).toLowerCase().includes(needle) || String(o.value).toLowerCase().includes(needle));
  }, [options, query, searchable]);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Reset the query each time the menu closes, and focus the search box when it
  // opens so the user can type immediately.
  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    if (searchable) {
      const id = requestAnimationFrame(() => searchRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    return undefined;
  }, [open, searchable]);

  function pick(optionValue) {
    onChange(optionValue);
    setOpen(false);
  }

  // Enter in the search box selects the first match — quick keyboard flow.
  function onSearchKeyDown(event) {
    if (event.key === 'Enter' && visibleOptions.length) {
      event.preventDefault();
      pick(visibleOptions[0].value);
    }
  }

  return (
    <div className={`pill-select${open ? ' open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="pill-select-trigger"
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="pill-select-label">{selected?.label ?? value ?? title}</span>
        {selected?.pill && <span className={`opt-pill ${selected.pillClass}`}>{selected.pill}</span>}
        <span className="pill-select-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="pill-select-menu" role="listbox">
          {searchable && (
            <div className="pill-select-search">
              <Search className="pill-select-search-icon" size={14} aria-hidden="true" />
              <input
                ref={searchRef}
                type="text"
                className="pill-select-search-input"
                placeholder={searchPlaceholder}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKeyDown}
              />
              {query && (
                <button
                  type="button"
                  className="pill-select-search-clear"
                  title="Clear search"
                  onClick={() => { setQuery(''); searchRef.current?.focus(); }}
                ><X size={13} /></button>
              )}
            </div>
          )}
          <ul className="pill-select-list">
            {visibleOptions.map((option) => (
              <li
                key={option.value}
                role="option"
                aria-selected={option.value === value}
                className={`pill-select-option${option.value === value ? ' active' : ''}`}
                onClick={() => pick(option.value)}
              >
                <span className="pill-select-label">{option.label}</span>
                {option.pill && <span className={`opt-pill ${option.pillClass}`}>{option.pill}</span>}
              </li>
            ))}
            {!visibleOptions.length && (
              <li className="pill-select-empty">No matches for "{query}"</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

async function liveLogin(client, backendUrl) {
  const response = await fetch(backendUrl || '/api/angel/auto-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status === false) throw new Error(body.message || `HTTP ${response.status}`);

  return {
    availableMargin: pickMargin(body),
    availableCash: body.data?.availablecash ?? 0,
    collateral: body.data?.collateral ?? 0,
    utilisedPayout: body.data?.utilisedpayout ?? 0,
    sessionSource: body.sessionSource,
    session: body.session || null,
    mtmAll: body.mtmAll ?? 0,
    misMtm: body.misMtm ?? 0,
    nrmlMtm: body.nrmlMtm ?? 0,
  };
}

function demoLogin(client, index) {
  return new Promise((resolve, reject) => {
    window.setTimeout(() => {
      if (!client.clientCode) {
        reject(new Error('Missing User ID'));
        return;
      }
      const seed = client.clientCode.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
      resolve({
        availableMargin: 25000 + seed * 13 + index * 719,
        availableCash: 25000 + seed * 13 + index * 719,
        collateral: 0,
        utilisedPayout: 0,
        mtmAll: 0,
        misMtm: 0,
        nrmlMtm: 0,
      });
    }, 450);
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Read the saved clients from IndexedDB, falling back to a one-time
// migration of any data left behind in localStorage by older builds.
async function loadClients() {
  try {
    const db = await openDb();
    const stored = await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const getRequest = transaction.objectStore(STORE_NAME).get(CLIENTS_RECORD_KEY);
      getRequest.onsuccess = () => resolve(getRequest.result || null);
      getRequest.onerror = () => reject(getRequest.error);
    });
    db.close();
    if (Array.isArray(stored) && stored.length) return stored;
  } catch {
    // fall through to localStorage migration below
  }

  const migrated = migrateLocalStorageClients();
  if (migrated) {
    await saveClients(migrated).catch(() => {});
    return migrated;
  }
  return null;
}

async function saveClients(clients) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(clients, CLIENTS_RECORD_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  db.close();
}

// One-time pull of clients saved by the previous localStorage-based build.
function migrateLocalStorageClients() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (Array.isArray(stored) && stored.length) return stored;
  } catch {
    return null;
  }
  return null;
}

async function migrateLegacyClients() {
  const indexedClients = await readLegacyIndexedClients().catch(() => null);
  if (Array.isArray(indexedClients) && indexedClients.length) return normalizeClients(indexedClients);

  try {
    const localClients = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || 'null');
    if (Array.isArray(localClients) && localClients.length) return normalizeClients(localClients);
  } catch {
    return null;
  }

  return null;
}

function readLegacyIndexedClients() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      resolve(null);
      return;
    }

    const request = indexedDB.open(LEGACY_DB_NAME, LEGACY_DB_VERSION);
    request.onupgradeneeded = () => {
      request.transaction.abort();
      resolve(null);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LEGACY_STORE_NAME)) {
        db.close();
        resolve(null);
        return;
      }

      const transaction = db.transaction(LEGACY_STORE_NAME, 'readonly');
      const getRequest = transaction.objectStore(LEGACY_STORE_NAME).get(LEGACY_STORAGE_KEY);
      getRequest.onsuccess = () => {
        db.close();
        resolve(getRequest.result || null);
      };
      getRequest.onerror = () => {
        db.close();
        reject(getRequest.error);
      };
    };
  });
}

function normalizeClients(value) {
  return value.map((client) => ({
    ...defaultClients[0],
    ...client,
    status: client.status || 'Idle',
    netMargin: client.netMargin || '0.00',
    availableCash: client.availableCash || client.cashMargin || '0.00',
    collateral: client.collateral || '0.00',
    utilisedPayout: client.utilisedPayout || client.payoutMargin || '0.00',
    mtmAll: client.mtmAll || '0.00',
    misMtm: client.misMtm || '0.00',
    nrmlMtm: client.nrmlMtm || '0.00',
  }));
}

function pickMargin(body) {
  return body.availableMargin ?? body.data?.net ?? body.data?.availablecash ?? body.data?.availablelimitmargin ?? body.data?.collateral ?? 0;
}

// ── Symbol / expiry classification for the header badges ──
const MCX_SYMBOLS = new Set([
  'GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'CRUDEOIL', 'CRUDEOILM',
  'NATURALGAS', 'NATGASMINI', 'COPPER', 'ZINC', 'MCXBULLDEX',
]);
const INDEX_SYMBOLS = new Set([
  'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50',
  'SENSEX', 'BANKEX', 'SENSEX50',
]);
const BSE_SYMBOLS = new Set(['SENSEX', 'BANKEX', 'SENSEX50']);

// Returns { segment: 'MCX'|'BSE'|'NSE', kind: 'Index'|'Stock'|'Commodity' }.
function classifySymbol(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (MCX_SYMBOLS.has(s)) return { segment: 'MCX', kind: 'Commodity' };
  if (BSE_SYMBOLS.has(s)) return { segment: 'BSE', kind: 'Index' };
  if (INDEX_SYMBOLS.has(s)) return { segment: 'NSE', kind: 'Index' };
  return { segment: 'NSE', kind: 'Stock' };
}

// An expiry is "Monthly" when it's the last expiry in its calendar month for
// this symbol; the earlier ones in that month are "Weekly".
function classifyExpiries(expiries = []) {
  const parsed = expiries
    .map((e) => ({ e, ms: Date.parse(e) }))
    .filter((x) => !Number.isNaN(x.ms))
    .sort((a, b) => a.ms - b.ms);

  const lastOfMonth = new Map(); // "YYYY-M" -> latest ms in that month
  for (const { ms } of parsed) {
    const d = new Date(ms);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (!lastOfMonth.has(key) || ms > lastOfMonth.get(key)) lastOfMonth.set(key, ms);
  }

  const result = {};
  for (const { e, ms } of parsed) {
    const d = new Date(ms);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    result[e] = lastOfMonth.get(key) === ms ? 'Monthly' : 'Weekly';
  }
  return result;
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPrice(value) {
  const number = Number(value || 0);
  return number ? `₹${number.toFixed(2)}` : '-';
}

function formatQty(value) {
  const number = Number(value || 0);
  return number ? number.toLocaleString('en-IN') : '-';
}

// % change of LTP vs previous-day close. Returns null when not computable.
function changePct(ltp, close) {
  const l = Number(ltp || 0);
  const c = Number(close || 0);
  if (!l || !c) return null;
  return ((l - c) / c) * 100;
}

function formatChange(pct) {
  if (pct == null) return '-';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

function chgClass(pct) {
  if (pct == null) return 'chg-flat';
  return pct > 0 ? 'chg-up' : pct < 0 ? 'chg-down' : 'chg-flat';
}

function formatExpiry(value) {
  const match = String(value || '').match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (!match) return value;
  return `${match[1]} ${titleCase(match[2])} ${match[3]}`;
}

function titleCase(value) {
  return `${value.slice(0, 1)}${value.slice(1).toLowerCase()}`;
}

createRoot(document.getElementById('root')).render(<App />);
