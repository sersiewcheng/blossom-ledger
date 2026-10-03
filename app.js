/* Blossom Ledger · app.js
 * Draws every page, talks to your Apps Script backend, and runs the theme editor.
 * Nothing in this file is secret.
 */
(function () {
  'use strict';

  const CONFIG = window.BLOSSOM_CONFIG || {};
  const view = document.getElementById('view');

  const state = {
    boot: null,
    period: 'this_month',
    breakdown: 'category',
    dashboard: null,
    filters: { period: 'this_month', search: '', account: '', category: '' }
  };

  const PERIODS = [
    ['this_month', 'This month'],
    ['last_month', 'Last month'],
    ['last_3_months', '3 months'],
    ['this_year', 'This year'],
    ['all_time', 'All time']
  ];

  const PALETTE = ['#e58fae', '#b9a3dc', '#f2b68f', '#8fc9b3', '#f5d38a', '#9bb7d4', '#e7a3c9', '#c7b299', '#a9d6e5', '#f0a3a3'];

  /* ======================= small helpers ======================= */

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function safeColor(c, fallback) {
    const s = String(c || '').trim();
    return /^#[0-9a-f]{3,8}$/i.test(s) ? s : fallback;
  }

  function currency() {
    return (state.boot && state.boot.settings && state.boot.settings.currency) || 'SGD';
  }

  function money(n, cur) {
    const value = Number(n) || 0;
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: String(cur || currency()) }).format(value);
    } catch (e) {
      return (cur || currency()) + ' ' + value.toFixed(2);
    }
  }

  const round2 = n => Math.round(n * 100) / 100;
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const inputDateTime = d => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

  function parseYmd(s) {
    const [y, m, d] = String(s).split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function greeting() {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  }

  function dayLabel(d) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const day = new Date(d); day.setHours(0, 0, 0, 0);
    const diff = Math.round((today - day) / 864e5);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short',
      year: day.getFullYear() === today.getFullYear() ? undefined : 'numeric'
    });
  }

  function periodRange(period) {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth();
    switch (period) {
      case 'last_month':    return { from: new Date(y, m - 1, 1), to: new Date(y, m, 1) };
      case 'last_3_months': return { from: new Date(y, m - 2, 1), to: new Date(y, m + 1, 1) };
      case 'this_year':     return { from: new Date(y, 0, 1), to: new Date(y + 1, 0, 1) };
      case 'all_time':      return { from: new Date(2000, 0, 1), to: new Date(2100, 0, 1) };
      default:              return { from: new Date(y, m, 1), to: new Date(y, m + 1, 1) };
    }
  }

  const periodName = p => (PERIODS.find(x => x[0] === p) || [p, p])[1];
  const findByName = (list, name) => (list || []).find(x => x.name === name);

  function categoryIcon(name) {
    const c = state.boot && findByName(state.boot.categories, name);
    return (c && c.icon) || '🌸';
  }

  function colorFor(kind, name, i) {
    const list = kind === 'category' ? state.boot.categories : kind === 'account' ? state.boot.accounts : null;
    const item = list && findByName(list, name);
    return safeColor(item && item.color, PALETTE[i % PALETTE.length]);
  }

  function tint(color) {
    return `color-mix(in srgb, ${safeColor(color, 'var(--primary)')} 24%, var(--surface))`;
  }

  function load(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }

  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private browsing: ignore */ }
  }

  let toastTimer = null;
  function toast(message, actionLabel, onAction) {
    const el = document.getElementById('toast');
    el.textContent = '';
    const text = document.createElement('span');
    text.textContent = message;
    el.appendChild(text);
    if (actionLabel) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = actionLabel;
      btn.addEventListener('click', async () => {
        el.hidden = true;
        try { await onAction(); } catch (err) { toast('😿 ' + err.message); }
      });
      el.appendChild(btn);
    }
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, actionLabel ? 7000 : 3500);
  }

  /* ======================= talking to the backend ======================= */

  function isDemo() {
    return CONFIG.DEMO_MODE !== false || !CONFIG.API_URL;
  }

  function sessionToken() {
    try { return sessionStorage.getItem('bl_session') || ''; } catch (e) { return ''; }
  }

  // text/plain keeps this a "simple" request, which Apps Script can answer without a CORS preflight.
  async function post(body) {
    const res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      credentials: 'omit'
    });
    try {
      return await res.json();
    } catch (e) {
      throw new Error('The backend replied with something unexpected. Check API_URL in config.js.');
    }
  }

  /** For the login steps, which have no session yet. */
  async function authCall(action, payload) {
    const body = await post({ action: action, payload: payload || {}, sessionToken: sessionToken() });
    if (!body.ok) throw new Error(body.error || 'Something went wrong.');
    return body.data || {};
  }

  /** For everything else. Sends you back to the login screen if the session has ended. */
  async function api(action, payload) {
    if (isDemo()) return Demo.handle(action, payload || {});
    const body = await post({ action: action, payload: payload || {}, sessionToken: sessionToken() });
    if (!body.ok) {
      if (body.error === 'unauthorized') {
        setToken('');
        showLogin('Your session ended. Please sign in again.');
        throw new Error('Signed out');
      }
      throw new Error(body.error || 'Something went wrong.');
    }
    return body.data;
  }

  function setToken(token) {
    try {
      if (token) sessionStorage.setItem('bl_session', token);
      else sessionStorage.removeItem('bl_session');
    } catch (e) { /* private browsing: ignore */ }
  }

  async function ensureBoot() {
    if (state.boot) return;
    state.boot = await api('getBootstrap');
    const name = state.boot.settings.display_name || '';
    document.getElementById('sidebar-foot').textContent = `${name ? name + ' · ' : ''}${isDemo() ? 'demo mode' : 'connected'}`;
  }

  /* ======================= demo data (used until Step 6) ======================= */

  const Demo = (() => {
    let db = null;

    function random(seed) {
      return () => {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    function build() {
      const r = random(20260918);
      const now = new Date();
      const data = {
        settings: { currency: 'SGD', display_name: 'Dee', timezone: 'Asia/Singapore' },
        accounts: [
          { account_id: 'acc_001', name: 'DBS Savings', type: 'Savings', class: 'Asset', opening_balance: 8200, credit_limit: null, icon: '🏦', color: '#E8A0BF', is_active: true },
          { account_id: 'acc_002', name: 'OCBC Bank', type: 'Bank', class: 'Asset', opening_balance: 2400, credit_limit: null, icon: '🏛️', color: '#F7C8A0', is_active: true },
          { account_id: 'acc_003', name: 'Citi Credit Card', type: 'Credit Card', class: 'Liability', opening_balance: 0, credit_limit: 8000, icon: '💳', color: '#C9A7EB', is_active: true },
          { account_id: 'acc_004', name: 'Cash Wallet', type: 'Cash', class: 'Asset', opening_balance: 150, credit_limit: null, icon: '👛', color: '#B8E0D2', is_active: true },
          { account_id: 'acc_005', name: 'Crypto Wallet', type: 'Crypto', class: 'Asset', opening_balance: 1800, credit_limit: null, icon: '🪙', color: '#A7C7E7', is_active: true }
        ],
        categories: [
          { name: 'Food & Dining', kind: 'Expense', parent: '', icon: '🍽️', color: '#F4A6B7', is_active: true },
          { name: 'Coffee & Cafés', kind: 'Expense', parent: 'Food & Dining', icon: '☕', color: '#D4A373', is_active: true },
          { name: 'Groceries', kind: 'Expense', parent: '', icon: '🛒', color: '#A8D5BA', is_active: true },
          { name: 'Transport', kind: 'Expense', parent: '', icon: '🚗', color: '#9BB7D4', is_active: true },
          { name: 'Shopping', kind: 'Expense', parent: '', icon: '🛍️', color: '#E2B6CF', is_active: true },
          { name: 'Bills & Utilities', kind: 'Expense', parent: '', icon: '💡', color: '#F6D186', is_active: true },
          { name: 'Health & Beauty', kind: 'Expense', parent: '', icon: '💅', color: '#FFB5C2', is_active: true },
          { name: 'Entertainment', kind: 'Expense', parent: '', icon: '🎬', color: '#C3B1E1', is_active: true },
          { name: 'Salary', kind: 'Income', parent: '', icon: '💰', color: '#9ED2BE', is_active: true },
          { name: 'Other Income', kind: 'Income', parent: '', icon: '🎁', color: '#B5EAD7', is_active: true },
          { name: 'Transfer', kind: 'Transfer', parent: '', icon: '🔁', color: '#CFCFE8', is_active: true }
        ],
        merchants: ['Starbucks', 'Toast Box', 'Din Tai Fung', 'FairPrice', 'Cold Storage', 'Grab', 'Shopee', 'SP Group', 'Guardian', 'Netflix'].map(name => ({ name })),
        budgets: [
          { category: 'Food & Dining', period: 'Monthly', amount: 500, alert_pct: 80 },
          { category: 'Transport', period: 'Monthly', amount: 200, alert_pct: 80 },
          { category: 'Shopping', period: 'Monthly', amount: 250, alert_pct: 80 },
          { category: 'Groceries', period: 'Monthly', amount: 400, alert_pct: 80 }
        ],
        txns: []
      };

      const kindOf = name => (data.categories.find(c => c.name === name) || {}).kind || 'Expense';
      const add = (date, amount, category, account, merchant, description, toAccount) => {
        if (date > now) return;
        data.txns.push({
          txn_id: 'demo_' + data.txns.length,
          txn_datetime: date.toISOString(),
          amount: round2(amount),
          kind: kindOf(category),
          category: category,
          account: account,
          to_account: toAccount || '',
          merchant: merchant || '',
          description: description || '',
          status: 'cleared',
          source: r() < 0.5 ? 'telegram' : 'web'
        });
      };
      const daysAgo = (n, hour) => {
        const d = new Date(now);
        d.setDate(d.getDate() - n);
        d.setHours(hour, Math.floor(r() * 60), 0, 0);
        return d;
      };

      for (let n = 0; n < 150; n++) {
        if (r() < 0.6) add(daysAgo(n, 9), 5.2 + r() * 2.4, 'Coffee & Cafés', r() < 0.6 ? 'Citi Credit Card' : 'Cash Wallet', r() < 0.6 ? 'Starbucks' : 'Toast Box');
        if (r() < 0.7) add(daysAgo(n, 12), 8 + r() * 14, 'Food & Dining', r() < 0.5 ? 'OCBC Bank' : 'Citi Credit Card', r() < 0.3 ? 'Din Tai Fung' : '', 'lunch');
        if (r() < 0.45) add(daysAgo(n, 8), 4 + r() * 18, 'Transport', 'Citi Credit Card', 'Grab');
        if (n % 7 === 2) add(daysAgo(n, 18), 55 + r() * 50, 'Groceries', 'OCBC Bank', r() < 0.5 ? 'FairPrice' : 'Cold Storage');
        if (r() < 0.08) add(daysAgo(n, 21), 25 + r() * 90, 'Shopping', 'Citi Credit Card', 'Shopee');
        if (r() < 0.05) add(daysAgo(n, 15), 15 + r() * 40, 'Health & Beauty', 'OCBC Bank', 'Guardian');
      }
      for (let m = 0; m < 5; m++) {
        const at = (day, hour) => new Date(now.getFullYear(), now.getMonth() - m, day, hour, 0, 0);
        add(at(1, 10), 200, 'Transfer', 'OCBC Bank', '', 'ATM cash', 'Cash Wallet');
        add(at(5, 10), 95 + r() * 60, 'Bills & Utilities', 'OCBC Bank', 'SP Group', 'Electricity');
        add(at(12, 8), 19.98, 'Entertainment', 'Citi Credit Card', 'Netflix');
        add(at(20, 19), 550, 'Transfer', 'OCBC Bank', '', 'Credit card bill', 'Citi Credit Card');
        add(at(25, 9), 4200, 'Salary', 'OCBC Bank', '', 'Monthly salary');
        add(at(26, 9), 1500, 'Transfer', 'OCBC Bank', '', 'Monthly savings', 'DBS Savings');
      }
      return data;
    }

    const live = () => db.txns.filter(t => t.status !== 'void');
    const inRange = (t, range) => { const d = new Date(t.txn_datetime); return d >= range.from && d < range.to; };

    function balances() {
      const accounts = db.accounts.map(a => Object.assign({}, a, { balance: a.opening_balance }));
      const byName = {};
      accounts.forEach(a => { byName[a.name] = a; });
      const apply = (a, moneyIn) => { if (a) a.balance += a.class === 'Liability' ? -moneyIn : moneyIn; };
      live().forEach(t => {
        const from = byName[t.account];
        if (t.kind === 'Expense') apply(from, -t.amount);
        else if (t.kind === 'Income') apply(from, t.amount);
        else if (t.kind === 'Transfer') { apply(from, -t.amount); apply(byName[t.to_account], t.amount); }
      });
      let assets = 0, liabilities = 0;
      accounts.forEach(a => {
        a.balance = round2(a.balance);
        if (a.class === 'Liability') {
          liabilities += a.balance;
          a.available_credit = a.credit_limit != null ? round2(a.credit_limit - a.balance) : null;
        } else {
          assets += a.balance;
          a.available_credit = null;
        }
      });
      return { accounts, total_assets: round2(assets), total_liabilities: round2(liabilities), net_worth: round2(assets - liabilities) };
    }

    function top(totals, n) {
      const grand = Object.values(totals).reduce((s, v) => s + v, 0);
      return Object.keys(totals)
        .map(name => ({ name, amount: round2(totals[name]), pct: grand ? Math.round(totals[name] / grand * 100) : 0 }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, n);
    }

    function budgets() {
      const month = periodRange('this_month');
      return db.budgets.map(b => {
        const names = [b.category].concat(db.categories.filter(c => c.parent === b.category).map(c => c.name));
        const spent = round2(live()
          .filter(t => t.kind === 'Expense' && names.includes(t.category) && inRange(t, month))
          .reduce((s, t) => s + t.amount, 0));
        const pct = Math.round(spent / b.amount * 100);
        return {
          category: b.category, period: b.period, limit: b.amount, spent,
          remaining: round2(b.amount - spent), pct, alert_pct: b.alert_pct,
          status: pct >= 100 ? 'over' : pct >= b.alert_pct ? 'warning' : 'ok'
        };
      });
    }

    function trend() {
      const now = new Date();
      const months = [];
      for (let i = 5; i >= 0; i--) {
        const from = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const to = new Date(from.getFullYear(), from.getMonth() + 1, 1);
        let income = 0, expense = 0;
        live().forEach(t => {
          if (!inRange(t, { from, to })) return;
          if (t.kind === 'Income') income += t.amount;
          else if (t.kind === 'Expense') expense += t.amount;
        });
        months.push({ month: `${from.getFullYear()}-${pad(from.getMonth() + 1)}`, income: round2(income), expense: round2(expense) });
      }
      return months;
    }

    function dashboard(p) {
      const period = p.period || 'this_month';
      const range = periodRange(period);
      let income = 0, expense = 0;
      const byCategory = {}, byAccount = {}, byMerchant = {};
      const bump = (map, key, amt) => { map[key] = (map[key] || 0) + amt; };
      live().forEach(t => {
        if (!inRange(t, range)) return;
        if (t.kind === 'Income') income += t.amount;
        else if (t.kind === 'Expense') {
          expense += t.amount;
          bump(byCategory, t.category, t.amount);
          bump(byAccount, t.account, t.amount);
          bump(byMerchant, t.merchant || '(no merchant)', t.amount);
        }
      });
      return {
        period, income: round2(income), expense: round2(expense), net: round2(income - expense),
        savings_rate_pct: income > 0 ? Math.round((income - expense) / income * 100) : null,
        by_category: top(byCategory, 10), by_account: top(byAccount, 10), by_merchant: top(byMerchant, 10),
        trend: trend(), budgets: budgets(), balances: balances()
      };
    }

    function list(p) {
      const from = p.from ? parseYmd(p.from) : null;
      let to = p.to ? parseYmd(p.to) : null;
      if (to) to = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
      const q = String(p.search || '').toLowerCase();
      return db.txns
        .filter(t => {
          const d = new Date(t.txn_datetime);
          if (!p.include_void && t.status === 'void') return false;
          if (from && d < from) return false;
          if (to && d >= to) return false;
          if (p.account && t.account !== p.account && t.to_account !== p.account) return false;
          if (p.category && t.category !== p.category) return false;
          if (q && ![t.merchant, t.description, t.category].join(' ').toLowerCase().includes(q)) return false;
          return true;
        })
        .sort((a, b) => new Date(b.txn_datetime) - new Date(a.txn_datetime))
        .slice(0, Math.min(Number(p.limit) || 50, 500));
    }

    function addTxn(p) {
      const amount = round2(Number(p.amount));
      if (!(amount > 0)) throw new Error('Amount must be a positive number.');
      const category = findByName(db.categories, p.category);
      if (!category) throw new Error(`I don't know the category "${p.category}".`);
      if (!findByName(db.accounts, p.account)) throw new Error(`I don't know the account "${p.account}".`);
      if (category.kind === 'Transfer' && (!findByName(db.accounts, p.to_account) || p.to_account === p.account)) {
        throw new Error('A transfer needs a different "to" account.');
      }
      const when = p.txn_datetime ? new Date(String(p.txn_datetime).replace(' ', 'T')) : new Date();
      const txn = {
        txn_id: 'demo_' + db.txns.length, txn_datetime: when.toISOString(), amount, kind: category.kind,
        category: category.name, account: p.account, to_account: category.kind === 'Transfer' ? p.to_account : '',
        merchant: p.merchant || '', description: p.description || '', status: 'cleared', source: 'web'
      };
      db.txns.push(txn);
      if (txn.merchant && !findByName(db.merchants, txn.merchant)) db.merchants.push({ name: txn.merchant });
      const b = balances();
      return {
        txn,
        account_balance: findByName(b.accounts, txn.account) || null,
        to_account_balance: txn.to_account ? findByName(b.accounts, txn.to_account) || null : null
      };
    }

    function demoImportPreview(p) {
      const account = findByName(db.accounts, p.account) || db.accounts[0];
      const isCard = String(p.statement_type) === 'card' || account.class === 'Liability';
      const rows = (p.rows || []).map((raw, i) => {
        const signed = Number(raw.amount) || 0;
        const hay = String(raw.description || '').toLowerCase();
        const kind = isCard ? (signed >= 0 ? 'Expense' : 'Transfer') : (signed >= 0 ? 'Income' : 'Expense');
        const hit = db.categories.find(c => c.kind === kind && hay && String(c.name).toLowerCase().split(' ')[0] && hay.includes(String(c.name).toLowerCase().split(' ')[0]));
        const notes = [];
        if (!hit) notes.push('Pick a category');
        return {
          line: i + 1, date: String(raw.date || ''), amount: Math.abs(signed), kind: kind,
          category: hit ? hit.name : '', account: account.name, to_account: '', merchant: '',
          description: String(raw.description || ''), raw: String(raw.description || ''),
          duplicate: false, include: !!hit, needs_review: notes.length > 0, notes: notes
        };
      });
      return {
        batch_id: 'demo_' + Date.now(), account: account.name, statement_type: isCard ? 'card' : 'bank', rows: rows,
        summary: { total: rows.length, ready: rows.filter(r => r.include).length, duplicates: 0, needs_review: rows.filter(r => r.needs_review).length }
      };
    }

    function demoImportCommit(p) {
      let imported = 0;
      (p.rows || []).forEach(r => {
        if (r.include === false) return;
        try { addTxn({ amount: r.amount, category: r.category, account: r.account, to_account: r.to_account, merchant: r.merchant, description: r.description, txn_datetime: r.date }); imported++; } catch (e) { /* skip */ }
      });
      return { batch_id: p.batch_id, imported: imported, skipped: [], balances: balances() };
    }

    function voidTxn(id) {
      const txn = db.txns.find(t => t.txn_id === id);
      if (!txn) throw new Error('Transaction not found.');
      if (txn.status === 'void') throw new Error('That transaction was already undone.');
      txn.status = 'void';
      return { txn, account_balance: findByName(balances().accounts, txn.account) || null };
    }

    function run(action, p) {
      switch (action) {
        case 'getBootstrap': return { settings: db.settings, accounts: db.accounts, categories: db.categories, merchants: db.merchants };
        case 'getBalances': return balances();
        case 'getDashboard': return dashboard(p);
        case 'getBudgetStatus': return budgets();
        case 'listTransactions': return list(p);
        case 'importPreview': return demoImportPreview(p);
        case 'importCommit': return demoImportCommit(p);
        case 'undoImportBatch': return { batch_id: p.batch_id, voided: 0, balances: balances() };
        case 'listImportBatches': return [];
        case 'addTransaction': return addTxn(p);
        case 'voidTransaction': return voidTxn(p.txn_id);
        default: throw new Error('Unknown action: ' + action);
      }
    }

    function handle(action, payload) {
      if (!db) db = build();
      return new Promise((resolve, reject) => setTimeout(() => {
        try { resolve(JSON.parse(JSON.stringify(run(action, payload)))); } catch (err) { reject(err); }
      }, 180));
    }

    return { handle };
  })();

  /* ======================= themes ======================= */

  const THEMES = {
    rose: {
      name: 'Rose Quartz', dark: false,
      vars: { '--bg': '#fdf6f8', '--surface': '#ffffff', '--surface-2': '#fbeef2', '--text': '#3d2b33', '--muted': '#8c737c', '--border': '#f2dfe6', '--primary': '#d4789a', '--primary-ink': '#ffffff', '--accent': '#b9a3dc' }
    },
    lavender: {
      name: 'Lavender Mist', dark: false,
      vars: { '--bg': '#f8f6fd', '--surface': '#ffffff', '--surface-2': '#efeafb', '--text': '#342d45', '--muted': '#7d7591', '--border': '#e6e0f5', '--primary': '#9b82d3', '--primary-ink': '#ffffff', '--accent': '#e9a6c8' }
    },
    peach: {
      name: 'Peach Blossom', dark: false,
      vars: { '--bg': '#fff8f3', '--surface': '#ffffff', '--surface-2': '#fdeee2', '--text': '#43302a', '--muted': '#8f766b', '--border': '#f6e1d2', '--primary': '#e0896a', '--primary-ink': '#ffffff', '--accent': '#f0bd5e' }
    },
    sage: {
      name: 'Sage Garden', dark: false,
      vars: { '--bg': '#f5f8f4', '--surface': '#ffffff', '--surface-2': '#e9f1e7', '--text': '#2e3a31', '--muted': '#6f7f72', '--border': '#dde8da', '--primary': '#6fa283', '--primary-ink': '#ffffff', '--accent': '#e3a7b5' }
    },
    midnight: {
      name: 'Midnight Orchid', dark: true,
      vars: { '--bg': '#1c1623', '--surface': '#261e2f', '--surface-2': '#30263b', '--text': '#f3e9f5', '--muted': '#b3a3bb', '--border': '#3a2f46', '--primary': '#d38bc0', '--primary-ink': '#1c1623', '--accent': '#8f7ad8' }
    }
  };

  const FONTS = {
    serif: '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif',
    rounded: 'ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", system-ui, sans-serif',
    sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
  };

  const Theme = {
    defaults(preset) {
      const key = THEMES[preset] ? preset : 'rose';
      const v = THEMES[key].vars;
      return { preset: key, primary: v['--primary'], accent: v['--accent'], bg: v['--bg'], radius: 18, font: 'serif' };
    },
    current() {
      const saved = load('bl_theme') || {};
      const t = Theme.defaults(saved.preset);
      t.primary = safeColor(saved.primary, t.primary);
      t.accent = safeColor(saved.accent, t.accent);
      t.bg = safeColor(saved.bg, t.bg);
      t.radius = Math.min(28, Math.max(4, Number(saved.radius) || t.radius));
      t.font = FONTS[saved.font] ? saved.font : t.font;
      return t;
    },
    save(t) {
      save('bl_theme', t);
      Theme.apply(t);
    },
    apply(t) {
      const base = THEMES[t.preset] || THEMES.rose;
      const root = document.documentElement.style;
      Object.keys(base.vars).forEach(k => root.setProperty(k, base.vars[k]));
      root.setProperty('--primary', t.primary);
      root.setProperty('--accent', t.accent);
      root.setProperty('--bg', t.bg);
      root.setProperty('--radius', t.radius + 'px');
      root.setProperty('--font-display', FONTS[t.font] || FONTS.serif);
      root.colorScheme = base.dark ? 'dark' : 'light';
    }
  };

  /* ======================= shared page pieces ======================= */

  function txListHtml(txns, allowUndo) {
    if (!txns.length) return '<div class="empty">Nothing here yet 🌱</div>';
    let lastDay = '';
    return txns.map(t => {
      const d = new Date(t.txn_datetime);
      const day = dayLabel(d);
      const head = day !== lastDay ? `<div class="tx-day">${esc(day)}</div>` : '';
      lastDay = day;
      const kind = String(t.kind || '').toLowerCase();
      const sign = t.kind === 'Income' ? '+' : t.kind === 'Transfer' ? '' : '−';
      const title = t.merchant || t.description || t.category;
      const sub = t.kind === 'Transfer'
        ? `${t.account} → ${t.to_account}`
        : [t.category, t.account, t.merchant ? t.description : ''].filter(Boolean).join(' · ');
      const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `${head}<div class="tx">
        <div class="ico-box">${esc(categoryIcon(t.category))}</div>
        <div class="meta"><strong>${esc(title)}</strong><small>${esc(sub)} · ${esc(time)}</small></div>
        <div class="amt ${esc(kind)}">${sign}${esc(money(t.amount))}</div>
        ${allowUndo ? `<button class="icon-btn" type="button" data-void="${esc(t.txn_id)}" title="Undo this entry" aria-label="Undo this entry">✕</button>` : ''}
      </div>`;
    }).join('');
  }

  function accountsHtml(accounts) {
    const active = accounts.filter(a => a.is_active !== false);
    if (!active.length) return '<div class="empty">No accounts yet. Add them in the Accounts tab of your Sheet.</div>';
    const block = (title, list) => !list.length ? '' : `<div class="eyebrow group-title">${title}</div>` + list.map(a => `
      <div class="acct">
        <div class="ico-box" style="background:${tint(a.color)}">${esc(a.icon || '•')}</div>
        <div class="meta"><strong>${esc(a.name)}</strong>
          <small>${esc(a.type)}${a.available_credit != null ? ' · ' + esc(money(a.available_credit, a.currency)) + ' available' : ''}</small></div>
        <div class="amt">${esc(money(a.balance, a.currency))}${a.class === 'Liability' ? ' <small class="muted">owed</small>' : ''}</div>
      </div>`).join('');
    return block('Assets', active.filter(a => a.class !== 'Liability')) + block('Liabilities', active.filter(a => a.class === 'Liability'));
  }

  function budgetsHtml(budgets) {
    if (!budgets || !budgets.length) return '<div class="empty">No budgets yet. Add them in the Budgets tab of your Sheet 🎯</div>';
    return `<div class="rings">${budgets.map(b => {
      const pct = Number(b.pct) || 0;
      const color = b.status === 'over' ? 'var(--bad)' : b.status === 'warning' ? 'var(--warn)' : 'var(--primary)';
      const left = b.remaining >= 0 ? `${money(b.remaining)} left` : `${money(-b.remaining)} over`;
      return `<div class="ring">
        <div class="circle" style="background:conic-gradient(${color} ${Math.min(pct, 100)}%, var(--surface-2) 0)"><b>${pct}%</b></div>
        <strong>${esc(categoryIcon(b.category))} ${esc(b.category)}</strong>
        <small>${esc(left)}</small>
      </div>`;
    }).join('')}</div>`;
  }

  function trendHtml(trend) {
    const max = Math.max(1, ...trend.map(m => Math.max(m.income, m.expense)));
    return `<div class="trend">${trend.map(m => {
      const [y, mo] = m.month.split('-').map(Number);
      const label = new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: 'short' });
      return `<div class="month">
        <div class="bars">
          <span style="height:${(m.income / max * 100).toFixed(1)}%;background:var(--accent)" title="Money in: ${esc(money(m.income))}"></span>
          <span style="height:${(m.expense / max * 100).toFixed(1)}%;background:var(--primary)" title="Spent: ${esc(money(m.expense))}"></span>
        </div>${esc(label)}
      </div>`;
    }).join('')}</div>`;
  }

  /* ======================= page: dashboard ======================= */

  async function renderDashboard() {
    const [d, recent] = await Promise.all([
      api('getDashboard', { period: state.period }),
      api('listTransactions', { limit: 6 })
    ]);
    state.dashboard = d;
    const b = d.balances;
    const name = state.boot.settings.display_name || '';
    const both = b.total_assets + b.total_liabilities;
    const assetShare = both > 0 ? Math.round(b.total_assets / both * 100) : 100;

    view.innerHTML = `
      <div class="page-head fade-in">
        <div><h1>${esc(greeting())}${name ? ', ' + esc(name) : ''} 🌸</h1><p>Here's how your money is blooming.</p></div>
        <div class="chips" id="period-chips">${PERIODS.map(([k, label]) =>
          `<button type="button" class="chip ${k === state.period ? 'on' : ''}" data-period="${k}">${label}</button>`).join('')}</div>
      </div>

      <div class="grid fade-in">
        <section class="card hero span-7">
          <div class="eyebrow">Net worth</div>
          <div class="hero-amount">${esc(money(b.net_worth))}</div>
          <div class="split">
            <div><span class="eyebrow">Total assets</span><strong>${esc(money(b.total_assets))}</strong></div>
            <div><span class="eyebrow">Total liabilities</span><strong>${esc(money(b.total_liabilities))}</strong></div>
          </div>
          <div class="ratio"><span style="width:${assetShare}%"></span></div>
          <div class="ratio-note">${assetShare}% of what you hold is yours outright</div>
        </section>

        <section class="card span-5">
          <div class="eyebrow">${esc(periodName(state.period))}</div>
          <div class="stat-grid">
            <div class="stat"><span class="muted">Money in</span><div class="value pos">${esc(money(d.income))}</div></div>
            <div class="stat"><span class="muted">Spent</span><div class="value">${esc(money(d.expense))}</div></div>
            <div class="stat"><span class="muted">Saved</span><div class="value ${d.net >= 0 ? 'pos' : 'neg'}">${esc(money(d.net))}</div></div>
            <div class="stat"><span class="muted">Savings rate</span><div class="value">${d.savings_rate_pct == null ? '—' : esc(d.savings_rate_pct) + '%'}</div></div>
          </div>
        </section>

        <section class="card span-8">
          <h2>Where it went
            <span class="chips small" id="breakdown-chips">${[['category', 'Category'], ['account', 'Account'], ['merchant', 'Merchant']].map(([k, label]) =>
              `<button type="button" class="chip ${k === state.breakdown ? 'on' : ''}" data-breakdown="${k}">${label}</button>`).join('')}</span>
          </h2>
          <div id="breakdown"></div>
        </section>

        <section class="card span-4"><h2>Budgets <span class="legend">this month</span></h2>${budgetsHtml(d.budgets)}</section>

        <section class="card span-6"><h2>Accounts</h2>${accountsHtml(b.accounts)}</section>

        <section class="card span-6">
          <h2>6-month trend
            <span class="legend"><span><i class="dot" style="background:var(--accent)"></i>In</span><span><i class="dot" style="background:var(--primary)"></i>Out</span></span>
          </h2>
          ${trendHtml(d.trend)}
        </section>

        <section class="card span-12"><h2>Recent <a class="link" href="#/transactions">See all →</a></h2>${txListHtml(recent, false)}</section>
      </div>`;

    renderBreakdown();

    document.getElementById('period-chips').addEventListener('click', e => {
      const btn = e.target.closest('[data-period]');
      if (!btn || btn.dataset.period === state.period) return;
      state.period = btn.dataset.period;
      renderDashboard().catch(showError);
    });
    document.getElementById('breakdown-chips').addEventListener('click', e => {
      const btn = e.target.closest('[data-breakdown]');
      if (!btn) return;
      state.breakdown = btn.dataset.breakdown;
      document.querySelectorAll('[data-breakdown]').forEach(c => c.classList.toggle('on', c === btn));
      renderBreakdown();
    });
  }

  function renderBreakdown() {
    const d = state.dashboard;
    const key = state.breakdown;
    const items = key === 'account' ? d.by_account : key === 'merchant' ? d.by_merchant : d.by_category;
    const box = document.getElementById('breakdown');
    if (!items || !items.length) {
      box.innerHTML = '<div class="empty">No spending in this period yet 🌱</div>';
      return;
    }
    const total = items.reduce((s, it) => s + it.amount, 0) || 1;
    const max = Math.max(...items.map(it => it.amount)) || 1;
    const colors = items.map((it, i) => colorFor(key, it.name, i));
    let acc = 0;
    const stops = items.map((it, i) => {
      const start = acc;
      acc += it.amount / total * 100;
      return `${colors[i]} ${start.toFixed(2)}% ${acc.toFixed(2)}%`;
    }).join(', ');

    box.innerHTML = `
      <div class="breakdown">
        <div class="donut" style="background:conic-gradient(${stops})">
          <div class="donut-label"><div>Spent<strong>${esc(money(d.expense))}</strong></div></div>
        </div>
        <ul class="rank">${items.map((it, i) => `
          <li>
            <span><i class="dot" style="background:${colors[i]}"></i>${key === 'category' ? esc(categoryIcon(it.name)) + ' ' : ''}${esc(it.name)}</span>
            <span>${esc(money(it.amount))} <small class="muted">${esc(it.pct)}%</small></span>
            <span class="bar"><span style="width:${(it.amount / max * 100).toFixed(1)}%;background:${colors[i]}"></span></span>
          </li>`).join('')}
        </ul>
      </div>`;
  }

  /* ======================= page: add an entry ======================= */

  function renderAdd() {
    const categories = state.boot.categories.filter(c => c.is_active !== false && c.kind);
    const accounts = state.boot.accounts.filter(a => a.is_active !== false);
    const lastAccount = load('bl_last_account');
    const groups = [['Expense', 'Spending 💸'], ['Income', 'Money in 💰'], ['Transfer', 'Moving money 🔁']];
    const options = accounts.map(a => `<option value="${esc(a.name)}" ${a.name === lastAccount ? 'selected' : ''}>${esc(a.icon || '')} ${esc(a.name)}</option>`).join('');

    view.innerHTML = `
      <div class="page-head fade-in">
        <div><h1>Add an entry 🌷</h1><p>Date and time are filled in for you. The category decides whether it's money out, in, or a transfer.</p></div>
      </div>

      <form class="card form fade-in" id="add-form" novalidate>
        <div class="field">
          <label for="f-amount">Amount (${esc(currency())})</label>
          <input class="input amount-input" id="f-amount" inputmode="decimal" autocomplete="off" placeholder="0.00">
        </div>

        <div class="field">
          <span class="label">Category</span>
          ${groups.map(([kind, label]) => {
            const list = categories.filter(c => c.kind === kind);
            return !list.length ? '' : `<div class="cat-group"><div class="label">${label}</div><div class="chips">${list.map(c =>
              `<button type="button" class="chip" data-cat="${esc(c.name)}" data-kind="${esc(kind)}">${esc(c.icon || '')} ${esc(c.name)}</button>`).join('')}</div></div>`;
          }).join('')}
        </div>

        <div class="kind-note" id="kind-note">Pick a category to begin ✨</div>

        <div class="row2">
          <div class="field"><label for="f-account" id="account-label">Paid from</label><select class="input" id="f-account">${options}</select></div>
          <div class="field" id="to-wrap" hidden><label for="f-to">Moving to</label><select class="input" id="f-to">${options}</select></div>
          <div class="field" id="merchant-wrap">
            <label for="f-merchant">Merchant or shop</label>
            <input class="input" id="f-merchant" list="merchant-list" autocomplete="off" placeholder="e.g. Starbucks">
            <datalist id="merchant-list">${state.boot.merchants.map(m => `<option value="${esc(m.name)}"></option>`).join('')}</datalist>
          </div>
        </div>

        <div class="row2">
          <div class="field"><label for="f-when">When</label><input class="input" type="datetime-local" id="f-when" value="${inputDateTime(new Date())}"></div>
          <div class="field"><label for="f-desc">Note</label><input class="input" id="f-desc" autocomplete="off" placeholder="optional"></div>
        </div>

        <div class="actions">
          <button class="btn" type="submit" id="f-save">Save entry</button>
          <button class="btn ghost" type="button" id="f-clear">Clear</button>
        </div>
      </form>`;

    const $ = id => document.getElementById(id);
    let selected = null;

    const NOTES = {
      Expense: ['Paid from', '💸 This will be recorded as <b>money out</b>.'],
      Income: ['Received into', '💰 This will be recorded as <b>money in</b>.'],
      Transfer: ['Moving from', '🔁 This moves money between your own accounts. It is not counted as spending.']
    };

    function select(chip) {
      document.querySelectorAll('[data-cat]').forEach(c => c.classList.toggle('on', c === chip));
      selected = chip ? { name: chip.dataset.cat, kind: chip.dataset.kind } : null;
      const note = selected ? NOTES[selected.kind] : null;
      $('kind-note').innerHTML = note ? note[1] : 'Pick a category to begin ✨';
      $('account-label').textContent = note ? note[0] : 'Paid from';
      $('to-wrap').hidden = !selected || selected.kind !== 'Transfer';
      $('merchant-wrap').hidden = !!selected && selected.kind === 'Transfer';
    }

    document.querySelectorAll('[data-cat]').forEach(chip => chip.addEventListener('click', () => select(chip)));

    $('f-clear').addEventListener('click', () => {
      $('f-amount').value = '';
      $('f-merchant').value = '';
      $('f-desc').value = '';
      $('f-when').value = inputDateTime(new Date());
      select(null);
      $('f-amount').focus();
    });

    $('add-form').addEventListener('submit', async e => {
      e.preventDefault();
      const amount = parseFloat(String($('f-amount').value).replace(/,/g, ''));
      if (!(amount > 0)) { toast('Please enter an amount above zero 💕'); $('f-amount').focus(); return; }
      if (!selected) { toast('Pick a category first 🌷'); return; }
      const isTransfer = selected.kind === 'Transfer';
      if (isTransfer && $('f-to').value === $('f-account').value) { toast('Choose two different accounts for a transfer 🔁'); return; }

      const payload = {
        amount: amount,
        category: selected.name,
        account: $('f-account').value,
        to_account: isTransfer ? $('f-to').value : '',
        merchant: isTransfer ? '' : $('f-merchant').value.trim(),
        description: $('f-desc').value.trim(),
        txn_datetime: $('f-when').value ? $('f-when').value.replace('T', ' ') : ''
      };

      const btn = $('f-save');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        const result = await api('addTransaction', payload);
        save('bl_last_account', payload.account);
        const bal = result.account_balance;
        const balText = bal ? ` · ${bal.name}: ${money(bal.balance, bal.currency)}${bal.class === 'Liability' ? ' owed' : ''}` : '';
        toast(`Saved ✨${balText}`, 'Undo', async () => {
          await api('voidTransaction', { txn_id: result.txn.txn_id });
          toast('Undone ↩️');
        });
        $('f-amount').value = '';
        $('f-merchant').value = '';
        $('f-desc').value = '';
        $('f-when').value = inputDateTime(new Date());
        $('f-amount').focus();
      } catch (err) {
        toast('😿 ' + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Save entry';
      }
    });

    $('f-amount').focus();
  }

  /* ======================= page: transactions ======================= */

  async function renderTransactions() {
    const f = state.filters;
    const accounts = state.boot.accounts.filter(a => a.is_active !== false);
    const categories = state.boot.categories.filter(c => c.is_active !== false);

    view.innerHTML = `
      <div class="page-head fade-in"><div><h1>Transactions 🧾</h1><p id="tx-summary">Loading…</p></div></div>
      <div class="card fade-in">
        <div class="filters">
          <input class="input" id="t-search" placeholder="Search merchant or note…" value="${esc(f.search)}" autocomplete="off">
          <select class="input" id="t-period">${PERIODS.map(([k, label]) => `<option value="${k}" ${k === f.period ? 'selected' : ''}>${label}</option>`).join('')}</select>
          <select class="input" id="t-account"><option value="">All accounts</option>${accounts.map(a =>
            `<option value="${esc(a.name)}" ${a.name === f.account ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
          <select class="input" id="t-category"><option value="">All categories</option>${categories.map(c =>
            `<option value="${esc(c.name)}" ${c.name === f.category ? 'selected' : ''}>${esc(c.icon || '')} ${esc(c.name)}</option>`).join('')}</select>
        </div>
        <div id="t-list"><div class="loading">Loading… 🌸</div></div>
      </div>`;

    const $ = id => document.getElementById(id);
    let searchTimer = null;
    $('t-search').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { f.search = $('t-search').value.trim(); loadTransactions(); }, 300);
    });
    ['t-period', 't-account', 't-category'].forEach(id => $(id).addEventListener('change', () => {
      f.period = $('t-period').value;
      f.account = $('t-account').value;
      f.category = $('t-category').value;
      loadTransactions();
    }));

    $('t-list').addEventListener('click', async e => {
      const btn = e.target.closest('[data-void]');
      if (!btn) return;
      if (!window.confirm('Undo this entry? It stays in your Sheet, marked as void.')) return;
      btn.disabled = true;
      try {
        await api('voidTransaction', { txn_id: btn.dataset.void });
        toast('Undone ↩️');
        loadTransactions();
      } catch (err) {
        btn.disabled = false;
        toast('😿 ' + err.message);
      }
    });

    await loadTransactions();
  }

  async function loadTransactions() {
    const f = state.filters;
    const range = periodRange(f.period);
    const list = document.getElementById('t-list');
    if (!list) return;
    try {
      const txns = await api('listTransactions', {
        from: ymd(range.from),
        to: ymd(new Date(range.to.getTime() - 1)),
        account: f.account,
        category: f.category,
        search: f.search,
        limit: 300
      });
      if (!document.getElementById('t-list')) return; // user left the page
      const spent = txns.filter(t => t.kind === 'Expense').reduce((s, t) => s + t.amount, 0);
      const received = txns.filter(t => t.kind === 'Income').reduce((s, t) => s + t.amount, 0);
      document.getElementById('tx-summary').textContent =
        `${txns.length} ${txns.length === 1 ? 'entry' : 'entries'} · spent ${money(spent)} · received ${money(received)}`;
      list.innerHTML = txListHtml(txns, true);
    } catch (err) {
      list.innerHTML = `<div class="empty">😿 ${esc(err.message)}</div>`;
    }
  }

  /* ======================= page: import ======================= */

  const importState = { headers: [], table: [], mapping: {}, preview: null, result: null };

  /* --- reading a CSV or a block pasted from Excel --- */

  function detectDelimiter(text) {
    const line = text.split(/\r?\n/).find(l => l.trim()) || '';
    const counts = { ',': 0, '\t': 0, ';': 0, '|': 0 };
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (!inQuotes && counts[ch] !== undefined) counts[ch]++;
    }
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  }

  function parseDelimited(text, delimiter) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    const pushField = () => { row.push(field.trim()); field = ''; };
    const pushRow = () => { if (row.some(c => c !== '')) rows.push(row); row = []; };

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') inQuotes = false;
        else field += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === delimiter) pushField();
      else if (ch === '\n') { pushField(); pushRow(); }
      else if (ch !== '\r') field += ch;
    }
    pushField();
    pushRow();
    return rows;
  }

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  /** Turns a bank's date into YYYY-MM-DD. order is 'dmy', 'mdy' or 'ymd'. */
  function parseFlexibleDate(value, order) {
    const text = String(value || '').trim();
    if (!text) return '';
    let m = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
    m = text.match(/^(\d{1,2})[-/.\s](\d{1,2})[-/.\s](\d{2,4})/);
    if (m) {
      let a = +m[1], b = +m[2];
      const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      let day = a, month = b;
      if (order === 'mdy') { day = b; month = a; }
      if (order === 'auto' && a <= 12 && b > 12) { day = b; month = a; }
      if (month > 12) { const t = day; day = month; month = t; }
      return `${year}-${pad(month)}-${pad(day)}`;
    }
    m = text.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{2,4})/);
    if (m) {
      const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
      const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      if (month) return `${year}-${pad(month)}-${pad(+m[1])}`;
    }
    m = text.match(/^([A-Za-z]{3,})[-\s](\d{1,2})[,\s]+(\d{2,4})/);
    if (m) {
      const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
      const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      if (month) return `${year}-${pad(month)}-${pad(+m[2])}`;
    }
    const d = new Date(text);
    return isNaN(d.getTime()) ? '' : ymd(d);
  }

  /** Turns "1,234.50", "(45.00)" or "45.00 DR" into a signed number. */
  function parseAmount(value) {
    let text = String(value == null ? '' : value).trim();
    if (!text) return null;
    let sign = 1;
    if (/^\(.*\)$/.test(text)) { sign = -1; text = text.slice(1, -1); }
    if (/\bdr\b|\bdebit\b/i.test(text)) sign = -1;
    if (/\bcr\b|\bcredit\b/i.test(text)) sign = 1;
    if (text.trim().startsWith('-')) sign = -1;
    const n = parseFloat(text.replace(/[^0-9.]/g, ''));
    return isFinite(n) ? sign * Math.abs(n) : null;
  }

  function guessColumn(headers, patterns) {
    for (const pattern of patterns) {
      const i = headers.findIndex(h => pattern.test(h));
      if (i !== -1) return String(i);
    }
    return '';
  }

  function autoMap(headers, table) {
    const map = {
      date: guessColumn(headers, [/transaction\s*date/i, /posting\s*date/i, /value\s*date/i, /^date/i, /date/i]),
      out: guessColumn(headers, [/withdraw/i, /debit\s*amount/i, /money\s*out/i, /paid\s*out/i, /^debit/i]),
      in: guessColumn(headers, [/deposit/i, /credit\s*amount/i, /money\s*in/i, /paid\s*in/i, /^credit/i]),
      amount: guessColumn(headers, [/^amount/i, /transaction\s*amount/i, /amount/i]),
      dateOrder: 'dmy',
      flip: false
    };

    // The description is whichever spare column holds the most actual words
    // (bank files often have both a short code column and the merchant name).
    const used = [map.date, map.out, map.in, map.amount].filter(v => v !== '').map(Number);
    const namePattern = /description|particular|narrative|detail|remark|merchant|payee|ref/i;
    let best = { index: '', score: -1 };
    headers.forEach((header, i) => {
      if (used.indexOf(i) !== -1) return;
      const values = (table || []).slice(0, 25).map(r => String(r[i] || '').trim()).filter(v => v);
      if (!values.length) return;
      const wordy = values.filter(v => /[a-z]{3,}/i.test(v)).length / values.length;
      const avgLength = values.reduce((sum, v) => sum + v.length, 0) / values.length;
      const score = avgLength * wordy + (namePattern.test(header) ? 8 : 0);
      if (score > best.score) best = { index: String(i), score: score };
    });
    map.description = best.index !== '' ? best.index
      : guessColumn(headers, [/description/i, /particular/i, /narrative/i, /detail/i, /reference/i, /remark/i, /merchant/i, /payee/i]);
    return map;
  }

  function readTable(text) {
    const delimiter = detectDelimiter(text);
    const rows = parseDelimited(text, delimiter).filter(r => r.length > 1);
    if (!rows.length) throw new Error("I couldn't find any rows in that.");
    // The header row is the first one that has no parsable amount in it.
    let headerIndex = 0;
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const numbers = rows[i].filter(c => parseAmount(c) !== null && /\d/.test(c)).length;
      if (numbers === 0 && rows[i].filter(c => c).length >= 2) { headerIndex = i; break; }
    }
    importState.headers = rows[headerIndex].map((h, i) => h || `Column ${i + 1}`);
    importState.table = rows.slice(headerIndex + 1).filter(r => r.some(c => c !== ''));
    importState.mapping = autoMap(importState.headers, importState.table);
    importState.preview = null;
    importState.result = null;
  }

  function mappedRows() {
    const m = importState.mapping;
    const cell = (row, key) => (m[key] === '' || m[key] == null ? '' : (row[Number(m[key])] || ''));
    return importState.table.map(row => {
      let amount = null;
      if (m.out !== '' || m.in !== '') {
        const out = parseAmount(cell(row, 'out'));
        const income = parseAmount(cell(row, 'in'));
        if (out) amount = -Math.abs(out);
        else if (income) amount = Math.abs(income);
      }
      if (amount === null) amount = parseAmount(cell(row, 'amount'));
      if (amount === null) amount = 0;
      if (m.flip) amount = -amount;
      return {
        date: parseFlexibleDate(cell(row, 'date'), m.dateOrder),
        description: String(cell(row, 'description') || '').replace(/\s+/g, ' ').trim(),
        amount: amount
      };
    }).filter(r => r.date || r.amount);
  }

  /* --- the page --- */

  function renderImport() {
    const accounts = state.boot.accounts.filter(a => a.is_active !== false);
    view.innerHTML = `
      <div class="page-head fade-in">
        <div><h1>Import 📥</h1><p>Bring in a bank or card statement. Nothing is saved until you check the preview.</p></div>
      </div>

      <div class="steps fade-in">
        <section class="card">
          <h2><span class="step-num">1</span>Which account?</h2>
          <div class="row2">
            <div class="field"><label for="i-account">Statement account</label>
              <select class="input" id="i-account">${accounts.map(a =>
                `<option value="${esc(a.name)}">${esc(a.icon || '')} ${esc(a.name)}</option>`).join('')}</select></div>
            <div class="field"><label for="i-type">Statement type</label>
              <select class="input" id="i-type">
                <option value="bank">Bank account (minus = money out)</option>
                <option value="card">Credit card (plus = a charge)</option>
              </select></div>
          </div>
        </section>

        <section class="card">
          <h2><span class="step-num">2</span>Your rows</h2>
          <div class="dropzone" id="i-drop">
            <strong>Drop a CSV here, or click to choose a file</strong>
            <span>Exported from your bank. Excel files: open in Google Sheets → File → Download → CSV</span>
          </div>
          <input type="file" id="i-file" accept=".csv,.txt,text/csv" hidden>
          <div class="field"><label for="i-paste">…or paste rows copied from Excel</label>
            <textarea class="input" id="i-paste" placeholder="Date	Description	Amount
01/10/2026	STARBUCKS	-6.50"></textarea></div>
          <div class="actions"><button class="btn" type="button" id="i-read">Read rows</button></div>
        </section>

        <section class="card" id="i-map-card" hidden>
          <h2><span class="step-num">3</span>Check the columns</h2>
          <div class="map-grid" id="i-map"></div>
          <p class="muted" id="i-sample" style="margin-top:14px"></p>
          <div class="actions" style="margin-top:14px"><button class="btn" type="button" id="i-preview">Preview rows</button></div>
        </section>

        <section class="card" id="i-review-card" hidden>
          <h2><span class="step-num">4</span>Review and import</h2>
          <div id="i-review"></div>
        </section>

        <section class="card" id="i-result-card" hidden>
          <h2>Result</h2>
          <div id="i-result"></div>
        </section>
      </div>`;

    const $ = id => document.getElementById(id);

    const defaultType = () => {
      const account = findByName(state.boot.accounts, $('i-account').value);
      $('i-type').value = account && account['class'] === 'Liability' ? 'card' : 'bank';
    };
    defaultType();
    $('i-account').addEventListener('change', defaultType);

    $('i-drop').addEventListener('click', () => $('i-file').click());
    $('i-drop').addEventListener('dragover', e => { e.preventDefault(); $('i-drop').classList.add('over'); });
    $('i-drop').addEventListener('dragleave', () => $('i-drop').classList.remove('over'));
    $('i-drop').addEventListener('drop', e => {
      e.preventDefault();
      $('i-drop').classList.remove('over');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) loadFile(file);
    });
    $('i-file').addEventListener('change', e => { if (e.target.files[0]) loadFile(e.target.files[0]); });

    function loadFile(file) {
      const reader = new FileReader();
      reader.onload = () => {
        $('i-paste').value = String(reader.result || '').slice(0, 400000);
        toast(`Read ${esc(file.name)} 🌸`);
        readAndShowMapping();
      };
      reader.onerror = () => toast("😿 I couldn't read that file.");
      reader.readAsText(file);
    }

    $('i-read').addEventListener('click', readAndShowMapping);

    function readAndShowMapping() {
      try {
        const text = $('i-paste').value.trim();
        if (!text) { toast('Paste some rows or choose a file first 🌷'); return; }
        readTable(text);
        renderMapping();
        $('i-map-card').hidden = false;
        $('i-review-card').hidden = true;
        $('i-result-card').hidden = true;
        $('i-map-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (err) {
        toast('😿 ' + err.message);
      }
    }

    function renderMapping() {
      const m = importState.mapping;
      const options = (selected, allowBlank) =>
        (allowBlank ? '<option value="">— none —</option>' : '') +
        importState.headers.map((h, i) => `<option value="${i}" ${String(i) === String(selected) ? 'selected' : ''}>${esc(h)}</option>`).join('');

      $('i-map').innerHTML = `
        <div class="field"><label for="m-date">Date column</label><select class="input" id="m-date" data-map="date">${options(m.date, false)}</select></div>
        <div class="field"><label for="m-desc">Description column</label><select class="input" id="m-desc" data-map="description">${options(m.description, false)}</select></div>
        <div class="field"><label for="m-amount">Amount column</label><select class="input" id="m-amount" data-map="amount">${options(m.amount, true)}</select></div>
        <div class="field"><label for="m-out">Money out column</label><select class="input" id="m-out" data-map="out">${options(m.out, true)}</select></div>
        <div class="field"><label for="m-in">Money in column</label><select class="input" id="m-in" data-map="in">${options(m.in, true)}</select></div>
        <div class="field"><label for="m-order">Date format</label>
          <select class="input" id="m-order" data-map="dateOrder">
            <option value="dmy" ${m.dateOrder === 'dmy' ? 'selected' : ''}>Day first (31/12/2026)</option>
            <option value="mdy" ${m.dateOrder === 'mdy' ? 'selected' : ''}>Month first (12/31/2026)</option>
            <option value="ymd" ${m.dateOrder === 'ymd' ? 'selected' : ''}>Year first (2026-12-31)</option>
          </select></div>
        <div class="field"><label for="m-flip">Signs</label>
          <select class="input" id="m-flip" data-map="flip">
            <option value="no" ${m.flip ? '' : 'selected'}>As in the file</option>
            <option value="yes" ${m.flip ? 'selected' : ''}>Flip them (+ and − are swapped)</option>
          </select></div>`;

      $('i-map').querySelectorAll('[data-map]').forEach(el => el.addEventListener('change', () => {
        const key = el.dataset.map;
        importState.mapping[key] = key === 'flip' ? el.value === 'yes' : el.value;
        showSample();
      }));
      showSample();
    }

    function showSample() {
      const rows = mappedRows();
      const first = rows[0];
      $('i-sample').innerHTML = !first
        ? '⚠️ I could not read any rows with these columns. Try different ones.'
        : `${rows.length} row(s) found. First one reads as: <b>${esc(first.date || '❓ no date')}</b> · ${esc(first.description || '❓ no description')} · <b>${esc(money(first.amount))}</b> ${first.amount < 0 ? '(money out)' : '(money in)'}`;
    }

    $('i-preview').addEventListener('click', async () => {
      const rows = mappedRows();
      if (!rows.length) { toast('No rows to preview 🌷'); return; }
      const btn = $('i-preview');
      btn.disabled = true; btn.textContent = 'Checking…';
      try {
        importState.preview = await api('importPreview', {
          rows: rows.slice(0, 500),
          account: $('i-account').value,
          statement_type: $('i-type').value
        });
        renderReview();
        $('i-review-card').hidden = false;
        $('i-review-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (err) {
        toast('😿 ' + err.message);
      } finally {
        btn.disabled = false; btn.textContent = 'Preview rows';
      }
    });

    function renderReview() {
      const preview = importState.preview;
      const accounts = state.boot.accounts.filter(a => a.is_active !== false);
      const categories = state.boot.categories.filter(c => c.is_active !== false && c.kind);
      const accountOptions = (selected, blank) => (blank ? '<option value="">—</option>' : '') +
        accounts.map(a => `<option ${a.name === selected ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
      const categoryOptions = selected => '<option value="">— pick —</option>' +
        ['Expense', 'Income', 'Transfer'].map(kind => {
          const list = categories.filter(c => c.kind === kind);
          return !list.length ? '' : `<optgroup label="${kind}">` + list.map(c =>
            `<option ${c.name === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('') + '</optgroup>';
        }).join('');

      document.getElementById('i-review').innerHTML = `
        <div class="summary-row">
          <div><span class="muted">Rows</span><b>${preview.summary.total}</b></div>
          <div><span class="muted">Ready</span><b class="pos">${preview.summary.ready}</b></div>
          <div><span class="muted">Need a look</span><b>${preview.summary.needs_review}</b></div>
          <div><span class="muted">Duplicates</span><b>${preview.summary.duplicates}</b></div>
        </div>
        <div class="table-wrap">
          <table class="rows">
            <thead><tr>
              <th><input type="checkbox" id="i-all" title="Select all"></th>
              <th>Date</th><th>Description</th><th>Amount</th><th>Type</th><th>Category</th><th>Account</th><th>To</th><th></th>
            </tr></thead>
            <tbody>${preview.rows.map(r => `
              <tr data-line="${r.line}" class="${r.include ? '' : 'skip'} ${r.needs_review || r.duplicate ? 'flag' : ''}">
                <td><input type="checkbox" data-field="include" ${r.include ? 'checked' : ''}></td>
                <td><input class="input" style="width:120px" data-field="date" value="${esc(r.date)}"></td>
                <td class="desc" title="${esc(r.description)}">${esc(r.description)}</td>
                <td class="num">${esc(money(r.amount))}</td>
                <td><span class="pill ${esc(String(r.kind).toLowerCase())}">${esc(r.kind)}</span></td>
                <td><select class="input" data-field="category">${categoryOptions(r.category)}</select></td>
                <td><select class="input" data-field="account">${accountOptions(r.account, true)}</select></td>
                <td>${r.kind === 'Transfer' ? `<select class="input" data-field="to_account">${accountOptions(r.to_account, true)}</select>` : ''}</td>
                <td>${r.duplicate ? '<span class="note">duplicate</span>' : r.notes.length ? `<span class="note">${esc(r.notes.join(', '))}</span>` : '✅'}</td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
        <div class="actions" style="margin-top:16px">
          <button class="btn" type="button" id="i-commit">Import selected rows</button>
          <button class="btn ghost" type="button" id="i-cancel">Cancel</button>
        </div>`;

      const table = document.querySelector('#i-review table.rows');
      table.addEventListener('change', e => {
        const field = e.target.dataset.field;
        if (!field) return;
        const tr = e.target.closest('tr');
        const row = preview.rows.find(r => String(r.line) === tr.dataset.line);
        if (!row) return;
        row[field] = field === 'include' ? e.target.checked : e.target.value;
        if (field !== 'include') { row.include = true; tr.querySelector('[data-field="include"]').checked = true; }
        tr.classList.toggle('skip', !row.include);
      });
      document.getElementById('i-all').addEventListener('change', e => {
        preview.rows.forEach(r => { r.include = e.target.checked; });
        table.querySelectorAll('[data-field="include"]').forEach(box => { box.checked = e.target.checked; });
        table.querySelectorAll('tbody tr').forEach(tr => tr.classList.toggle('skip', !e.target.checked));
      });
      document.getElementById('i-cancel').addEventListener('click', () => { document.getElementById('i-review-card').hidden = true; });
      document.getElementById('i-commit').addEventListener('click', commit);
    }

    async function commit() {
      const preview = importState.preview;
      const chosen = preview.rows.filter(r => r.include).length;
      if (!chosen) { toast('Tick at least one row 🌷'); return; }
      if (!window.confirm(`Import ${chosen} transaction(s) into your Sheet?`)) return;

      const btn = document.getElementById('i-commit');
      btn.disabled = true; btn.textContent = 'Importing…';
      try {
        const result = await api('importCommit', { batch_id: preview.batch_id, rows: preview.rows });
        importState.result = result;
        document.getElementById('i-result').innerHTML = `
          <p>✅ Imported <b>${result.imported}</b> transaction(s).</p>
          ${result.skipped.length ? `<p class="muted">Skipped ${result.skipped.length}:</p><ul class="muted">${
            result.skipped.slice(0, 20).map(s => `<li>Row ${esc(s.line)} — ${esc(s.reason)}</li>`).join('')}</ul>` : ''}
          <div class="actions" style="margin-top:12px">
            <button class="btn ghost" type="button" id="i-undo">↩️ Undo this import</button>
            <a class="btn" href="#/dashboard">See the dashboard</a>
          </div>`;
        document.getElementById('i-result-card').hidden = false;
        document.getElementById('i-review-card').hidden = true;
        document.getElementById('i-result-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
        document.getElementById('i-undo').addEventListener('click', async () => {
          if (!window.confirm('Undo this whole import? Every row from it is marked void.')) return;
          try {
            const undone = await api('undoImportBatch', { batch_id: result.batch_id });
            toast(`↩️ Undone — ${undone.voided} row(s) voided.`);
            document.getElementById('i-result-card').hidden = true;
          } catch (err) { toast('😿 ' + err.message); }
        });
        toast(`Imported ${result.imported} 🌸`);
      } catch (err) {
        toast('😿 ' + err.message);
      } finally {
        btn.disabled = false; btn.textContent = 'Import selected rows';
      }
    }
  }

  /* ======================= page: settings ======================= */

  function renderSettings() {
    const t = Theme.current();
    const accounts = state.boot.accounts.filter(a => a.is_active !== false);
    const categories = state.boot.categories.filter(c => c.is_active !== false);

    view.innerHTML = `
      <div class="page-head fade-in"><div><h1>Style & settings 🎀</h1><p>Make it yours. Changes apply instantly and are remembered on this device.</p></div></div>

      <div class="grid fade-in">
        <section class="card span-12">
          <h2>Theme</h2>
          <div class="swatches">${Object.keys(THEMES).map(key => {
            const th = THEMES[key];
            return `<button type="button" class="swatch ${key === t.preset ? 'on' : ''}" data-preset="${key}">
              <div class="sample" style="background:linear-gradient(135deg, ${th.vars['--primary']}, ${th.vars['--accent']})"></div>
              <strong>${esc(th.name)}</strong><small>${th.dark ? 'Dark' : 'Light'}</small>
            </button>`;
          }).join('')}</div>
        </section>

        <section class="card span-12">
          <h2>Fine-tune</h2>
          <div class="pickers">
            <label class="field"><span class="label">Main colour</span><input type="color" id="c-primary" value="${esc(t.primary)}"></label>
            <label class="field"><span class="label">Accent colour</span><input type="color" id="c-accent" value="${esc(t.accent)}"></label>
            <label class="field"><span class="label">Background</span><input type="color" id="c-bg" value="${esc(t.bg)}"></label>
            <label class="field"><span class="label">Corner roundness</span><input type="range" id="c-radius" min="4" max="28" value="${t.radius}"></label>
            <label class="field"><span class="label">Heading style</span>
              <select class="input" id="c-font">
                <option value="serif" ${t.font === 'serif' ? 'selected' : ''}>Elegant serif</option>
                <option value="rounded" ${t.font === 'rounded' ? 'selected' : ''}>Soft rounded</option>
                <option value="sans" ${t.font === 'sans' ? 'selected' : ''}>Clean sans</option>
              </select>
            </label>
          </div>
          <div class="actions" style="margin-top:18px"><button type="button" class="btn ghost" id="c-reset">Reset to ${esc(THEMES[t.preset].name)}</button></div>
        </section>

        <section class="card span-6">
          <h2>Accounts</h2>
          ${accounts.map(a => `<div class="acct"><div class="ico-box" style="background:${tint(a.color)}">${esc(a.icon || '•')}</div>
            <div class="meta"><strong>${esc(a.name)}</strong><small>${esc(a.type)} · ${esc(a.class)}</small></div></div>`).join('') || '<div class="empty">No accounts yet.</div>'}
        </section>

        <section class="card span-6">
          <h2>Categories</h2>
          ${['Expense', 'Income', 'Transfer'].map(kind => {
            const list = categories.filter(c => c.kind === kind);
            return !list.length ? '' : `<div class="eyebrow group-title">${kind}</div><div>${list.map(c => `<span class="tag">${esc(c.icon || '')} ${esc(c.name)}</span>`).join('')}</div>`;
          }).join('')}
        </section>

        <section class="card span-12">
          <h2>Connection</h2>
          <p>${isDemo()
            ? '✨ <b>Demo mode.</b> You are seeing sample data. Nothing you enter here is saved. Step 6 connects your real Google Sheet behind a secure login.'
            : '🔒 <b>Connected</b> to your Apps Script backend.'}</p>
          <p class="muted">To add or rename accounts, categories and budgets, edit the tabs in your Google Sheet. Changes show up here and in the Telegram bot automatically.</p>
          ${isDemo() ? '' : '<div class="actions" style="margin-top:14px"><button type="button" class="btn ghost" id="sign-out">Sign out</button></div>'}
        </section>
      </div>`;

    const $ = id => document.getElementById(id);
    const update = patch => Theme.save(Object.assign(Theme.current(), patch));

    document.querySelectorAll('[data-preset]').forEach(btn => btn.addEventListener('click', () => {
      const cur = Theme.current();
      Theme.save(Object.assign(Theme.defaults(btn.dataset.preset), { radius: cur.radius, font: cur.font }));
      renderSettings();
    }));
    $('c-primary').addEventListener('input', e => update({ primary: e.target.value }));
    $('c-accent').addEventListener('input', e => update({ accent: e.target.value }));
    $('c-bg').addEventListener('input', e => update({ bg: e.target.value }));
    $('c-radius').addEventListener('input', e => update({ radius: Number(e.target.value) }));
    $('c-font').addEventListener('change', e => update({ font: e.target.value }));
    const signOutBtn = $('sign-out');
    if (signOutBtn) signOutBtn.addEventListener('click', signOut);
    $('c-reset').addEventListener('click', () => {
      Theme.save(Theme.defaults(Theme.current().preset));
      renderSettings();
      toast('Back to the original look 🌸');
    });
  }

  /* ======================= router ======================= */

  const ROUTES = { dashboard: renderDashboard, add: renderAdd, transactions: renderTransactions, import: renderImport, settings: renderSettings };

  function showError(err) {
    view.innerHTML = `<div class="card empty">😿 ${esc(err && err.message ? err.message : err)}</div>`;
  }

  async function router() {
    const name = location.hash.replace(/^#\/?/, '').split('?')[0];
    const route = ROUTES[name] ? name : 'dashboard';
    document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.dataset.route === route));
    view.innerHTML = '<div class="loading">Loading… 🌸</div>';
    try {
      await ensureBoot();
      await ROUTES[route]();
      window.scrollTo(0, 0);
    } catch (err) {
      showError(err);
    }
  }

  /* ======================= login ======================= */

  let loginTicket = null;
  let googleButtonReady = false;

  function showLogin(message) {
    state.boot = null;
    document.querySelector('.app').hidden = true;
    document.getElementById('login').hidden = false;
    loginStep('google');
    loginError(message || '');
    initGoogleButton();
  }

  function loginStep(step) {
    document.getElementById('login-step-google').hidden = step !== 'google';
    document.getElementById('login-step-code').hidden = step !== 'code';
    if (step === 'code') setTimeout(() => document.getElementById('login-code').focus(), 60);
  }

  function loginError(message) {
    const el = document.getElementById('login-error');
    el.textContent = message || '';
    el.hidden = !message;
  }

  function initGoogleButton() {
    if (googleButtonReady) return;
    const gsi = window.google && window.google.accounts && window.google.accounts.id;
    if (!gsi) { setTimeout(initGoogleButton, 300); return; } // Google's script is still loading
    gsi.initialize({
      client_id: CONFIG.GOOGLE_CLIENT_ID,
      callback: onGoogleSignIn,
      auto_select: false,
      cancel_on_tap_outside: true
    });
    gsi.renderButton(document.getElementById('google-btn'), { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with', width: 260 });
    googleButtonReady = true;
  }

  async function onGoogleSignIn(response) {
    loginError('');
    try {
      const data = await authCall('auth.google', { idToken: response.credential });
      loginTicket = data.ticket;
      document.getElementById('login-hello').textContent = data.name ? `Hi ${data.name}! One more step 🌸` : 'One more step 🌸';
      loginStep('code');
    } catch (err) {
      loginError(err.message);
    }
  }

  async function submitCode() {
    const input = document.getElementById('login-code');
    const btn = document.getElementById('login-verify');
    const code = input.value.trim();
    if (!code) { input.focus(); return; }
    btn.disabled = true;
    btn.textContent = 'Checking…';
    loginError('');
    try {
      const data = await authCall('auth.code', { ticket: loginTicket, code: code });
      setToken(data.sessionToken);
      input.value = '';
      loginTicket = null;
      document.getElementById('login').hidden = true;
      document.querySelector('.app').hidden = false;
      router();
    } catch (err) {
      loginError(err.message);
      input.select();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Unlock 🔓';
    }
  }

  async function signOut() {
    try { await post({ action: 'auth.logout', sessionToken: sessionToken() }); } catch (e) { /* sign out locally anyway */ }
    setToken('');
    showLogin('Signed out. See you soon 🌸');
  }

  /* ======================= start ======================= */

  Theme.apply(Theme.current());
  document.getElementById('demo-banner').hidden = !isDemo();
  window.addEventListener('hashchange', router);
  document.getElementById('login-verify').addEventListener('click', submitCode);
  document.getElementById('login-back').addEventListener('click', () => { loginTicket = null; loginStep('google'); loginError(''); });
  document.getElementById('login-code').addEventListener('keydown', e => { if (e.key === 'Enter') submitCode(); });

  if (isDemo() || sessionToken()) router();
  else showLogin('');
})();
