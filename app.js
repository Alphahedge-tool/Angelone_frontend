const STORAGE_KEY = 'angelone_multi_clients_v1';
const DB_NAME = 'angelone-client-panel';
const DB_VERSION = 1;
const STORE_NAME = 'state';

const fallbackClients = [
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
  },
  {
    enabled: false,
    alias: 'XD6X8',
    clientCode: 'XD6X8',
    broker: 'KotakNeoV3',
    marketOrders: 'Allowed',
    apiKey: 'f31e16f5-57c8-4861-bd9e-c8531ba3f295',
    apiSecret: '',
    totpSecret: '',
    pin: '',
    historicalApi: false,
    sqoffTime: '15:16',
  },
];

const rowTemplate = document.querySelector('#rowTemplate');
const clientRows = document.querySelector('#clientRows');
const addClientBtn = document.querySelector('#addClientBtn');
const autoLoginBtn = document.querySelector('#autoLoginBtn');
const selectAll = document.querySelector('#selectAll');
const backendUrl = document.querySelector('#backendUrl');
const demoMode = document.querySelector('#demoMode');

let clients = fallbackClients;

init();

addClientBtn.addEventListener('click', () => {
  clients.push({
    enabled: true,
    alias: '',
    clientCode: '',
    broker: 'Angel',
    marketOrders: 'Allowed',
    apiKey: '',
    apiSecret: '',
    totpSecret: '',
    pin: '',
    historicalApi: false,
    sqoffTime: '15:16',
  });
  saveClients();
  renderRows();
});

selectAll.addEventListener('change', () => {
  document.querySelectorAll('.row-select').forEach((box) => {
    box.checked = selectAll.checked;
  });
});

autoLoginBtn.addEventListener('click', runAutoLogin);
window.addEventListener('beforeunload', () => {
  syncClientsFromRows();
  saveClients();
});

function loadClients() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    return Array.isArray(stored) && stored.length ? stored : fallbackClients;
  } catch {
    return fallbackClients;
  }
}

function saveClients() {
  saveStateToIndexedDb(clients).catch((error) => {
    console.error('IndexedDB save failed', error);
  });
}

async function init() {
  clients = await loadClientsFromIndexedDb();
  renderRows();
}

function renderRows() {
  clientRows.innerHTML = '';

  clients.forEach((client, index) => {
    const row = rowTemplate.content.firstElementChild.cloneNode(true);
    row.dataset.index = String(index);

    setValue(row, '.enabled', client.enabled);
    setValue(row, '.alias', client.alias);
    setValue(row, '.client-code', client.clientCode);
    setValue(row, '.broker', client.broker);
    setValue(row, '.market-orders', client.marketOrders);
    setValue(row, '.api-key', client.apiKey);
    setValue(row, '.api-secret', client.apiSecret);
    setValue(row, '.totp-secret', client.totpSecret);
    setValue(row, '.pin', client.pin);
    setValue(row, '.historical-api', client.historicalApi);
    setValue(row, '.sqoff-time', client.sqoffTime);
    restoreRowState(row, client);

    row.querySelector('.delete').addEventListener('click', () => {
      clients.splice(index, 1);
      saveClients();
      renderRows();
    });

    row.querySelector('.logout').addEventListener('click', async () => {
      const clientCode = row.querySelector('.client-code').value.trim();
      if (!demoMode.checked && clientCode) {
        await logoutClient(clientCode).catch(() => {});
      }
      updateRowState(row, 'Idle', false, '0.00');
      row.querySelector('.cash-margin').textContent = '0.00';
      row.querySelector('.collateral-margin').textContent = '0.00';
      row.querySelector('.payout-margin').textContent = '0.00';
      clients[index] = readRow(row);
      clients[index].session = null;
      saveClients();
    });

    row.querySelectorAll('input, select').forEach((field) => {
      ['input', 'change'].forEach((eventName) => field.addEventListener(eventName, () => {
        clients[index] = readRow(row);
        saveClients();
      }));
    });

    clientRows.appendChild(row);
  });
}

function syncClientsFromRows() {
  clients = [...clientRows.querySelectorAll('tr')].map(readRow);
}

function setValue(row, selector, value) {
  const field = row.querySelector(selector);
  if (field.type === 'checkbox') {
    field.checked = Boolean(value);
    return;
  }
  field.value = value || '';
}

function readRow(row) {
  return {
    enabled: row.querySelector('.enabled').checked,
    alias: row.querySelector('.alias').value.trim(),
    clientCode: row.querySelector('.client-code').value.trim(),
    broker: row.querySelector('.broker').value,
    marketOrders: row.querySelector('.market-orders').value,
    apiKey: row.querySelector('.api-key').value.trim(),
    apiSecret: row.querySelector('.api-secret').value.trim(),
    totpSecret: row.querySelector('.totp-secret').value.trim(),
    pin: row.querySelector('.pin').value.trim(),
    session: clients[Number(row.dataset.index)]?.session || null,
    historicalApi: row.querySelector('.historical-api').checked,
    sqoffTime: row.querySelector('.sqoff-time').value,
    loggedIn: row.querySelector('.login-state').textContent === 'Yes',
    status: row.querySelector('.status').textContent,
    netMargin: row.querySelector('.net-margin').textContent,
    availableCash: row.querySelector('.cash-margin').textContent,
    collateral: row.querySelector('.collateral-margin').textContent,
    utilisedPayout: row.querySelector('.payout-margin').textContent,
    mtmAll: row.querySelector('.mtm-all').textContent,
    misMtm: row.querySelector('.mis-mtm').textContent,
    nrmlMtm: row.querySelector('.nrml-mtm').textContent,
  };
}

function restoreRowState(row, client) {
  row.querySelector('.login-state').textContent = client.loggedIn ? 'Yes' : 'No';
  row.querySelector('.status').textContent = client.status || 'Idle';
  row.querySelector('.net-margin').textContent = client.netMargin || '0.00';
  row.querySelector('.cash-margin').textContent = client.availableCash || '0.00';
  row.querySelector('.collateral-margin').textContent = client.collateral || '0.00';
  row.querySelector('.payout-margin').textContent = client.utilisedPayout || '0.00';
  row.querySelector('.mtm-all').textContent = client.mtmAll || '0.00';
  row.querySelector('.mis-mtm').textContent = client.misMtm || '0.00';
  row.querySelector('.nrml-mtm').textContent = client.nrmlMtm || '0.00';

  row.classList.toggle('success', Boolean(client.loggedIn));
}

async function runAutoLogin() {
  const rows = [...clientRows.querySelectorAll('tr')];
  const selectedRows = rows.filter((row) => {
    const rowClient = readRow(row);
    return rowClient.enabled && (row.querySelector('.row-select').checked || !hasAnySelected(rows));
  });

  if (!selectedRows.length) {
    markAllIdle('No enabled clients selected');
    return;
  }

  autoLoginBtn.disabled = true;
  addClientBtn.disabled = true;

  for (let i = 0; i < selectedRows.length; i += 1) {
    const row = selectedRows[i];
    const client = readRow(row);
    updateRowState(row, 'Logging in...', false, '0.00', 'running');

    try {
      const result = demoMode.checked
        ? await demoLogin(client, i)
        : await liveLogin(client);

      const status = demoMode.checked
        ? 'Demo login'
        : `Logged in${result.sessionSource ? ` - ${result.sessionSource}` : ''}${result.marginSource ? ` (${result.marginSource})` : ''}`;
      updateRowState(row, status, true, formatMoney(result.availableMargin), 'success');
      row.querySelector('.cash-margin').textContent = formatMoney(result.availableCash);
      row.querySelector('.collateral-margin').textContent = formatMoney(result.collateral);
      row.querySelector('.payout-margin').textContent = formatMoney(result.utilisedPayout);
      row.querySelector('.mtm-all').textContent = formatMoney(result.mtmAll || 0);
      row.querySelector('.mis-mtm').textContent = formatMoney(result.misMtm || 0);
      row.querySelector('.nrml-mtm').textContent = formatMoney(result.nrmlMtm || 0);
      clients[Number(row.dataset.index)] = readRow(row);
      clients[Number(row.dataset.index)].session = result.session || clients[Number(row.dataset.index)].session || null;
      saveClients();
    } catch (error) {
      updateRowState(row, error.message || 'Login failed', false, '0.00', 'failed');
      row.querySelector('.cash-margin').textContent = '0.00';
      row.querySelector('.collateral-margin').textContent = '0.00';
      row.querySelector('.payout-margin').textContent = '0.00';
      clients[Number(row.dataset.index)] = readRow(row);
      clients[Number(row.dataset.index)].session = null;
      saveClients();
    }
  }

  autoLoginBtn.disabled = false;
  addClientBtn.disabled = false;
}

function hasAnySelected(rows) {
  return rows.some((row) => row.querySelector('.row-select').checked);
}

function updateRowState(row, status, loggedIn, margin, className) {
  row.classList.remove('running', 'success', 'failed');
  if (className) row.classList.add(className);
  row.querySelector('.status').textContent = status;
  row.querySelector('.login-state').textContent = loggedIn ? 'Yes' : 'No';
  row.querySelector('.net-margin').textContent = margin;
}

async function liveLogin(client) {
  if (!backendUrl.value.trim()) {
    throw new Error('Backend URL required');
  }

  const response = await fetch(backendUrl.value.trim(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client }),
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok || body.status === false) {
    throw new Error(body.message || `HTTP ${response.status}`);
  }

  return {
    availableMargin: pickMargin(body),
    availableCash: body.data?.availablecash ?? 0,
    collateral: body.data?.collateral ?? 0,
    utilisedPayout: body.data?.utilisedpayout ?? 0,
    marginSource: body.marginSource,
    sessionSource: body.sessionSource,
    session: body.session || null,
    mtmAll: body.mtmAll ?? 0,
    misMtm: body.misMtm ?? 0,
    nrmlMtm: body.nrmlMtm ?? 0,
  };
}

async function logoutClient(clientCode) {
  const logoutUrl = backendUrl.value.trim().replace(/\/auto-login$/, '/logout');
  await fetch(logoutUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientCode }),
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadClientsFromIndexedDb() {
  try {
    const db = await openDb();
    const indexedClients = await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(STORAGE_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    if (Array.isArray(indexedClients) && indexedClients.length) {
      return indexedClients;
    }

    const migrated = loadClients();
    await saveStateToIndexedDb(migrated);
    localStorage.removeItem(STORAGE_KEY);
    return migrated;
  } catch (error) {
    console.error('IndexedDB load failed', error);
    return loadClients();
  }
}

async function saveStateToIndexedDb(value) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(value, STORAGE_KEY);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

function pickMargin(body) {
  return (
    body.availableMargin ??
    body.data?.net ??
    body.data?.availablecash ??
    body.data?.availablelimitmargin ??
    body.data?.collateral ??
    0
  );
}

function demoLogin(client, index) {
  return new Promise((resolve, reject) => {
    window.setTimeout(() => {
      if (!client.clientCode) {
        reject(new Error('Missing User ID'));
        return;
      }

      const seed = client.clientCode
        .split('')
        .reduce((sum, char) => sum + char.charCodeAt(0), 0);

      resolve({
        availableMargin: 25000 + seed * 13 + index * 719,
        availableCash: 25000 + seed * 13 + index * 719,
        collateral: 0,
        utilisedPayout: 0,
        mtmAll: 0,
        misMtm: 0,
        nrmlMtm: 0,
      });
    }, 700);
  });
}

function markAllIdle(message) {
  [...clientRows.querySelectorAll('tr')].forEach((row) => {
    if (row.querySelector('.enabled').checked) {
      row.querySelector('.status').textContent = message;
    }
  });
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
