/**
 * Extrato IA — Main Application Logic
 *
 * From the member's REAL bank statement (.OFX / .CSV / .XLSX exported from
 * Nubank, Inter, Itaú, Bradesco, BB, Santander, Caixa, C6, Mercado Pago,
 * PagBank… one or several accounts/cards) to a categorized ledger, a
 * management P&L (DRE gerencial), cash flow, subscriptions and a spreadsheet
 * ready for the accountant.
 *
 * Everything that is a number is computed HERE: parsing, dates and BR money,
 * duplicates between overlapping files, transfers between the member's own
 * accounts, the DRE, margins, cash flow, recurrences and month comparison.
 * The model (BYOK, OpenRouter — Hard Rules #1/#19) is used only for language:
 * (1) suggest a category for each NEW description (digits masked — no account
 * numbers, CPF/CNPJ or balances leave the browser), (2) write the month's
 * analysis from the computed aggregates. Every category the AI or the member
 * sets becomes a local RULE, so next month the known descriptions are
 * categorized with no AI call at all.
 * The only backend is the shared n8n gate/webhooks. No Supabase in the browser.
 */
const App = (function () {
  'use strict';

  // ── slot names (COR-025: never `*KEY = '<hyphenated literal>'`) ──
  var LIST_SLOT = 'extrato_meses';
  var CURRENT_SLOT = 'extrato_atual';
  var RULES_SLOT = 'extrato_regras';

  var MAX_ROWS = 8000;
  var MAX_TX = 8000;
  var MAX_COLS = 60;
  var MAX_CELL = 300;
  var MAX_MONTHS = 12;
  var MAX_ACCOUNTS = 8;
  var AI_CHUNK = 70;
  var PAGE = 120;

  // ── chart of accounts ──
  // g: DRE group. scope: pj (empresa) | pf (pessoal) | x (fora do resultado)
  var CATS = [
    { id: 'rec_vendas', label: 'Receita de vendas e serviços', g: 'REC', scope: 'pj', dir: 'in' },
    { id: 'rec_outras', label: 'Outras receitas (rendimentos, reembolsos)', g: 'OREC', scope: 'pj', dir: 'in' },
    { id: 'imp', label: 'Impostos (DAS, ISS, DARF)', g: 'IMP', scope: 'pj', dir: 'out' },
    { id: 'custo', label: 'Custos diretos (fornecedores, produção, taxas de venda)', g: 'CUS', scope: 'pj', dir: 'out' },
    { id: 'mkt', label: 'Marketing e anúncios', g: 'DESP', scope: 'pj', dir: 'out' },
    { id: 'soft', label: 'Ferramentas e assinaturas de software', g: 'DESP', scope: 'pj', dir: 'out' },
    { id: 'equipe', label: 'Equipe e prestadores (freelas, contador)', g: 'DESP', scope: 'pj', dir: 'out' },
    { id: 'estrutura', label: 'Estrutura (aluguel, energia, internet, telefone)', g: 'DESP', scope: 'pj', dir: 'out' },
    { id: 'tarifas', label: 'Tarifas bancárias, IOF e juros', g: 'DESP', scope: 'pj', dir: 'out' },
    { id: 'transp', label: 'Transporte e viagens a trabalho', g: 'DESP', scope: 'pj', dir: 'out' },
    { id: 'alim', label: 'Alimentação a trabalho', g: 'DESP', scope: 'pj', dir: 'out' },
    { id: 'outras_desp', label: 'Outras despesas da empresa', g: 'DESP', scope: 'pj', dir: 'out' },
    { id: 'prolabore', label: 'Pró-labore e retiradas dos sócios', g: 'RET', scope: 'pj', dir: 'out' },
    { id: 'pf_renda', label: 'Renda pessoal (salário, pró-labore recebido)', g: 'PFIN', scope: 'pf', dir: 'in' },
    { id: 'pf_moradia', label: 'Moradia (aluguel, condomínio, contas da casa)', g: 'PF', scope: 'pf', dir: 'out' },
    { id: 'pf_mercado', label: 'Mercado', g: 'PF', scope: 'pf', dir: 'out' },
    { id: 'pf_restaurante', label: 'Restaurantes e delivery', g: 'PF', scope: 'pf', dir: 'out' },
    { id: 'pf_transporte', label: 'Transporte pessoal (combustível, app)', g: 'PF', scope: 'pf', dir: 'out' },
    { id: 'pf_saude', label: 'Saúde, farmácia e academia', g: 'PF', scope: 'pf', dir: 'out' },
    { id: 'pf_educacao', label: 'Educação', g: 'PF', scope: 'pf', dir: 'out' },
    { id: 'pf_lazer', label: 'Lazer e assinaturas pessoais', g: 'PF', scope: 'pf', dir: 'out' },
    { id: 'pf_compras', label: 'Compras pessoais', g: 'PF', scope: 'pf', dir: 'out' },
    { id: 'pf_outros', label: 'Outros gastos pessoais', g: 'PF', scope: 'pf', dir: 'out' },
    { id: 'x_transf', label: 'Transferência entre contas próprias', g: 'X', scope: 'x', dir: 'both' },
    { id: 'x_invest', label: 'Aplicação ou resgate de investimento', g: 'X', scope: 'x', dir: 'both' },
    { id: 'x_fatura', label: 'Pagamento de fatura do cartão', g: 'X', scope: 'x', dir: 'both' },
    { id: 'x_emprest', label: 'Empréstimo (entrada ou parcela)', g: 'X', scope: 'x', dir: 'both' }
  ];
  var CAT = {}; CATS.forEach(function (c) { CAT[c.id] = c; });
  var SCOPE_LABEL = { pj: 'Empresa (PJ / MEI)', pf: 'Pessoal (PF)', x: 'Fora do resultado' };
  var SRC_LABEL = { voce: 'Você', ia: 'IA', regra: 'Regra', auto: 'Auto' };

  var BANKS = { 1: 'Banco do Brasil', 33: 'Santander', 77: 'Inter', 104: 'Caixa', 237: 'Bradesco', 260: 'Nubank', 290: 'PagBank', 323: 'Mercado Pago', 336: 'C6 Bank', 341: 'Itaú', 380: 'PicPay', 403: 'Cora', 197: 'Stone', 212: 'Banco Original', 422: 'Safra', 748: 'Sicredi', 756: 'Sicoob', 208: 'BTG Pactual', 655: 'Neon', 536: 'Neon', 623: 'Banco Pan', 218: 'BS2', 461: 'Asaas', 332: 'Acesso', 383: 'Juno', 280: 'Will Bank', 102: 'XP', 348: 'XP', 655.1: '' };

  var FIELDS = [
    { id: 'data', label: 'Data', req: true, note: 'dia do lançamento' },
    { id: 'descricao', label: 'Descrição / histórico', req: true, note: 'o texto do lançamento' },
    { id: 'complemento', label: 'Complemento da descrição', note: 'se o banco divide o texto em duas colunas' },
    { id: 'valor', label: 'Valor (com sinal)', note: 'negativo = saída' },
    { id: 'entrada', label: 'Coluna de entradas (crédito)', note: 'só se o banco separa entrada e saída' },
    { id: 'saida', label: 'Coluna de saídas (débito)', note: '' },
    { id: 'tipo', label: 'Tipo (C / D)', note: 'crédito ou débito, se existir' },
    { id: 'id', label: 'Identificador', note: 'para tirar duplicatas' }
  ];

  var SUBS_RE = /\b(netflix|spotify|adobe|canva|chatgpt|openai|anthropic|claude|google ?(workspace|one|cloud|storage)|gsuite|notion|zoom|capcut|hostinger|hostgator|locaweb|godaddy|registro\.br|amazon ?prime|prime ?video|disney|hbo|max\.com|globoplay|deezer|youtube ?premium|youtubepremium|apple\.com|icloud|microsoft|office ?365|dropbox|smart ?fit|gympass|wellhub|totalpass|midjourney|figma|slack|elevenlabs|heygen|manychat|rd ?station|activecampaign|mailchimp|hotmart ?club|kajabi|vimeo|shopify|nuvemshop|wix|squarespace|envato|freepik|semrush|ahrefs|linkedin ?premium|tinder|duolingo|audible|kindle|crunchyroll|paramount|starplus|telecine|uol|clicksign|docusign|omie|conta ?azul|bling|asana|trello|monday|clickup|calendly|cursor|github|vercel|netlify|cloudflare|n8n|make\.com|zapier|higgsfield|runway|suno|perplexity|grammarly)\b/;

  var SUB_CATS = { soft: 1, mkt: 1, pf_lazer: 1, pf_saude: 1, pf_educacao: 1, outras_desp: 1, pf_outros: 1 };
  var MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  var C = { ink: '#13201b', ink2: '#3f4f47', teal: '#0d5a4a', red: '#a3241b', green: '#1a6638', gold: '#8a6d24', paper: '#f4f7f2', tint: '#dfeae3', rule: '#b9cbc0', grid: '#d3e0d7' };

  var state = { per: null, raws: {}, wired: false, running: false, wiping: false, m: null, cmp: null, filter: 'todos', facc: '', fcat: '', q: '', shown: PAGE, ctl: null, mapAcc: '' };

  // ───────────────────────── utils ─────────────────────────
  function $(id) { return document.getElementById(id); }
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2800);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function clean(v) {
    var s = String(v == null ? '' : v).trim();
    return /^(null|undefined|n\/a|none|-)$/i.test(s) ? '' : s; // COR-015
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function fold(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function slug(s) { return fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'extrato'; }
  function plural(n, one, many) { return fmtInt(n) + ' ' + (n === 1 ? one : many); }
  function shortTxt(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); n = n || 60; return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; }
  function colLetter(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  var NF0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
  var NF1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var NF2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function fmtInt(n) { return NF0.format(Math.round(n || 0)); }
  function brl(v) { return (v < 0 ? '−' : '') + 'R$ ' + NF0.format(Math.abs(Math.round(v || 0))); }
  function brl2(v) { return (v < -0.004 ? '−' : '') + 'R$ ' + NF2.format(Math.abs(v || 0)); }
  function brlShort(v) { var a = Math.abs(v || 0), s = v < 0 ? '−' : ''; if (a >= 1e6) return s + 'R$ ' + NF1.format(a / 1e6) + ' mi'; if (a >= 1e4) return s + 'R$ ' + NF0.format(a / 1e3) + ' mil'; if (a >= 1e3) return s + 'R$ ' + NF1.format(a / 1e3) + ' mil'; return s + 'R$ ' + NF0.format(a); }
  function fmtPct(x) { return NF1.format(x || 0) + '%'; }
  function pad2(n) { return ('0' + n).slice(-2); }
  function dmy(t) { var d = new Date(t); return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear(); }
  function dm(t) { var d = new Date(t); return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1); }
  function dayKey(t) { var d = new Date(t); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }
  function hash(s) { var h = 2166136261; s = String(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
  function dateline() { var d = new Date(); return d.getDate() + ' de ' + MONTHS[d.getMonth()] + ' de ' + d.getFullYear(); }
  function r2(x) { return Math.round(x * 100) / 100; }
  // CSP forbids style="" attributes (COR-063): widths travel as data-w and are set through CSSOM.
  function fixW(root) { (root || document).querySelectorAll('[data-w]').forEach(function (el) { el.style.setProperty('--w', el.getAttribute('data-w') + '%'); }); }

  // ───────────────────────── storage ─────────────────────────
  function loadList() { try { return JSON.parse(localStorage.getItem(LIST_SLOT) || '[]'); } catch (e) { return []; } }
  var saveTimer = null;
  function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 300); }
  function saveNow() {
    clearTimeout(saveTimer);
    var p = state.per; if (!p || !p.tx || !p.tx.length) return;
    p.updatedAt = Date.now();
    var list = loadList().filter(function (x) { return x.id !== p.id; });
    list.unshift(p);
    list = list.slice(0, MAX_MONTHS);
    for (var keep = list.length; keep >= 1; keep--) {
      try {
        localStorage.setItem(LIST_SLOT, JSON.stringify(list.slice(0, keep)));
        localStorage.setItem(CURRENT_SLOT, p.id);
        if (keep < list.length) toast('Espaço do navegador cheio: guardei só os ' + keep + ' meses mais recentes.');
        return;
      } catch (e) { /* try with fewer months */ }
    }
    toast('Este mês é grande demais para salvar no navegador — baixe a planilha ao terminar.');
  }
  function getPeriod(id) { return loadList().filter(function (x) { return x.id === id; })[0] || null; }
  function newPeriod() {
    return { id: uid(), nome: '', negocio: '', modo: 'misto', createdAt: Date.now(), updatedAt: Date.now(), accounts: [], tx: [], report: null, compareId: '', dupes: 0 };
  }
  var rulesCache = null;
  function loadRules() {
    if (rulesCache) return rulesCache;
    try { rulesCache = JSON.parse(localStorage.getItem(RULES_SLOT) || '{}') || {}; } catch (e) { rulesCache = {}; }
    return rulesCache;
  }
  function saveRules() { try { localStorage.setItem(RULES_SLOT, JSON.stringify(loadRules())); } catch (e) { toast('Não consegui salvar as regras neste navegador.'); } }
  function setRule(k, c, src) {
    var R = loadRules();
    if (!c) { delete R[k]; return; }
    var prev = R[k];
    if (prev && prev.s === 'voce' && src === 'ia') return; // the member's choice always wins
    R[k] = { c: c, s: src, u: Date.now() };
  }

  // ───────────────────────── description → key ─────────────────────────
  // The same merchant/person must map to the same key every month, so the
  // key drops ids, document numbers, bank/branch data and dates.
  function descKey(desc) {
    var s = fold(desc);
    var head = s, parts = s.split(' - ');
    if (parts.length >= 2 && /pix|transfer|ted|doc\b|boleto|pagamento/.test(parts[0])) {
      var kind = /recebid|credit|entrada/.test(parts[0]) ? 'pix recebido' : (/boleto/.test(parts[0]) ? 'boleto' : 'pix enviado');
      head = kind + ' ' + parts[1];
    }
    head = head
      .replace(/(agencia|ag\.?|conta|cc|c\/c)\s*:?\s*[\d.\-x]+/g, ' ')
      .replace(/\(\d{3,4}\)/g, ' ')
      .replace(/[•*]+/g, ' ')
      .replace(/\b\d{2}\/\d{2}(\/\d{2,4})?\b/g, ' ')
      .replace(/\b\d{1,3}(\.\d{3})+(,\d{2})?\b/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/^(compra( no)? (debito|credito)|compra cartao|pagamento de boleto efetuado|pagto|pag\*|pg \*|ec \*)\s*-?\s*/g, '')
      .replace(/[^a-z0-9.&\s]/g, ' ');
    var toks = head.split(/\s+/).filter(function (w) { return w && !/\d/.test(w) && w.length > 1; });
    var k = toks.join(' ').slice(0, 52).trim();
    return k || shortTxt(fold(desc).replace(/\d+/g, '#'), 40);
  }
  function txKey(tx) { return (tx.v >= 0 ? 'in:' : 'out:') + tx.k; }
  function maskDigits(s) {
    return String(s || '').replace(/[•*]{2,}[\d.\-•*]*/g, '').replace(/\d[\d.\-\/]{3,}\d/g, '#').replace(/\b\d{4,}\b/g, '#').replace(/\s+/g, ' ').trim().slice(0, 90);
  }

  // ───────────────────────── file reading ─────────────────────────
  // Bank exports often start with a title block ("Extrato Conta Corrente") — look at the first lines, not just one.
  function detectDelim(text) {
    var c = { ',': 0, ';': 0, '\t': 0 };
    text.split('\n').slice(0, 20).forEach(function (line) {
      var q = false;
      for (var i = 0; i < line.length; i++) { var ch = line[i]; if (ch === '"') q = !q; else if (!q && c[ch] !== undefined) c[ch]++; }
    });
    if (c['\t'] >= c[','] && c['\t'] >= c[';'] && c['\t'] > 0) return '\t';
    return c[';'] > c[','] ? ';' : ',';
  }
  function parseCSV(text) {
    text = String(text).replace(/^﻿/, '');
    var d = detectDelim(text), rows = [], row = [], f = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += ch;
      } else if (ch === '"' && f === '') q = true;
      else if (ch === d) { row.push(f); f = ''; }
      else if (ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; if (rows.length > MAX_ROWS + 20) break; }
      else if (ch !== '\r') f += ch;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim(); }); });
  }
  function ensureXLSX() {
    if (window.XLSX) return Promise.resolve();
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = 'vendor/xlsx.js';
      s.onload = function () { window.XLSX ? res() : rej(new Error('xlsx')); };
      s.onerror = function () { rej(new Error('xlsx')); };
      document.head.appendChild(s);
    });
  }
  function rowsFromWorkbook(buf) {
    var wb = XLSX.read(buf, { type: 'array', cellDates: true });
    var best = null, bestN = -1;
    wb.SheetNames.forEach(function (n) {
      var rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '', dateNF: 'dd/mm/yyyy' });
      rows = rows.filter(function (r) { return r.some(function (c) { return String(c).trim(); }); });
      if (rows.length > bestN) { best = rows; bestN = rows.length; }
    });
    return best || [];
  }
  function findHeaderRow(rows) {
    var lim = Math.min(rows.length, 25), best = 0, bestScore = -1;
    for (var i = 0; i < lim; i++) {
      var r = rows[i], filled = r.filter(function (c) { return String(c).trim(); }).length;
      var hits = r.filter(function (c) { return /^(data|date)|descri|hist[oó]rico|lan[cç]amento|valor|amount|title|cr[eé]dito|d[eé]bito|saldo/i.test(String(c).trim()); }).length;
      var score = hits * 4 + filled;
      if (filled >= 2 && hits >= 2 && score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  // ───────────────────────── value parsing ─────────────────────────
  function parseMoney(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return NaN;
    var neg = /^\(.*\)$/.test(s) || /^-|^R?\$\s*-|-\s*R?\$|-$|\bD$/i.test(s);
    s = s.replace(/[^\d.,]/g, '');
    if (!s || !/\d/.test(s)) return NaN;
    var lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
    if (lc > -1 && ld > -1) {
      if (lc > ld) s = s.replace(/\./g, '').replace(',', '.'); else s = s.replace(/,/g, '');
    } else if (lc > -1) {
      if ((s.match(/,/g) || []).length > 1) s = s.replace(/,/g, ''); else s = s.replace(',', '.');
    } else if (ld > -1) {
      var parts = s.split('.');
      if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) s = s.replace(/\./g, '');
    }
    var n = parseFloat(s);
    if (isNaN(n)) return NaN;
    return neg ? -n : n;
  }
  function dateOrderOf(values) {
    var dmyHit = 0, mdyHit = 0;
    values.forEach(function (v) {
      var m = String(v).match(/^\s*(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
      if (!m) return;
      if (+m[1] > 12) dmyHit++;
      if (+m[2] > 12) mdyHit++;
    });
    return mdyHit > dmyHit ? 'mdy' : 'dmy';
  }
  function parseDate(v, order) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return null;
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) { var d1 = new Date(+m[1], +m[2] - 1, +m[3]); return isNaN(d1) ? null : d1.getTime(); }
    m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
    if (m) {
      var a = +m[1], b = +m[2], y = +m[3]; if (y < 100) y += 2000;
      var day = order === 'mdy' ? b : a, mon = order === 'mdy' ? a : b;
      if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
      var d2 = new Date(y, mon - 1, day);
      return isNaN(d2) ? null : d2.getTime();
    }
    m = s.match(/^(\d{8})/); // OFX-ish 20260930
    if (m) { var d3 = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)); return isNaN(d3) ? null : d3.getTime(); }
    if (/^\d{5}(\.\d+)?$/.test(s)) { // Excel serial date
      var du = new Date(Math.round((parseFloat(s) - 25569) * 86400000));
      return new Date(du.getUTCFullYear(), du.getUTCMonth(), du.getUTCDate()).getTime();
    }
    return null;
  }

  // ───────────────────────── OFX ─────────────────────────
  function ofxTag(block, tag) {
    var m = block.match(new RegExp('<' + tag + '>\\s*([^<\\r\\n]*)', 'i'));
    return m ? m[1].trim() : '';
  }
  function parseOFX(text) {
    if (!/<OFX>/i.test(text) || !/<STMTTRN>/i.test(text)) return null;
    var isCard = /<CCSTMTRS>|<CREDITCARDMSGSRSV1>/i.test(text);
    var bankId = parseInt(ofxTag(text, 'BANKID'), 10) || parseInt(ofxTag(text, 'FID'), 10) || 0;
    var org = ofxTag(text, 'ORG');
    var acct = ofxTag(text, 'ACCTID');
    var bal = parseMoney(ofxTag(text.split(/<LEDGERBAL>/i)[1] || '', 'BALAMT'));
    var balAt = parseDate(ofxTag(text.split(/<LEDGERBAL>/i)[1] || '', 'DTASOF'));
    var blocks = text.split(/<STMTTRN>/i).slice(1);
    var tx = [];
    blocks.forEach(function (b) {
      b = b.split(/<\/STMTTRN>|<\/BANKTRANLIST>/i)[0];
      var t = parseDate(ofxTag(b, 'DTPOSTED'));
      var v = parseMoney(ofxTag(b, 'TRNAMT').replace(/^\+/, ''));
      var name = ofxTag(b, 'NAME'), memo = ofxTag(b, 'MEMO');
      var desc = name && memo && fold(memo).indexOf(fold(name)) === -1 ? name + ' - ' + memo : (memo || name);
      if (t == null || isNaN(v) || !desc) return;
      if (/^-/.test(ofxTag(b, 'TRNAMT'))) v = -Math.abs(v);
      tx.push({ t: t, v: r2(v), d: desc.slice(0, MAX_CELL), fid: ofxTag(b, 'FITID') });
    });
    return {
      banco: BANKS[bankId] || clean(org).replace(/\s+S\.?A\.?$/i, '') || 'Banco',
      kind: isCard ? 'cartao' : 'conta',
      fp: acct ? hash(bankId + ':' + acct) : '',
      saldo: isNaN(bal) ? null : bal, saldoAt: balAt,
      tx: tx
    };
  }

  // ───────────────────────── CSV / XLSX mapping ─────────────────────────
  var SYN = {
    data: /^(data|date|dt)\b|data (do )?(lancamento|movimento|transacao|compra)|^dia$/,
    descricao: /descri|historico|^title$|^titulo$|lancamento|memo|estabelecimento|detalhe|^nome$|favorecido/,
    valor: /^(valor|amount|value|quantia|montante)( \(r\$\))?( r\$)?$|^valor/,
    entrada: /^(credito|entradas?|cr)( \(r\$\))?$|valor credito|creditos/,
    saida: /^(debito|saidas?|db)( \(r\$\))?$|valor debito|debitos/,
    tipo: /^tipo|^d\/c$|^c\/d$|natureza|^dc$/,
    id: /identificador|^id$|fitid|documento|^n(o|um|\.)? ?doc|autentica/
  };
  function colSample(raw, ci, n) {
    var out = [];
    for (var i = 0; i < raw.rows.length && out.length < n; i++) { var v = String(raw.rows[i][ci] || '').trim(); if (v) out.push(v); }
    return out;
  }
  function autoMap(raw) {
    var map = {}, used = {};
    var H = raw.headers.map(function (h) { return fold(h); });
    ['data', 'descricao', 'entrada', 'saida', 'valor', 'tipo', 'id'].forEach(function (f) {
      for (var i = 0; i < H.length; i++) {
        if (used[i] || /saldo/.test(H[i])) continue;
        if (SYN[f].test(H[i])) {
          if (f === 'descricao' && map.descricao != null) continue;
          map[f] = i; used[i] = 1; break;
        }
      }
    });
    // Inter style: "Histórico" (Pix recebido) + "Descrição" (de quem) — keep both, richer one first
    if (map.descricao != null) {
      H.forEach(function (h, i) {
        if (!used[i] && map.complemento == null && /descri|historico|complemento/.test(h)) {
          var a = colSample(raw, map.descricao, 20).join(' ').length, b = colSample(raw, i, 20).join(' ').length;
          if (b > a) { map.complemento = map.descricao; map.descricao = i; } else map.complemento = i;
          used[i] = 1;
        }
      });
    }
    if (map.valor != null && (map.entrada != null || map.saida != null)) { delete map.entrada; delete map.saida; }
    return map;
  }
  function detectCsvSource(headers, fileName) {
    var h = headers.map(fold).join('|'), f = fold(fileName);
    if (/^date\|title\|amount/.test(h)) return { banco: 'Nubank', kind: 'cartao', invert: true };
    if (/^data\|valor\|identificador\|descricao/.test(h)) return { banco: 'Nubank', kind: 'conta', invert: false };
    if (/data lancamento.*historico.*descricao.*valor/.test(h)) return { banco: 'Inter', kind: 'conta', invert: false };
    var banco = '';
    Object.keys(BANKS).some(function (k) { var b = fold(BANKS[k]); if (b && f.indexOf(b.split(' ')[0]) > -1) { banco = BANKS[k]; return true; } return false; });
    var card = /fatura|cartao|card|credito/.test(f);
    return { banco: banco || 'Planilha', kind: card ? 'cartao' : 'conta', invert: null };
  }
  function txFromRaw(raw, map, invert) {
    var order = map.data != null ? dateOrderOf(raw.rows.slice(0, 400).map(function (r) { return r[map.data]; })) : 'dmy';
    var out = [], skipped = { semData: 0, semValor: 0, saldo: 0 };
    raw.rows.forEach(function (r) {
      var desc = map.descricao != null ? clean(r[map.descricao]) : '';
      var extra = map.complemento != null ? clean(r[map.complemento]) : '';
      if (extra && fold(desc).indexOf(fold(extra)) === -1) desc = desc ? extra + ' - ' + desc : extra;
      if (/^(saldo|s a l d o)\b|saldo (anterior|do dia|final|inicial|disponivel)|^total\b/i.test(fold(desc))) { skipped.saldo++; return; }
      var t = map.data != null ? parseDate(r[map.data], order) : null;
      var v = NaN;
      if (map.valor != null) {
        v = parseMoney(r[map.valor]);
        if (!isNaN(v) && map.tipo != null) {
          var tp = fold(r[map.tipo]);
          if (/^d|debit|saida/.test(tp)) v = -Math.abs(v); else if (/^c|credit|entrada/.test(tp)) v = Math.abs(v);
        }
      } else if (map.entrada != null || map.saida != null) {
        var cr = map.entrada != null ? parseMoney(r[map.entrada]) : NaN, db = map.saida != null ? parseMoney(r[map.saida]) : NaN;
        if (!isNaN(cr) || !isNaN(db)) v = (isNaN(cr) ? 0 : Math.abs(cr)) - (isNaN(db) ? 0 : Math.abs(db));
      }
      if (t == null && !desc && isNaN(v)) return;
      if (t == null) { skipped.semData++; return; }
      if (isNaN(v) || v === 0) { skipped.semValor++; return; }
      if (invert) v = -v;
      out.push({ t: t, v: r2(v), d: (desc || '(sem descrição)').slice(0, MAX_CELL), fid: map.id != null ? clean(r[map.id]) : '' });
    });
    return { tx: out, skipped: skipped };
  }

  // ───────────────────────── categorization ─────────────────────────
  function autoCat(tx, acc) {
    var s = fold(tx.d), pf = acc && acc.titular === 'pf';
    if (/pagamento (de )?fatura|pagamento recebido|pgto fatura|pagto fatura|fatura (do )?cartao|pagamento cartao/.test(s)) return 'x_fatura';
    if (/aplicacao|resgate|\brdb\b|\bcdb\b|tesouro direto|poupanca|caixinha|investimento|\blci\b|\blca\b/.test(s)) return 'x_invest';
    if (/emprestimo|financiamento|credito pessoal|consignado/.test(s)) return 'x_emprest';
    if (tx.v < 0 && /\b(das|pgmei|simples nacional|darf|iss|issqn|gps|inss)\b/.test(s)) return pf ? 'pf_outros' : 'imp';
    if (tx.v < 0 && /\b(tarifa|iof|juros|encargos?|anuidade|cesta de servicos|mensalidade pacote)\b/.test(s)) return pf ? 'pf_outros' : 'tarifas';
    if (tx.v > 0 && /rendimento|rend\.? pago|remuneracao (da )?conta/.test(s)) return pf ? 'pf_renda' : 'rec_outras';
    return '';
  }
  // Transfers between the member's own accounts: opposite amounts, ±2 days, different 'conta' accounts.
  function markTransfers(p) {
    var contas = {}; p.accounts.forEach(function (a) { if (a.kind === 'conta') contas[a.id] = 1; });
    if (Object.keys(contas).length < 2) return 0;
    var outs = p.tx.filter(function (t) { return t.v < 0 && contas[t.a] && (!t.c || t.s === 'auto' || t.s === 'ia'); });
    var ins = p.tx.filter(function (t) { return t.v > 0 && contas[t.a] && (!t.c || t.s === 'auto' || t.s === 'ia'); });
    var used = {}, n = 0;
    outs.forEach(function (o) {
      for (var i = 0; i < ins.length; i++) {
        var x = ins[i];
        if (used[i] || x.a === o.a || Math.abs(x.v + o.v) > 0.005 || Math.abs(x.t - o.t) > 2.5 * 86400000) continue;
        used[i] = 1; o.c = 'x_transf'; o.s = 'auto'; x.c = 'x_transf'; x.s = 'auto'; n++; break;
      }
    });
    return n;
  }
  function applyRules(p, onlyEmpty) {
    var R = loadRules(), accs = {}; p.accounts.forEach(function (a) { accs[a.id] = a; });
    p.tx.forEach(function (t) {
      if (t.s === 'voce') return;
      if (onlyEmpty && t.c) return;
      var r = R[txKey(t)];
      if (r && CAT[r.c]) { t.c = r.c; t.s = r.s === 'voce' ? 'regra' : r.s === 'ia' ? 'ia' : 'regra'; return; }
      var a = autoCat(t, accs[t.a]);
      if (a) { t.c = a; t.s = 'auto'; }
    });
    markTransfers(p);
  }
  function setCategory(tx, cat, all) {
    var p = state.per, k = txKey(tx), n = 0;
    if (all) {
      p.tx.forEach(function (t) { if (txKey(t) === k) { t.c = cat; t.s = cat ? 'voce' : ''; n++; } });
      setRule(k, cat, 'voce'); saveRules();
    } else { tx.c = cat; tx.s = cat ? 'voce' : ''; n = 1; }
    p.report = null;
    return n;
  }

  // ───────────────────────── metrics ─────────────────────────
  function compute(p) {
    var m = { n: p.tx.length, start: Infinity, end: -Infinity, byCat: {}, semCat: 0, semCatV: 0, entradas: 0, saidas: 0, cashIn: 0, cashOut: 0 };
    CATS.forEach(function (c) { m.byCat[c.id] = { v: 0, n: 0 }; });
    var accs = {}; p.accounts.forEach(function (a) { accs[a.id] = a; });
    var daily = {}, keys = {}, pfInPj = { v: 0, n: 0 }, pjInPf = { v: 0, n: 0 }, faturaPaga = 0;
    p.tx.forEach(function (t) {
      if (t.t < m.start) m.start = t.t; if (t.t > m.end) m.end = t.t;
      var a = accs[t.a] || {}, c = CAT[t.c];
      if (t.v > 0) m.entradas += t.v; else m.saidas += -t.v;
      if (a.kind !== 'cartao') {
        var dk = dayKey(t.t), dd = daily[dk] || (daily[dk] = { t: t.t, i: 0, o: 0 });
        if (t.v > 0) { dd.i += t.v; m.cashIn += t.v; } else { dd.o += -t.v; m.cashOut += -t.v; }
      }
      if (!c) { m.semCat++; m.semCatV += Math.abs(t.v); return; }
      m.byCat[c.id].v += t.v; m.byCat[c.id].n++;
      if (c.id === 'x_fatura' && a.kind === 'conta' && t.v < 0) faturaPaga += -t.v;
      if (a.titular === 'pj' && c.scope === 'pf' && t.v < 0) { pfInPj.v += -t.v; pfInPj.n++; }
      if (a.titular === 'pf' && c.scope === 'pj' && t.v < 0 && c.g !== 'RET') { pjInPf.v += -t.v; pjInPf.n++; }
      if (t.v < 0 && c.scope !== 'x') {
        var kk = keys[t.k] || (keys[t.k] = { k: t.k, d: t.d, v: 0, n: 0, cat: c.id, sub: false });
        kk.v += -t.v; kk.n++; if (t.sub) kk.sub = true;
      }
    });
    if (!p.tx.length) { m.start = m.end = Date.now(); }
    function g(gr) { return CATS.filter(function (c) { return c.g === gr; }).reduce(function (s, c) { return s + m.byCat[c.id].v; }, 0); }
    var d = m.dre = {};
    d.receita = g('REC'); d.impostos = g('IMP'); d.liquida = d.receita + d.impostos;
    d.custos = g('CUS'); d.lucroBruto = d.liquida + d.custos;
    d.despesas = g('DESP'); d.operacional = d.lucroBruto + d.despesas;
    d.outras = g('OREC'); d.antesRet = d.operacional + d.outras;
    d.retiradas = g('RET'); d.resultado = d.antesRet + d.retiradas;
    d.margemBruta = d.receita > 0 ? d.lucroBruto * 100 / d.receita : null;
    d.margemOp = d.receita > 0 ? d.operacional * 100 / d.receita : null;
    d.margemLiq = d.receita > 0 ? d.antesRet * 100 / d.receita : null;
    d.despLines = CATS.filter(function (c) { return c.g === 'DESP' && m.byCat[c.id].n; }).map(function (c) { return { id: c.id, label: c.label, v: m.byCat[c.id].v, n: m.byCat[c.id].n }; }).sort(function (a, b) { return a.v - b.v; });
    m.temPJ = CATS.some(function (c) { return c.scope === 'pj' && m.byCat[c.id].n; });
    m.pf = { renda: g('PFIN'), gastos: g('PF'), lines: CATS.filter(function (c) { return c.g === 'PF' && m.byCat[c.id].n; }).map(function (c) { return { id: c.id, label: c.label, v: m.byCat[c.id].v, n: m.byCat[c.id].n }; }).sort(function (a, b) { return a.v - b.v; }) };
    m.temPF = m.pf.lines.length > 0 || m.byCat.pf_renda.n > 0;
    m.fora = CATS.filter(function (c) { return c.scope === 'x' && m.byCat[c.id].n; }).map(function (c) { return { id: c.id, label: c.label, v: m.byCat[c.id].v, n: m.byCat[c.id].n }; });
    // cash flow (contas only — card spend is paid through the bill)
    var dl = Object.keys(daily).map(function (k) { return daily[k]; }).sort(function (a, b) { return a.t - b.t; });
    var contas = p.accounts.filter(function (a) { return a.kind === 'conta'; });
    var allBal = contas.length && contas.every(function (a) { return a.saldo != null; });
    var endBal = allBal ? contas.reduce(function (s, a) { return s + a.saldo; }, 0) : null;
    var net = dl.reduce(function (s, x) { return s + x.i - x.o; }, 0);
    var run = allBal ? endBal - net : 0;
    dl.forEach(function (x) { run += x.i - x.o; x.bal = run; });
    m.cash = { days: dl, saldoReal: allBal, saldoInicial: allBal ? endBal - net : null, saldoFinal: allBal ? endBal : null, net: net, minDia: dl.reduce(function (b, x) { return !b || x.bal < b.bal ? x : b; }, null) };
    // destinations & subscriptions
    var kl = Object.keys(keys).map(function (k) { return keys[k]; }).sort(function (a, b) { return b.v - a.v; });
    m.destinos = kl.slice(0, 10);
    var other = {}; loadList().forEach(function (x) {
      if (x.id === p.id || !x.tx) return;
      var seen = {}; x.tx.forEach(function (t) { if (t.v < 0 && !seen[t.k]) { seen[t.k] = 1; (other[t.k] = other[t.k] || []).push(Math.abs(t.v)); } });
    });
    m.subs = kl.filter(function (x) {
      var hist = other[x.k] || [], perUnit = x.v / x.n;
      x.meses = 1 + hist.filter(function (v) { return Math.abs(v - perUnit) <= Math.max(3, perUnit * 0.15); }).length;
      // "Assinatura" = a service plan, not rent/bills/payroll (those recur but are fixed costs, not subscriptions to cut)
      return SUBS_RE.test(x.k) || ((x.sub || x.meses >= 2) && SUB_CATS[x.cat]);
    }).map(function (x) { return { k: x.k, d: x.d, mensal: x.v, n: x.n, meses: x.meses, cat: x.cat }; }).sort(function (a, b) { return b.mensal - a.mensal; }).slice(0, 30);
    m.subsTotal = m.subs.reduce(function (s, x) { return s + x.mensal; }, 0);
    m.alerts = [];
    if (pfInPj.n) m.alerts.push({ k: 'pfpj', t: 'Gastos pessoais pagos pela conta da empresa', v: pfInPj.v, n: pfInPj.n, x: 'Misturar PF e PJ distorce o lucro e complica o contador. O ideal é pagar uma retirada (pró-labore) para a conta pessoal e gastar de lá.' });
    if (pjInPf.n) m.alerts.push({ k: 'pjpf', t: 'Despesas da empresa pagas pela conta pessoal', v: pjInPf.v, n: pjInPf.n, x: 'Elas entram no DRE da empresa, mas o dinheiro saiu do seu bolso — guarde o comprovante para reembolso ou ajuste com o contador.' });
    var temCartao = p.accounts.some(function (a) { return a.kind === 'cartao'; });
    if (faturaPaga > 0 && !temCartao) m.alerts.push({ k: 'fatura', t: 'Fatura de cartão paga sem a fatura importada', v: faturaPaga, n: m.byCat.x_fatura.n, x: 'O pagamento da fatura fica fora do resultado para não contar o gasto duas vezes. Importe o CSV da fatura do cartão para que essas compras entrem nas categorias.' });
    if (m.semCat) m.alerts.push({ k: 'semcat', t: 'Lançamentos sem categoria', v: m.semCatV, n: m.semCat, x: 'Eles não entram no DRE. Categorize com a IA ou à mão na aba Lançamentos.' });
    m.resultadoPJ = d.resultado;
    return m;
  }
  function delta(cur, prev) { if (prev == null || cur == null) return null; return { abs: cur - prev, pct: prev ? (cur - prev) * 100 / Math.abs(prev) : null }; }
  function deltaHTML(dd, goodUp) {
    if (!dd) return '';
    var v = dd.abs; if (Math.abs(v) < 0.5) return '<span class="dl flat">■ igual</span>';
    var good = goodUp ? v > 0 : v < 0;
    return '<span class="dl ' + (good ? 'up' : 'down') + '">' + (v > 0 ? '▲ ' : '▼ ') + brl(Math.abs(v)) + (dd.pct != null && Math.abs(dd.pct) < 999 ? ' (' + (dd.pct > 0 ? '+' : '−') + NF0.format(Math.abs(dd.pct)) + '%)' : '') + '</span>';
  }

  // ───────────────────────── rendering helpers ─────────────────────────
  var STAMP_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';
  function catOptions(sel, dir) {
    var groups = ['pj', 'pf', 'x'], modo = state.per ? state.per.modo : 'misto';
    return '<option value=""' + (!sel ? ' selected' : '') + '>— sem categoria —</option>' + groups.filter(function (g) { return g === 'x' || modo === 'misto' || modo === g || (sel && CAT[sel] && CAT[sel].scope === g); }).map(function (g) {
      return '<optgroup label="' + SCOPE_LABEL[g] + '">' + CATS.filter(function (c) { return c.scope === g && (c.dir === 'both' || !dir || c.dir === dir || c.id === sel); }).map(function (c) { return '<option value="' + c.id + '"' + (c.id === sel ? ' selected' : '') + '>' + esc(c.label) + '</option>'; }).join('') + '</optgroup>';
    }).join('');
  }
  function tickerItems(m, c) {
    var d = m.dre, cd = c && c.dre;
    var items = [];
    if (m.temPJ) {
      items.push({ k: 'Receita da empresa', v: brl(d.receita), d: cd ? delta(d.receita, cd.receita) : null, up: true });
      items.push({ k: 'Resultado do mês (PJ)', v: brl(d.resultado), d: cd ? delta(d.resultado, cd.resultado) : null, up: true, neg: d.resultado < 0 });
      items.push({ k: 'Margem operacional', v: d.margemOp == null ? '—' : fmtPct(d.margemOp) });
    }
    items.push({ k: 'Entradas', v: brl(m.entradas), d: c ? delta(m.entradas, c.entradas) : null, up: true });
    items.push({ k: 'Saídas', v: brl(m.saidas), d: c ? delta(m.saidas, c.saidas) : null, up: false });
    if (m.temPF) items.push({ k: 'Gastos pessoais', v: brl(-m.pf.gastos), d: c ? delta(-m.pf.gastos, -c.pf.gastos) : null, up: false });
    items.push({ k: 'Assinaturas de serviços', v: brl(m.subsTotal) + '/mês' });
    return items;
  }
  function tickerHTML(m, c) {
    return tickerItems(m, c).map(function (it) { return '<div class="tk' + (it.neg ? ' neg' : '') + '"><p class="tk-k">' + esc(it.k) + '</p><p class="tk-v">' + esc(it.v) + '</p>' + (it.d ? deltaHTML(it.d, it.up) : '') + '</div>'; }).join('');
  }
  function dreRow(label, v, opts) {
    opts = opts || {};
    var cls = 'dre-row' + (opts.total ? ' total' : '') + (opts.sub ? ' sub' : '') + (opts.grand ? ' grand' : '');
    return '<tr class="' + cls + '"><th scope="row">' + esc(label) + (opts.note ? '<span class="dre-note">' + esc(opts.note) + '</span>' : '') + '</th><td class="num' + (v < -0.004 ? ' neg' : '') + '">' + brl2(v) + '</td>' + (opts.cmp !== undefined ? '<td class="num cmpcol">' + (opts.cmp == null ? '—' : brl2(opts.cmp)) + '</td><td class="dcol">' + (opts.cmp == null ? '' : deltaHTML(delta(v, opts.cmp), opts.goodUp !== false)) + '</td>' : '') + '</tr>';
  }
  function dreHTML(m, c) {
    var d = m.dre, cd = c && c.dre, x = !!c;
    function cv(k) { return x ? (cd ? cd[k] : null) : undefined; }
    function cl(id) { return x ? (c.byCat[id] ? c.byCat[id].v : 0) : undefined; }
    var h = '<table class="dre"><caption>Demonstrativo de resultado · regime de caixa</caption><thead><tr><th scope="col">Conta</th><th scope="col" class="num">Este mês</th>' + (x ? '<th scope="col" class="num cmpcol">' + esc(shortTxt(c.__nome, 24)) + '</th><th scope="col" class="dcol">Variação</th>' : '') + '</tr></thead><tbody>';
    h += dreRow('Receita bruta de vendas e serviços', d.receita, { cmp: cv('receita') });
    h += dreRow('(−) Impostos sobre o faturamento', d.impostos, { sub: true, cmp: cv('impostos'), goodUp: true });
    h += dreRow('= Receita líquida', d.liquida, { total: true, cmp: cv('liquida') });
    h += dreRow('(−) Custos diretos', d.custos, { sub: true, cmp: cv('custos') });
    h += dreRow('= Lucro bruto', d.lucroBruto, { total: true, note: d.margemBruta == null ? '' : 'margem ' + fmtPct(d.margemBruta), cmp: cv('lucroBruto') });
    d.despLines.forEach(function (l) { h += dreRow('(−) ' + l.label, l.v, { sub: true, cmp: cl(l.id) }); });
    if (!d.despLines.length) h += dreRow('(−) Despesas operacionais', 0, { sub: true, cmp: cv('despesas') });
    h += dreRow('= Resultado operacional', d.operacional, { total: true, note: d.margemOp == null ? '' : 'margem ' + fmtPct(d.margemOp), cmp: cv('operacional') });
    h += dreRow('(+) Outras receitas', d.outras, { sub: true, cmp: cv('outras') });
    h += dreRow('= Resultado antes das retiradas', d.antesRet, { total: true, cmp: cv('antesRet') });
    h += dreRow('(−) Pró-labore e retiradas', d.retiradas, { sub: true, cmp: cv('retiradas') });
    h += dreRow('= Sobrou na empresa no mês', d.resultado, { total: true, grand: true, cmp: cv('resultado') });
    return h + '</tbody></table>';
  }
  function pfHTML(m) {
    if (!m.temPF) return '';
    var h = '<table class="dre pf"><caption>Finanças pessoais (PF)</caption><tbody>';
    h += dreRow('Renda pessoal', m.pf.renda);
    m.pf.lines.forEach(function (l) { h += dreRow('(−) ' + l.label, l.v, { sub: true }); });
    h += dreRow('= Saldo pessoal do mês', m.pf.renda + m.pf.gastos, { total: true, grand: true });
    return h + '</tbody></table>';
  }
  function barsHTML(list, total, color) {
    if (!list.length) return '<p class="muted">Nada para mostrar.</p>';
    var max = Math.max.apply(null, list.map(function (x) { return Math.abs(x.v); }).concat([1]));
    return '<div class="bars">' + list.map(function (x) {
      return '<div class="bar-row"><span class="bar-l">' + esc(shortTxt(x.label, 46)) + '</span><span class="bar-t"><span class="bar-f ' + (color || '') + '" data-w="' + (Math.abs(x.v) * 100 / max).toFixed(1) + '"></span></span><span class="bar-v">' + brl(Math.abs(x.v)) + (total ? '<small>' + fmtPct(Math.abs(x.v) * 100 / total) + '</small>' : '') + '</span></div>';
    }).join('') + '</div>';
  }
  function cashSVG(m) {
    var D = m.cash.days; if (D.length < 2) return '<p class="muted">Poucos dias com movimento na conta para desenhar o fluxo.</p>';
    var W = 720, H = 220, pl = 64, pr = 12, pt = 14, pb = 28, iw = W - pl - pr, ih = H - pt - pb;
    var t0 = D[0].t, t1 = D[D.length - 1].t, span = Math.max(1, t1 - t0);
    var vals = D.map(function (x) { return x.bal; }).concat([m.cash.saldoReal ? m.cash.saldoInicial : 0]);
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals); if (hi === lo) { hi += 1; lo -= 1; }
    var pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    function X(t) { return pl + (t - t0) * iw / span; }
    function Y(v) { return pt + (hi - v) * ih / (hi - lo); }
    var path = '', prevY = Y(m.cash.saldoReal ? m.cash.saldoInicial : 0);
    path = 'M' + X(t0).toFixed(1) + ' ' + prevY.toFixed(1);
    D.forEach(function (x) { var xx = X(x.t).toFixed(1); path += ' H' + xx + ' V' + Y(x.bal).toFixed(1); });
    var grid = '';
    for (var i = 0; i <= 3; i++) { var v = lo + (hi - lo) * i / 3, y = Y(v).toFixed(1); grid += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y + '" y2="' + y + '" class="g"/><text x="' + (pl - 6) + '" y="' + (+y + 4) + '" text-anchor="end" class="ax">' + esc(brlShort(v)) + '</text>'; }
    var zero = lo < 0 && hi > 0 ? '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + Y(0).toFixed(1) + '" y2="' + Y(0).toFixed(1) + '" class="z"/>' : '';
    var mn = m.cash.minDia, mark = mn ? '<circle cx="' + X(mn.t).toFixed(1) + '" cy="' + Y(mn.bal).toFixed(1) + '" r="4.5" class="mk"/>' : '';
    return '<svg class="cash" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Saldo da conta dia a dia">' + grid + zero + '<path d="' + path + '" class="ln"/>' + mark +
      '<text x="' + pl + '" y="' + (H - 8) + '" class="ax">' + dm(t0) + '</text><text x="' + (W - pr) + '" y="' + (H - 8) + '" text-anchor="end" class="ax">' + dm(t1) + '</text></svg>';
  }
  function subsHTML(m) {
    if (!m.subs.length) return '<p class="muted">Nenhuma assinatura ou cobrança recorrente identificada. Elas aparecem aqui quando a descrição é de um serviço conhecido, quando a IA marca como assinatura ou quando o mesmo valor se repete em outro mês salvo.</p>';
    return '<table class="ledger subs"><thead><tr><th scope="col">Serviço</th><th scope="col" class="num">No mês</th><th scope="col" class="num">Em 12 meses</th><th scope="col">Visto</th></tr></thead><tbody>' + m.subs.map(function (s) {
      return '<tr><td>' + esc(shortTxt(s.d, 54)) + '<span class="cat-chip">' + esc(CAT[s.cat] ? CAT[s.cat].label : '') + '</span></td><td class="num">' + brl2(s.mensal) + '</td><td class="num">' + brl(s.mensal * 12) + '</td><td>' + (s.meses >= 2 ? s.meses + ' meses' : 'este mês') + '</td></tr>';
    }).join('') + '</tbody><tfoot><tr><th scope="row">Total</th><td class="num">' + brl2(m.subsTotal) + '</td><td class="num">' + brl(m.subsTotal * 12) + '</td><td></td></tr></tfoot></table>';
  }
  function alertsHTML(m) {
    if (!m.alerts.length) return '';
    return '<div class="alerts">' + m.alerts.map(function (a) { return '<div class="alert alert-' + a.k + '">' + STAMP_ICON + '<div><p class="alert-t">' + esc(a.t) + ' · <b>' + brl2(a.v) + '</b> em ' + plural(a.n, 'lançamento', 'lançamentos') + '</p><p>' + esc(a.x) + '</p></div></div>'; }).join('') + '</div>';
  }
  function dashboardHTML(m, c) {
    var desp = [], tot = 0;
    CATS.forEach(function (cc) { if (cc.scope !== 'x' && m.byCat[cc.id].v < 0) { desp.push({ label: cc.label + (cc.scope === 'pf' ? ' · PF' : ''), v: m.byCat[cc.id].v }); tot += -m.byCat[cc.id].v; } });
    desp.sort(function (a, b) { return a.v - b.v; });
    var cashNote = m.cash.saldoReal ? 'Saldo real da conta (o OFX trouxe o saldo final de ' + brl2(m.cash.saldoFinal) + '). Ponto mais baixo: ' + (m.cash.minDia ? brl2(m.cash.minDia.bal) + ' em ' + dm(m.cash.minDia.t) : '—') + '.' : 'Movimento acumulado das contas (o arquivo não trouxe o saldo). Exporte em OFX para ver o saldo real.';
    return alertsHTML(m) +
      '<div class="blocks">' +
      (m.temPJ ? '<section class="block wide"><p class="kicker">Empresa</p><h3 class="block-t">DRE gerencial do mês</h3>' + dreHTML(m, c) + '</section>' : '') +
      (m.temPF ? '<section class="block"><p class="kicker">Pessoal</p><h3 class="block-t">Para onde foi o dinheiro pessoal</h3>' + pfHTML(m) + '</section>' : '') +
      '<section class="block"><p class="kicker">Saídas</p><h3 class="block-t">Gastos por categoria</h3>' + barsHTML(desp.slice(0, 12), tot, 'out') + '</section>' +
      '<section class="block wide"><p class="kicker">Caixa</p><h3 class="block-t">Fluxo de caixa dia a dia</h3>' + cashSVG(m) + '<p class="field-note">' + esc(cashNote) + ' Entraram ' + brl2(m.cash.days.reduce(function (s, x) { return s + x.i; }, 0)) + ' e saíram ' + brl2(m.cash.days.reduce(function (s, x) { return s + x.o; }, 0)) + ' nas contas (compras no cartão entram pelo pagamento da fatura).</p></section>' +
      '<section class="block wide"><p class="kicker">Recorrentes</p><h3 class="block-t">Assinaturas de serviços</h3>' + subsHTML(m) + '</section>' +
      '<section class="block"><p class="kicker">Destinos</p><h3 class="block-t">Para quem mais saiu dinheiro</h3>' + barsHTML(m.destinos.map(function (x) { return { label: shortTxt(x.d, 46), v: -x.v }; }), 0, 'out') + '</section>' +
      (m.fora.length ? '<section class="block"><p class="kicker">Fora do resultado</p><h3 class="block-t">Movimentos que não são receita nem despesa</h3>' + barsHTML(m.fora.map(function (x) { return { label: x.label, v: x.v }; }), 0, 'muted-bar') + '<p class="field-note">Transferências entre suas contas, investimentos, pagamento de fatura e empréstimos mexem no caixa, mas não são lucro nem prejuízo.</p></section>' : '') +
      '</div>';
  }

  // ───────────────────────── AI (BYOK, OpenRouter) ─────────────────────────
  function activeKey() {
    var k = window.ApiKeyManager && ApiKeyManager.getActiveKey ? ApiKeyManager.getActiveKey() : null;
    return k && k.key ? k : null;
  }
  // One OpenRouter call → assistant content string. Throws {emptyContent} on empty answer (COR-035).
  function fetchContent(messages, temperature, signal, maxTokens) {
    var key = activeKey();
    if (!key) return Promise.reject(new Error('Conecte sua chave de IA (ícone de chave no topo) para continuar.'));
    var model = (window.ApiKeyManager && ApiKeyManager.getModel) ? ApiKeyManager.getModel() : 'google/gemini-3.8-flash';
    var isDeepSeek = model.indexOf('deepseek/') === 0;
    var body = { model: model, messages: messages, temperature: (temperature == null ? 0.3 : temperature), max_tokens: maxTokens || 16000 }; // COR-053
    if (!isDeepSeek) body.reasoning = { effort: 'low' }; // COR-034; never for deepseek/* (COR-035)
    var doFetch = function () {
      return fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', signal: signal,
        headers: { 'Authorization': 'Bearer ' + key.key, 'Content-Type': 'application/json', 'HTTP-Referer': location.origin, 'X-Title': 'Extrato IA - Maestros da IA' },
        body: JSON.stringify(body)
      }).then(function (r) {
        return r.text().then(function (txt) {
          if (!r.ok) {
            var msg = 'Erro ' + r.status + ' do provedor de IA.';
            try { var j = JSON.parse(txt); msg = (j.error && (j.error.message || j.error)) || msg; } catch (e) {}
            if (r.status === 401) msg = 'Chave inválida ou sem permissão. Confira sua chave da OpenRouter.';
            else if (r.status === 402) msg = 'Créditos insuficientes na sua conta OpenRouter.';
            else if (r.status === 429) msg = 'Muitas requisições ao provedor. Aguarde alguns segundos e tente de novo.';
            var e = new Error(String(msg)); e.httpStatus = r.status; throw e;
          }
          var data; try { data = JSON.parse(txt); } catch (e2) { throw new Error('Resposta inválida do provedor de IA.'); }
          if (data && data.error) throw new Error(String(data.error.message || 'Erro do provedor de IA.'));
          var choice = (data.choices && data.choices[0]) || {};
          var content = (choice.message && choice.message.content) || '';
          if (!content || !String(content).trim()) { var em = new Error('Resposta vazia do modelo.'); em.emptyContent = true; throw em; }
          return String(content);
        });
      });
    };
    var run = function () {
      return doFetch().catch(function (e) {
        if (e && e.emptyContent && body.reasoning) { delete body.reasoning; return doFetch(); } // COR-035 net
        throw e;
      });
    };
    var limited = (window.RateLimiter && RateLimiter.executeWithLimit) ? RateLimiter.executeWithLimit('openrouter', run) : run();
    return Promise.resolve(limited).then(function (res) {
      if (res == null) throw new Error('Limite de uso por minuto atingido. Aguarde um pouco e tente de novo.');
      return res;
    });
  }
  function stripToObject(s) {
    s = String(s).replace(/```json/gi, '').replace(/```/g, '').trim();
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a !== -1 && b !== -1 && b > a) s = s.slice(a, b + 1);
    return s;
  }
  function tryParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
  function parseJSONLadder(raw) {
    var s = stripToObject(raw);
    var o = tryParse(s); if (o) return o;
    var s2 = s.replace(/,\s*([}\]])/g, '$1'); o = tryParse(s2); if (o) return o;
    var s3 = s2.replace(/[\x00-\x1f]+/g, ' '); o = tryParse(s3); if (o) return o;
    var s4 = s3.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"); o = tryParse(s4); if (o) return o;
    return null;
  }
  function callJSON(messages, temperature, signal, maxTokens) {
    return fetchContent(messages, temperature, signal, maxTokens).then(function (txt) {
      var obj = parseJSONLadder(txt);
      if (obj) return obj;
      var strict = messages.concat([{ role: 'user', content: 'Sua resposta anterior NÃO era um JSON válido. Responda novamente APENAS com o objeto JSON pedido, com aspas retas ("), sem markdown, sem comentários, sem texto antes ou depois.' }]);
      return fetchContent(strict, 0.1, signal, maxTokens).then(function (txt2) {
        var obj2 = parseJSONLadder(txt2);
        if (obj2) return obj2;
        throw new Error('O modelo não devolveu um JSON válido. Tente de novo (ou troque de modelo).');
      });
    });
  }

  // ── batch categorization: one line per UNIQUE new description ──
  function pendingGroups() {
    var p = state.per, G = {}, accs = {}; p.accounts.forEach(function (a) { accs[a.id] = a; });
    p.tx.forEach(function (t) {
      if (t.c) return;
      var k = txKey(t), g = G[k] || (G[k] = { k: k, d: t.d, v: 0, n: 0, dir: t.v >= 0 ? 'entrada' : 'saída', kinds: {}, tit: {} });
      g.v += Math.abs(t.v); g.n++; var a = accs[t.a] || {}; g.kinds[a.kind || 'conta'] = 1; g.tit[a.titular || 'pj'] = 1;
    });
    return Object.keys(G).map(function (k) { return G[k]; }).sort(function (a, b) { return b.v - a.v; });
  }
  function categorizeMessages(chunk) {
    var p = state.per;
    var allowed = CATS.filter(function (c) { return c.scope === 'x' || p.modo === 'misto' || c.scope === p.modo; });
    var cats = allowed.map(function (c) { return c.id + ' = ' + c.label + (c.dir === 'in' ? ' [só entradas]' : c.dir === 'out' ? ' [só saídas]' : ''); }).join('\n');
    var sys = 'Você é um assistente contábil brasileiro que categoriza lançamentos de extrato bancário de pequenos negócios, MEIs, criadores de conteúdo e prestadores de serviço.\n' +
      'Categorias permitidas (use EXATAMENTE o código antes do "="):\n' + cats + '\n\n' +
      'Regras:\n- Respeite [só entradas]/[só saídas].\n- "Pix recebido" de pessoa ou empresa numa conta da empresa costuma ser receita de vendas/serviços; repasses de plataformas (Hotmart, Kiwify, Eduzz, Stripe, Mercado Pago, PagSeguro) são receita de vendas.\n' +
      '- Pix enviado para pessoa física pode ser equipe/prestador, pró-labore (quando parece ser o próprio dono — mesmo sobrenome recorrente, valores redondos) ou gasto pessoal; use o contexto do negócio.\n' +
      '- Anúncios (Facebook/Meta, Google Ads, TikTok) = mkt. Softwares e SaaS = soft. Aluguel/coworking, energia, internet, telefone da empresa = estrutura.\n' +
      '- Mercado, delivery, restaurante, farmácia, academia, streaming e lazer: quando a conta é PJ e não há sinal de uso profissional, classifique como pessoal (pf_*), para o dono enxergar a mistura.\n' +
      '- Se não houver como saber, escolha a categoria "outras"/"outros" do escopo mais provável.\n' +
      '- "a" = true quando for assinatura/cobrança recorrente de serviço (streaming, software, academia, plano).\n' +
      'Responda APENAS com JSON: {"r":[{"i":<número da linha>,"c":"<código>","a":<true|false>}]} com uma entrada para CADA linha recebida.';
    var ctx = 'Contexto do negócio: ' + (p.negocio ? shortTxt(p.negocio, 300) : 'não informado') + '.\nModo: ' + (p.modo === 'pj' ? 'só empresa' : p.modo === 'pf' ? 'só pessoal' : 'contas da empresa e pessoais misturadas') + '.\n';
    var lines = chunk.map(function (g, i) {
      var conta = Object.keys(g.kinds).join('/') + ' ' + Object.keys(g.tit).map(function (x) { return x === 'pf' ? 'pessoal' : 'empresa'; }).join('/');
      return i + ' | ' + g.dir + ' | R$ ' + NF0.format(g.v / g.n) + (g.n > 1 ? ' (x' + g.n + ')' : '') + ' | ' + conta + ' | ' + maskDigits(g.d);
    }).join('\n');
    return [{ role: 'system', content: sys }, { role: 'user', content: ctx + '\nLinhas (índice | direção | valor médio | conta | descrição):\n' + lines }];
  }
  function runCategorize() {
    if (state.running) return;
    var p = state.per;
    if (!activeKey()) { $('cat-error').textContent = 'Conecte sua chave de IA (ícone de chave no topo) para categorizar com IA — ou escolha as categorias à mão na tabela.'; $('cat-error').hidden = false; return; }
    var groups = pendingGroups();
    if (!groups.length) { toast('Todos os lançamentos já têm categoria.'); return; }
    $('cat-error').hidden = true;
    state.running = true; state.ctl = new AbortController();
    var chunks = []; for (var i = 0; i < groups.length; i += AI_CHUNK) chunks.push(groups.slice(i, i + AI_CHUNK));
    var done = 0, applied = 0, failed = 0;
    var btn = $('cat-ai'), prog = $('cat-progress');
    btn.disabled = true; btn.textContent = 'Categorizando…'; $('cat-stop').hidden = false; prog.hidden = false;
    function paintProg() { prog.innerHTML = '<span class="prog-bar"><span class="prog-fill" data-w="' + (done * 100 / groups.length).toFixed(1) + '"></span></span><span class="prog-t">' + fmtInt(done) + ' de ' + plural(groups.length, 'descrição', 'descrições') + '</span>'; fixW(prog); }
    paintProg();
    var idx = 0;
    function next() {
      if (idx >= chunks.length || !state.running) return Promise.resolve();
      var chunk = chunks[idx++];
      return callJSON(categorizeMessages(chunk), 0.1, state.ctl.signal, 6000).then(function (o) {
        var arr = o && Array.isArray(o.r) ? o.r : [];
        var byI = {}; arr.forEach(function (x) { if (x && x.i != null) byI[+x.i] = x; });
        chunk.forEach(function (g, i) {
          var x = byI[i], c = x && clean(x.c);
          if (!c || !CAT[c]) { failed++; return; }
          var dirOk = CAT[c].dir === 'both' || (CAT[c].dir === 'in') === (g.dir === 'entrada');
          if (!dirOk) { failed++; return; }
          setRule(g.k, c, 'ia');
          p.tx.forEach(function (t) { if (!t.c && txKey(t) === g.k) { t.c = c; t.s = 'ia'; t.sub = x.a === true || x.a === 'true'; applied++; } });
        });
        done += chunk.length; paintProg(); saveRules(); refreshMetrics(); save(); renderTx();
        return next();
      });
    }
    next().then(function () {
      markTransfers(p); p.report = null; refreshMetrics(); saveNow();
      toast(plural(applied, 'lançamento categorizado', 'lançamentos categorizados') + (failed ? ' · ' + plural(failed, 'descrição ficou', 'descrições ficaram') + ' para você' : ''));
    }).catch(function (e) {
      if (e && e.name === 'AbortError') { toast('Categorização interrompida — o que já foi feito ficou salvo.'); return; }
      $('cat-error').textContent = (e && e.message) || 'Erro ao categorizar.'; $('cat-error').hidden = false;
    }).then(function () {
      state.running = false; state.ctl = null; btn.disabled = false; $('cat-stop').hidden = true; prog.hidden = true;
      paintAll();
    });
  }

  // ── monthly analysis: aggregates only ──
  function round1(x) { return Math.round(x * 10) / 10; }
  function buildFacts(m, c) {
    var d = m.dre;
    var f = {
      periodo: dmy(m.start) + ' a ' + dmy(m.end),
      lancamentos: m.n, sem_categoria: m.semCat,
      empresa: m.temPJ ? {
        receita_bruta: r2(d.receita), impostos: r2(-d.impostos), receita_liquida: r2(d.liquida), custos_diretos: r2(-d.custos), lucro_bruto: r2(d.lucroBruto),
        margem_bruta_pct: d.margemBruta == null ? null : round1(d.margemBruta),
        despesas_operacionais: d.despLines.map(function (l) { return { categoria: l.label, valor: r2(-l.v), pct_da_receita: d.receita > 0 ? round1(-l.v * 100 / d.receita) : null }; }),
        resultado_operacional: r2(d.operacional), margem_operacional_pct: d.margemOp == null ? null : round1(d.margemOp),
        outras_receitas: r2(d.outras), retiradas_prolabore: r2(-d.retiradas), sobrou_na_empresa: r2(d.resultado)
      } : null,
      pessoal: m.temPF ? { renda: r2(m.pf.renda), gastos: m.pf.lines.map(function (l) { return { categoria: l.label, valor: r2(-l.v) }; }), saldo: r2(m.pf.renda + m.pf.gastos) } : null,
      caixa: { entradas_nas_contas: r2(m.cash.days.reduce(function (s, x) { return s + x.i; }, 0)), saidas_das_contas: r2(m.cash.days.reduce(function (s, x) { return s + x.o; }, 0)), saldo_final: m.cash.saldoReal ? r2(m.cash.saldoFinal) : null, menor_saldo: m.cash.saldoReal && m.cash.minDia ? { valor: r2(m.cash.minDia.bal), dia: dm(m.cash.minDia.t) } : null },
      assinaturas: { total_mensal: r2(m.subsTotal), total_12_meses: r2(m.subsTotal * 12), itens: m.subs.filter(function (s) { return SUBS_RE.test(s.k) || s.cat === 'soft' || s.cat === 'pf_lazer' || s.cat === 'mkt'; }).slice(0, 12).map(function (s) { return { servico: shortTxt(s.k, 30), mensal: r2(s.mensal), meses_vistos: s.meses }; }) },
      alertas: m.alerts.map(function (a) { return { alerta: a.t, valor: r2(a.v), lancamentos: a.n }; })
    };
    if (c) {
      var cd = c.dre;
      f.comparacao = { com: c.__nome, receita_antes: r2(cd.receita), sobrou_antes: r2(cd.resultado), despesas_operacionais_antes: r2(-cd.despesas), gastos_pessoais_antes: r2(-c.pf.gastos), assinaturas_antes: r2(c.subsTotal) };
    }
    return f;
  }
  function numbersOf(facts) {
    var out = []; (function walk(o) { if (o == null) return; if (typeof o === 'number') out.push(o); else if (typeof o === 'object') Object.keys(o).forEach(function (k) { walk(o[k]); }); })(facts);
    return out;
  }
  function checkNumbers(rep, facts) {
    var nums = numbersOf(facts), flags = [];
    var extra = []; nums.forEach(function (a) { nums.forEach(function (b) { if (a !== b) { extra.push(Math.abs(a - b)); if (b) extra.push(Math.abs((a - b) * 100 / b)); } }); });
    function near(v, tolAbs, tolRel) { return nums.concat(extra.slice(0, 4000)).some(function (n) { return Math.abs(Math.abs(n) - v) <= Math.max(tolAbs, Math.abs(n) * tolRel); }); }
    var text = [rep.manchete, rep.linha_fina].concat(rep.resumo, rep.destaques.map(function (x) { return x.titulo + ' ' + x.texto; }), rep.alertas.map(function (x) { return x.titulo + ' ' + x.texto; }), rep.recomendacoes.map(function (x) { return x.acao + ' ' + x.porque; })).join(' ');
    (text.match(/R\$\s?-?[\d.]+(?:,\d+)?(?:\s?(?:mil|mi))?/g) || []).forEach(function (s) {
      var v = Math.abs(parseMoney(s.replace(/\s?(mil|mi)$/, ''))); if (/mil$/.test(s)) v *= 1000; if (/mi$/.test(s)) v *= 1e6;
      if (!isNaN(v) && v >= 10 && !near(v, 1, 0.02)) flags.push(s);
    });
    (text.match(/-?\d+(?:,\d+)?\s?%/g) || []).forEach(function (s) {
      var v = Math.abs(parseFloat(s.replace(',', '.'))); if (!isNaN(v) && v >= 1 && !near(v, 0.15, 0.01)) flags.push(s);
    });
    return flags.filter(function (x, i, a) { return a.indexOf(x) === i; }).slice(0, 6);
  }
  function summaryMessages(facts) {
    var sys = 'Você é um analista financeiro brasileiro que escreve o fechamento do mês para donos de pequenos negócios, MEIs e criadores de conteúdo. Escreva em português do Brasil, direto, sem jargão desnecessário e SEM inventar números: use somente os números do JSON recebido (pode arredondar para reais inteiros ou 1 casa no percentual). Se um dado não existir, não fale dele. Os valores já foram calculados linha a linha pelo sistema.\n' +
      'Responda APENAS com JSON: {"manchete":"frase curta e concreta sobre o mês","linha_fina":"1 frase de apoio","resumo":["2 ou 3 parágrafos curtos"],"destaques":[{"titulo":"","texto":""}],"alertas":[{"titulo":"","texto":""}],"recomendacoes":[{"acao":"","porque":"","prioridade":"alta|media|baixa"}]}\n' +
      'Até 3 destaques, até 3 alertas, 3 a 5 recomendações práticas para o próximo mês (cortar assinatura específica, separar PF/PJ, reservar imposto, ajustar pró-labore, rever custo que pesa na margem…).';
    return [{ role: 'system', content: sys }, { role: 'user', content: 'Números do mês (JSON):\n' + JSON.stringify(facts) }];
  }
  function generateSummary() {
    if (state.running) return;
    var p = state.per, m = state.m; if (!p || !m) return;
    var err = $('summary-error'); err.hidden = true;
    if (!activeKey()) { err.textContent = 'Conecte sua chave de IA (ícone de chave no topo) para escrever a análise. O painel e as exportações funcionam sem chave.'; err.hidden = false; return; }
    var facts = buildFacts(m, state.cmp);
    state.running = true; state.ctl = new AbortController();
    var btn = $('summary-btn'); btn.disabled = true; btn.textContent = 'Escrevendo…'; $('report-hint').textContent = 'A IA está lendo os números do mês… (15 a 60 s)';
    callJSON(summaryMessages(facts), 0.4, state.ctl.signal).then(function (o) {
      function pr(x) { var q = fold(x); return q.indexOf('alt') === 0 ? 'alta' : (q.indexOf('baix') === 0 ? 'baixa' : 'media'); }
      function pair(arr, n) { return (Array.isArray(arr) ? arr : []).map(function (d) { return { titulo: clean(d && d.titulo), texto: clean(d && d.texto) }; }).filter(function (d) { return d.titulo || d.texto; }).slice(0, n); }
      var rep = {
        manchete: clean(o.manchete) || (p.nome || periodName(m)), linha_fina: clean(o.linha_fina),
        resumo: (Array.isArray(o.resumo) ? o.resumo : [o.resumo]).map(clean).filter(Boolean).slice(0, 4),
        destaques: pair(o.destaques, 3), alertas: pair(o.alertas, 3),
        recomendacoes: (Array.isArray(o.recomendacoes) ? o.recomendacoes : []).map(function (r) { return { acao: clean(r && r.acao), porque: clean(r && r.porque), prioridade: pr(r && r.prioridade) }; }).filter(function (r) { return r.acao; }).slice(0, 6),
        cmp: state.cmp ? state.cmp.__nome : '', at: Date.now(), model: ApiKeyManager.getModel ? ApiKeyManager.getModel() : ''
      };
      if (!rep.resumo.length) throw new Error('A IA devolveu uma análise vazia. Tente de novo ou troque de modelo.');
      rep.flags = checkNumbers(rep, facts);
      p.report = rep; saveNow(); renderReport(); toast('Análise pronta');
    }).catch(function (e) {
      if (e && e.name === 'AbortError') return;
      err.textContent = (e && e.message) || 'Erro ao escrever a análise.'; err.hidden = false;
    }).then(function () {
      state.running = false; state.ctl = null; btn.disabled = false; btn.textContent = p.report ? 'Reescrever a análise' : 'Escrever a análise'; renderReportHint();
    });
  }

  // ───────────────────────── report ─────────────────────────
  function periodName(m) {
    if (!m || !isFinite(m.start)) return 'Mês sem nome';
    var a = new Date(m.start), b = new Date(m.end);
    if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) return 'Extrato de ' + MONTHS[a.getMonth()] + ' de ' + a.getFullYear();
    return 'Extrato de ' + dm(m.start) + ' a ' + dmy(m.end);
  }
  function reportInnerHTML() {
    var p = state.per, m = state.m, c = state.cmp, r = p.report;
    var nome = p.nome || periodName(m);
    var accs = p.accounts.map(function (a) { return a.nome; }).join(' · ');
    var head = '<header class="stmt-head"><div class="stmt-brand"><p class="stmt-bank">Extrato IA</p><p class="stmt-sub">Fechamento do mês · ' + esc(dateline()) + '</p></div><div class="stmt-meta"><p><span>Período</span><b>' + esc(dmy(m.start)) + ' a ' + esc(dmy(m.end)) + '</b></p><p><span>Contas</span><b>' + esc(shortTxt(accs, 70)) + '</b></p><p><span>Lançamentos</span><b>' + fmtInt(m.n) + '</b></p></div></header>' +
      '<div class="ticker r-ticker">' + tickerHTML(m, c) + '</div>';
    var body = '';
    if (r) {
      body += '<h2 class="r-headline">' + esc(r.manchete) + '</h2>' + (r.linha_fina ? '<p class="r-dek">' + esc(r.linha_fina) + '</p>' : '');
      if (r.cmp && (!c || c.__nome !== r.cmp)) body += '<p class="flag">' + STAMP_ICON + '<span>Esta análise foi escrita comparando com “' + esc(r.cmp) + '”. Você mudou a comparação — reescreva para atualizar o texto.</span></p>';
      body += '<div class="r-cols"><div class="r-lead">' + r.resumo.map(function (x) { return '<p>' + esc(x) + '</p>'; }).join('') +
        (r.flags && r.flags.length ? '<p class="flag">' + STAMP_ICON + '<span>Confira no painel: ' + esc(r.flags.join(', ')) + ' não aparece(m) nos números calculados — a IA pode ter arredondado ou somado por conta própria.</span></p>' : '') + '</div>' +
        '<aside class="r-side">' + (r.destaques.length ? '<p class="r-side-h">Destaques</p>' + r.destaques.map(function (d) { return '<div class="r-hl"><b>' + esc(d.titulo) + '</b><span>' + esc(d.texto) + '</span></div>'; }).join('') : '') +
        (r.alertas.length ? '<p class="r-side-h alert">Alertas</p>' + r.alertas.map(function (d) { return '<div class="r-hl r-alert"><b>' + esc(d.titulo) + '</b><span>' + esc(d.texto) + '</span></div>'; }).join('') : '') + '</aside></div>';
      if (r.recomendacoes.length) body += '<section class="r-section"><h3 class="r-h3">O que fazer no próximo mês</h3><ol class="r-recs">' + r.recomendacoes.map(function (x) { return '<li><b>' + esc(x.acao) + '</b><span class="prio ' + x.prioridade + '">prioridade ' + (x.prioridade === 'media' ? 'média' : x.prioridade) + '</span><span class="why">' + esc(x.porque) + '</span></li>'; }).join('') + '</ol></section>';
    } else {
      body += '<h2 class="r-headline">' + esc(nome) + '</h2><p class="r-pending">Clique em <b>Escrever a análise</b> para a IA redigir o fechamento, os alertas e as recomendações a partir destes números. Os números abaixo já estão prontos.</p>';
    }
    body += '<section class="r-section r-dash">' + dashboardHTML(m, c) + '</section>';
    body += '<p class="r-foot">Gerado com Extrato IA · Comunidade Maestros da IA · todos os valores foram somados a partir dos ' + fmtInt(m.n) + ' lançamentos do extrato, em regime de caixa' + (r ? '; o texto foi redigido por IA a partir desses números agregados' : '') + '. Relatório gerencial — não substitui a contabilidade oficial.</p>';
    return head + body;
  }

  // ───────────────────────── exports ─────────────────────────
  function downloadBlob(name, blob) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  function csvCell(v) { var s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s) && !/^-?[\d.]+(,\d+)?$/.test(s)) s = "'" + s; return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function num2(v) { return v == null ? '' : NF2.format(v).replace(/\./g, ''); }
  function accName(id) { var a = state.per.accounts.filter(function (x) { return x.id === id; })[0]; return a ? a.nome : ''; }
  function sortedTx() { return state.per.tx.slice().sort(function (a, b) { return a.t - b.t || a.a.localeCompare(b.a); }); }
  function exportCSV() {
    var p = state.per; if (!p || !p.tx.length) return;
    var lines = [['Data', 'Conta', 'Descrição', 'Categoria', 'Grupo', 'Escopo', 'Entrada', 'Saída', 'Valor', 'Origem da categoria'].join(';')];
    sortedTx().forEach(function (t) {
      var c = CAT[t.c];
      lines.push([dmy(t.t), accName(t.a), t.d, c ? c.label : 'Sem categoria', c ? groupLabel(c.g) : '', c ? SCOPE_LABEL[c.scope] : '', t.v > 0 ? num2(t.v) : '', t.v < 0 ? num2(-t.v) : '', num2(t.v), SRC_LABEL[t.s] || ''].map(csvCell).join(';'));
    });
    downloadBlob(slug(p.nome || periodName(state.m)) + '-lancamentos.csv', new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    toast('CSV dos lançamentos baixado');
  }
  function groupLabel(g) { return { REC: 'Receita', OREC: 'Outras receitas', IMP: 'Impostos', CUS: 'Custos diretos', DESP: 'Despesas operacionais', RET: 'Retiradas', PFIN: 'Renda pessoal', PF: 'Gastos pessoais', X: 'Fora do resultado' }[g] || ''; }
  function exportXLSX() {
    var p = state.per, m = state.m; if (!p || !m) return;
    var btn = $('dl-xlsx'); btn.disabled = true;
    ensureXLSX().then(function () {
      var X = window.XLSX, wb = X.utils.book_new();
      var hd = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '0D5A4A' } }, alignment: { vertical: 'center' } };
      var money = '#,##0.00;[Red]-#,##0.00';
      // Lançamentos
      var rows = [['Data', 'Conta', 'Descrição', 'Categoria', 'Grupo', 'Escopo', 'Valor', 'Origem']];
      sortedTx().forEach(function (t) { var c = CAT[t.c]; rows.push([new Date(t.t), accName(t.a), t.d, c ? c.label : 'Sem categoria', c ? groupLabel(c.g) : '', c ? SCOPE_LABEL[c.scope] : '', t.v, SRC_LABEL[t.s] || '']); });
      var ws = X.utils.aoa_to_sheet(rows, { cellDates: true, dateNF: 'dd/mm/yyyy' });
      for (var i = 1; i < rows.length; i++) { var cd = ws[X.utils.encode_cell({ r: i, c: 0 })]; if (cd) cd.z = 'dd/mm/yyyy'; var cv = ws[X.utils.encode_cell({ r: i, c: 6 })]; if (cv) cv.z = money; }
      for (var j = 0; j < 8; j++) { var ch = ws[X.utils.encode_cell({ r: 0, c: j })]; if (ch) ch.s = hd; }
      ws['!cols'] = [{ wch: 11 }, { wch: 18 }, { wch: 60 }, { wch: 40 }, { wch: 20 }, { wch: 18 }, { wch: 14 }, { wch: 9 }];
      ws['!autofilter'] = { ref: 'A1:H' + rows.length };
      ws['!freeze'] = { xSplit: 0, ySplit: 1 };
      // DRE with SUMIFS over the ledger, so the accountant can audit every line
      var L = 'Lançamentos', n = rows.length;
      function sumCat(label) { return { f: "SUMIFS('" + L + "'!$G$2:$G$" + n + ",'" + L + "'!$D$2:$D$" + n + ',"' + label.replace(/"/g, '""') + '")', z: money }; }
      function sumGrp(g) { return { f: "SUMIFS('" + L + "'!$G$2:$G$" + n + ",'" + L + "'!$E$2:$E$" + n + ',"' + groupLabel(g) + '")', z: money }; }
      var dre = [['DRE gerencial · ' + (p.nome || periodName(m)), ''], ['Conta', 'Valor'], ['Receita bruta de vendas e serviços', sumGrp('REC')], ['(−) Impostos', sumGrp('IMP')], ['= Receita líquida', { f: 'B3+B4', z: money }], ['(−) Custos diretos', sumGrp('CUS')], ['= Lucro bruto', { f: 'B5+B6', z: money }]];
      var first = dre.length + 1;
      CATS.filter(function (c) { return c.g === 'DESP'; }).forEach(function (c) { dre.push(['(−) ' + c.label, sumCat(c.label)]); });
      var last = dre.length;
      dre.push(['= Resultado operacional', { f: 'B7+SUM(B' + first + ':B' + last + ')', z: money }]);
      var op = dre.length;
      dre.push(['(+) Outras receitas', sumGrp('OREC')]);
      dre.push(['= Resultado antes das retiradas', { f: 'B' + op + '+B' + (op + 1), z: money }]);
      dre.push(['(−) Pró-labore e retiradas', sumGrp('RET')]);
      dre.push(['= Sobrou na empresa no mês', { f: 'B' + (op + 2) + '+B' + (op + 3), z: money }]);
      dre.push(['', '']); dre.push(['Pessoal (PF)', '']);
      dre.push(['Renda pessoal', sumGrp('PFIN')]); dre.push(['Gastos pessoais', sumGrp('PF')]);
      dre.push(['', '']); dre.push(['Lançamentos sem categoria', { f: "SUMIFS('" + L + "'!$G$2:$G$" + n + ",'" + L + "'!$D$2:$D$" + n + ',"Sem categoria")', z: money }]);
      var wd = X.utils.aoa_to_sheet(dre);
      wd.A1.s = { font: { bold: true, sz: 14 } };
      ['A2', 'B2'].forEach(function (a) { wd[a].s = hd; });
      dre.forEach(function (r, i) { if (/^=/.test(r[0])) ['A', 'B'].forEach(function (col) { var cc = wd[col + (i + 1)]; if (cc) cc.s = { font: { bold: true }, fill: { fgColor: { rgb: 'DFEAE3' } } }; }); });
      wd['!cols'] = [{ wch: 52 }, { wch: 18 }];
      // Por categoria
      var pc = [['Categoria', 'Grupo', 'Escopo', 'Lançamentos', 'Total']];
      CATS.forEach(function (c) { if (m.byCat[c.id].n) pc.push([c.label, groupLabel(c.g), SCOPE_LABEL[c.scope], m.byCat[c.id].n, { f: "SUMIFS('" + L + "'!$G$2:$G$" + n + ",'" + L + "'!$D$2:$D$" + n + ',"' + c.label.replace(/"/g, '""') + '")', z: money }]); });
      var wc = X.utils.aoa_to_sheet(pc); for (var k = 0; k < 5; k++) wc[X.utils.encode_cell({ r: 0, c: k })].s = hd;
      wc['!cols'] = [{ wch: 48 }, { wch: 22 }, { wch: 18 }, { wch: 12 }, { wch: 14 }];
      // Assinaturas
      var sb = [['Serviço / descrição', 'Categoria', 'No mês', 'Em 12 meses', 'Meses em que apareceu']];
      m.subs.forEach(function (s, i) { sb.push([s.d, CAT[s.cat] ? CAT[s.cat].label : '', { v: r2(s.mensal), t: 'n', z: money }, { f: 'C' + (i + 2) + '*12', z: money }, s.meses]); });
      var wsb = X.utils.aoa_to_sheet(sb); for (var q = 0; q < 5; q++) wsb[X.utils.encode_cell({ r: 0, c: q })].s = hd;
      wsb['!cols'] = [{ wch: 56 }, { wch: 36 }, { wch: 14 }, { wch: 14 }, { wch: 12 }];
      X.utils.book_append_sheet(wb, wd, 'DRE');
      X.utils.book_append_sheet(wb, ws, L);
      X.utils.book_append_sheet(wb, wc, 'Por categoria');
      X.utils.book_append_sheet(wb, wsb, 'Assinaturas');
      X.writeFile(wb, slug(p.nome || periodName(m)) + '-extrato-categorizado.xlsx', { compression: true });
      toast('Planilha .xlsx baixada');
    }).catch(function () { toast('Não consegui carregar o gerador de planilha. Tente de novo.'); })
      .then(function () { btn.disabled = false; });
  }
  function b64(buf) { var bin = '', u = new Uint8Array(buf); for (var i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(bin); }
  function exportHTML() {
    var p = state.per; if (!p || !state.m) return;
    var btn = $('dl-html'); btn.disabled = true;
    var fonts = ['libre-caslon-text-400-latin', 'libre-caslon-text-700-latin', 'red-hat-text-var-latin', 'red-hat-mono-var-latin'];
    Promise.all([fetch('styles.css').then(function (r) { return r.text(); }), fetch('guilloche.svg').then(function (r) { return r.text(); }).catch(function () { return ''; })].concat(fonts.map(function (f) { return fetch('fonts/' + f + '.woff2').then(function (r) { return r.arrayBuffer(); }).then(function (b) { return [f, b64(b)]; }).catch(function () { return [f, null]; }); })))
      .then(function (res) {
        var css = res[0];
        if (res[1]) css = css.split("url('guilloche.svg')").join("url(data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(res[1]))) + ")");
        res.slice(2).forEach(function (x) { if (x[1]) css = css.split("url('fonts/" + x[0] + ".woff2')").join("url(data:font/woff2;base64," + x[1] + ")"); });
        var title = (p.report && p.report.manchete) || p.nome || periodName(state.m);
        var html = '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>' + esc(title) + '</title><style>' + css + '\nbody{padding:24px 12px}.report{max-width:1040px;margin:0 auto}</style></head><body><article class="report">' + reportInnerHTML().replace(/data-w="([\d.]+)"/g, 'style="--w:$1%"') + '</article></body></html>';
        downloadBlob(slug(p.nome || periodName(state.m)) + '-fechamento.html', new Blob([html], { type: 'text/html;charset=utf-8' }));
        toast('Relatório .html baixado');
      }).catch(function () { toast('Não consegui montar o arquivo. Tente de novo.'); })
      .then(function () { btn.disabled = false; });
  }
  function wrapLines(ctx, text, maxW, maxLines) {
    var words = String(text).split(/\s+/), lines = [], line = '';
    words.forEach(function (w) { var t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; });
    if (line) lines.push(line);
    if (lines.length > maxLines) { lines = lines.slice(0, maxLines); lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…'; }
    return lines;
  }
  function exportPNG() {
    var p = state.per, m = state.m; if (!p || !m) return;
    var go = function () {
      var W = 1080, H = 1350, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      var x = cv.getContext('2d');
      var serif = '"Libre Caslon Text", Georgia, serif', sans = '"Red Hat Text", Arial, sans-serif', mono = '"Red Hat Mono", Menlo, monospace';
      x.fillStyle = C.tint; x.fillRect(0, 0, W, H);
      // guilloché bands
      x.strokeStyle = 'rgba(13,90,74,.16)'; x.lineWidth = 1.2;
      for (var k = 0; k < 14; k++) { x.beginPath(); for (var gx = 0; gx <= W; gx += 6) { var gy = 70 + Math.sin(gx / 46 + k * 0.45) * 26 + Math.sin(gx / 17 + k) * 6; if (gx) x.lineTo(gx, gy); else x.moveTo(gx, gy); } x.stroke(); }
      for (var k2 = 0; k2 < 14; k2++) { x.beginPath(); for (var gx2 = 0; gx2 <= W; gx2 += 6) { var gy2 = H - 150 + Math.sin(gx2 / 52 + k2 * 0.4) * 24 + Math.cos(gx2 / 19 + k2) * 5; if (gx2) x.lineTo(gx2, gy2); else x.moveTo(gx2, gy2); } x.stroke(); }
      // cheque card
      var cx = 56, cy = 150, cw = W - 112, chh = 960;
      x.fillStyle = C.paper; x.fillRect(cx, cy, cw, chh);
      x.strokeStyle = C.teal; x.lineWidth = 3; x.strokeRect(cx + 10, cy + 10, cw - 20, chh - 20);
      x.lineWidth = 1; x.strokeRect(cx + 18, cy + 18, cw - 36, chh - 36);
      var y = cy + 80;
      x.fillStyle = C.teal; x.font = '700 22px ' + sans; x.fillText('EXTRATO IA · FECHAMENTO DO MÊS', cx + 52, y);
      x.textAlign = 'right'; x.fillStyle = C.ink2; x.font = '500 22px ' + mono; x.fillText(dmy(m.start) + ' — ' + dmy(m.end), cx + cw - 52, y); x.textAlign = 'left';
      y += 70; x.fillStyle = C.ink; x.font = '700 50px ' + serif;
      wrapLines(x, (p.report && p.report.manchete) || (p.nome || periodName(m)), cw - 104, 3).forEach(function (l) { x.fillText(l, cx + 52, y); y += 60; });
      y += 20;
      // the "valor" line, like a cheque amount
      var big = m.temPJ ? m.dre.resultado : (m.temPF ? m.pf.renda + m.pf.gastos : m.entradas - m.saidas);
      x.fillStyle = C.ink2; x.font = '500 24px ' + sans; x.fillText(m.temPJ ? 'Sobrou na empresa no mês' : 'Saldo do mês', cx + 52, y + 10);
      x.fillStyle = C.tint; x.fillRect(cx + 52, y + 26, cw - 104, 96);
      x.strokeStyle = C.teal; x.lineWidth = 2; x.strokeRect(cx + 52, y + 26, cw - 104, 96);
      x.fillStyle = big < 0 ? C.red : C.teal; x.font = '700 64px ' + mono; x.fillText(brl2(big), cx + 78, y + 98);
      y += 170;
      tickerItems(m, state.cmp).filter(function (it) { return !/Resultado do m/.test(it.k); }).slice(0, 6).forEach(function (it, i) {
        var col = i % 2, row = Math.floor(i / 2), ix = cx + 52 + col * ((cw - 104) / 2), iy = y + row * 108;
        x.fillStyle = C.rule; x.fillRect(ix, iy, (cw - 104) / 2 - 24, 1);
        x.fillStyle = C.ink2; x.font = '500 21px ' + sans; x.fillText(it.k.toUpperCase(), ix, iy + 32);
        x.fillStyle = C.ink; x.font = '700 40px ' + mono; x.fillText(it.v, ix, iy + 82);
      });
      // MICR-style line
      x.fillStyle = C.ink; x.font = '500 30px ' + mono;
      x.fillText('⑆ ' + String(m.n).padStart(4, '0') + ' ⑆ ' + new Date(m.end).getFullYear() + pad2(new Date(m.end).getMonth() + 1) + ' ⑈ ' + hash(p.id).slice(0, 6).toUpperCase() + ' ⑈', cx + 52, cy + chh - 50);
      x.fillStyle = C.ink; x.fillRect(0, H - 80, W, 80);
      x.fillStyle = C.paper; x.font = '500 22px ' + sans; x.fillText('Extrato IA · Comunidade Maestros da IA', 56, H - 32);
      x.textAlign = 'right'; x.fillText('valores somados lançamento a lançamento', W - 56, H - 32); x.textAlign = 'left';
      try {
        var url = cv.toDataURL('image/png'), bin = atob(url.split(',')[1]), arr = new Uint8Array(bin.length); // COR-064: sync encode
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        downloadBlob(slug(p.nome || periodName(m)) + '-resumo.png', new Blob([arr], { type: 'image/png' }));
        toast('Resumo do mês baixado');
      } catch (e) { toast('Não consegui gerar a imagem.'); }
    };
    if (document.fonts && document.fonts.load) Promise.all(['700 50px "Libre Caslon Text"', '500 22px "Red Hat Text"', '700 40px "Red Hat Mono"'].map(function (f) { return document.fonts.load(f); })).then(go, go); else go();
  }
  function exportRules() {
    var R = loadRules(), n = Object.keys(R).length;
    if (!n) { toast('Ainda não há regras para exportar.'); return; }
    downloadBlob('extrato-ia-regras.json', new Blob([JSON.stringify({ app: 'extrato-ia', v: 1, regras: R }, null, 1)], { type: 'application/json' }));
    toast(plural(n, 'regra exportada', 'regras exportadas'));
  }
  function importRules(file) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast('Arquivo de regras grande demais.'); return; }
    var fr = new FileReader();
    fr.onload = function () {
      var o = tryParse(String(fr.result || '')), R = loadRules(), n = 0;
      var src = o && o.regras && typeof o.regras === 'object' ? o.regras : null;
      if (!src) { toast('Este arquivo não é um backup de regras do Extrato IA.'); return; }
      Object.keys(src).slice(0, 20000).forEach(function (k) {
        var r = src[k]; if (!r || !CAT[r.c] || !/^(in|out):/.test(k) || k.length > 70) return;
        if (R[k] && R[k].s === 'voce' && r.s !== 'voce') return;
        R[k] = { c: r.c, s: r.s === 'voce' ? 'voce' : 'ia', u: Date.now() }; n++;
      });
      saveRules();
      if (state.per && state.per.tx.length) { applyRules(state.per, true); refreshMetrics(); saveNow(); }
      paintAll(); renderRules(); toast(plural(n, 'regra importada', 'regras importadas'));
    };
    fr.readAsText(file, 'utf-8');
    $('rules-file').value = '';
  }

  // ───────────────────────── import ─────────────────────────
  function showImportError(msg) { var e = $('import-error'); e.textContent = msg || ''; e.hidden = !msg; }
  function ensurePeriod() {
    if (!state.per) state.per = newPeriod();
    return state.per;
  }
  function addAccount(info, txs, fileName, raw) {
    var p = ensurePeriod();
    if (p.accounts.length >= MAX_ACCOUNTS) { showImportError('Este mês já tem ' + MAX_ACCOUNTS + ' arquivos. Comece um mês novo para importar mais.'); return null; }
    var acc = info.fp ? p.accounts.filter(function (a) { return a.fp && a.fp === info.fp; })[0] : null;
    var created = false;
    if (!acc) {
      var same = p.accounts.filter(function (a) { return a.banco === info.banco && a.kind === info.kind; }).length;
      acc = { id: uid(), nome: info.banco + (info.kind === 'cartao' ? ' · cartão' : ' · conta') + (same ? ' ' + (same + 1) : ''), banco: info.banco, kind: info.kind, titular: p.modo === 'pf' ? 'pf' : 'pj', fp: info.fp || '', file: fileName, n: 0, saldo: info.saldo == null ? null : info.saldo, saldoAt: info.saldoAt || null, invert: !!info.invert, src: raw ? 'planilha' : 'ofx' };
      p.accounts.push(acc); created = true;
    } else {
      acc.file += ', ' + fileName;
      if (info.saldo != null && (!acc.saldoAt || (info.saldoAt || 0) >= acc.saldoAt)) { acc.saldo = info.saldo; acc.saldoAt = info.saldoAt; }
    }
    if (raw) { state.raws[acc.id] = raw; acc.map = raw.map; }
    var existing = {};
    p.tx.forEach(function (t) {
      var A = p.accounts.filter(function (a) { return a.id === t.a; })[0] || {};
      if (t.fid && t.a === acc.id) existing['f:' + t.fid] = 1;
      if (A.banco === acc.banco && A.kind === acc.kind) existing['x:' + t.a + ':' + t.t + ':' + t.v + ':' + fold(t.d)] = 1;
      if (A.banco === acc.banco && A.kind === acc.kind && t.a !== acc.id) existing['y:' + t.t + ':' + t.v + ':' + fold(t.d)] = 1;
    });
    var added = 0, dup = 0;
    for (var i = 0; i < txs.length; i++) {
      if (p.tx.length >= MAX_TX) break;
      var t = txs[i];
      if ((t.fid && existing['f:' + t.fid]) || (!created && existing['x:' + acc.id + ':' + t.t + ':' + t.v + ':' + fold(t.d)]) || existing['y:' + t.t + ':' + t.v + ':' + fold(t.d)]) { dup++; continue; }
      if (t.fid) existing['f:' + t.fid] = 1;
      p.tx.push({ id: uid() + i, a: acc.id, t: t.t, v: t.v, d: t.d, k: descKey(t.d), fid: t.fid || '', c: '', s: '' });
      added++;
    }
    acc.n += added; p.dupes = (p.dupes || 0) + dup;
    if (!added && created) { p.accounts = p.accounts.filter(function (a) { return a !== acc; }); delete state.raws[acc.id]; }
    return { acc: acc, added: added, dup: dup };
  }
  function finishImport(res, fileName, extraMsg) {
    var p = state.per;
    if (!res) return false;
    if (!res.added) { showImportError(res.dup ? 'Todos os ' + fmtInt(res.dup) + ' lançamentos de “' + fileName + '” já estavam importados (arquivo repetido).' : 'Não encontrei lançamentos em “' + fileName + '”.'); paintAll(); return false; }
    applyRules(p, true);
    refreshMetrics();
    if (!p.nome || /^Extrato de /.test(p.nome)) p.nome = periodName(state.m);
    p.report = null;
    saveNow(); paintAll();
    showImportError(extraMsg || '');
    toast(plural(res.added, 'lançamento importado', 'lançamentos importados') + (res.dup ? ' · ' + plural(res.dup, 'duplicado ignorado', 'duplicados ignorados') : ''));
    return true;
  }
  function loadTable(rows, fileName) {
    if (!rows || rows.length < 2) { showImportError('Não encontrei lançamentos: a planilha precisa da linha de títulos e de pelo menos um lançamento.'); return false; }
    var hr = findHeaderRow(rows);
    rows = rows.slice(hr);
    var headers = rows[0].slice(0, MAX_COLS).map(function (h, i) { return clean(h) || ('Coluna ' + colLetter(i)); });
    var body = rows.slice(1, MAX_ROWS + 1).map(function (r) { var o = []; for (var i = 0; i < headers.length; i++) o.push(String(r[i] == null ? '' : r[i]).slice(0, MAX_CELL)); return o; });
    var raw = { headers: headers, rows: body, file: fileName };
    raw.map = autoMap(raw);
    var src = detectCsvSource(headers, fileName);
    if (src.invert == null) {
      var probe = txFromRaw(raw, raw.map, false).tx, pos = probe.filter(function (t) { return t.v > 0; }).length;
      src.invert = src.kind === 'cartao' && probe.length > 3 && pos / probe.length > 0.7;
    }
    raw.invert = src.invert;
    if (raw.map.data == null || raw.map.descricao == null || (raw.map.valor == null && raw.map.entrada == null && raw.map.saida == null)) {
      // keep it in memory so the member can map the columns by hand
      state.pendingRaw = { raw: raw, src: src };
      state.mapAcc = '';
      paintAll(); openMapping();
      showImportError('Não reconheci todas as colunas de “' + fileName + '”. Indique abaixo qual coluna é a data, a descrição e o valor.');
      return false;
    }
    var res = txFromRaw(raw, raw.map, raw.invert);
    var r = addAccount({ banco: src.banco, kind: src.kind, invert: raw.invert }, res.tx, fileName, raw);
    var sk = res.skipped, warn = [];
    if (sk.semData) warn.push(plural(sk.semData, 'linha sem data ficou', 'linhas sem data ficaram') + ' de fora');
    if (sk.semValor) warn.push(plural(sk.semValor, 'linha sem valor ficou', 'linhas sem valor ficaram') + ' de fora');
    if (body.length >= MAX_ROWS) warn.push('o arquivo passou de ' + fmtInt(MAX_ROWS) + ' linhas — usei as primeiras');
    return finishImport(r, fileName, warn.length ? 'Atenção: ' + warn.join('; ') + '. Confira as colunas em “Extratos”.' : '');
  }
  function remapAccount(accId, map, invert) {
    var p = state.per, raw = state.raws[accId]; if (!raw) return;
    var acc = p.accounts.filter(function (a) { return a.id === accId; })[0]; if (!acc) return;
    raw.map = map; raw.invert = invert; acc.map = map; acc.invert = invert;
    var keep = {}; p.tx.forEach(function (t) { if (t.a === accId && t.c) keep[t.d + '|' + t.t + '|' + Math.abs(t.v)] = { c: t.c, s: t.s }; });
    p.tx = p.tx.filter(function (t) { return t.a !== accId; });
    var res = txFromRaw(raw, map, invert);
    res.tx.forEach(function (t, i) { var k = keep[t.d + '|' + t.t + '|' + Math.abs(t.v)]; p.tx.push({ id: uid() + i, a: accId, t: t.t, v: t.v, d: t.d, k: descKey(t.d), fid: t.fid || '', c: k && k.s === 'voce' ? k.c : '', s: k && k.s === 'voce' ? 'voce' : '' }); });
    acc.n = res.tx.length;
    applyRules(p, true); p.report = null; refreshMetrics(); save(); paintAll();
  }
  function readText(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () {
        var txt = String(fr.result || '');
        if (/�/.test(txt.slice(0, 20000)) || /CHARSET:\s*1252/i.test(txt.slice(0, 400)) && /�/.test(txt)) {
          var fr2 = new FileReader();
          fr2.onload = function () { res(String(fr2.result || '')); };
          fr2.onerror = rej;
          fr2.readAsText(file, 'windows-1252');
          return;
        }
        res(txt);
      };
      fr.onerror = rej;
      fr.readAsText(file, 'utf-8');
    });
  }
  function handleFile(file) {
    if (!file) return Promise.resolve(false);
    if (file.size > 20 * 1024 * 1024) { showImportError('Arquivo grande demais (máx. 20 MB). Exporte um período menor.'); return Promise.resolve(false); }
    var name = file.name || 'arquivo';
    if (/\.pdf$/i.test(name) || /pdf/.test(file.type || '')) { showImportError('Extrato em PDF não dá para ler com precisão. No app do banco, exporte em OFX (Money/Quicken) ou CSV/Excel — veja o passo a passo ao lado.'); return Promise.resolve(false); }
    var isX = /\.(xlsx|xls|xlsm|ods)$/i.test(name);
    var isO = /\.(ofx|qfx)$/i.test(name);
    var isT = /\.(csv|tsv|txt)$/i.test(name) || /text|csv/.test(file.type || '');
    if (!isX && !isO && !isT) { showImportError('Envie o extrato em .OFX, .CSV ou .XLSX.'); return Promise.resolve(false); }
    if (isX) {
      return new Promise(function (resolve) {
        var frx = new FileReader();
        frx.onload = function () {
          ensureXLSX().then(function () {
            var rows;
            try { rows = rowsFromWorkbook(new Uint8Array(frx.result)); } catch (e) { showImportError('Não consegui ler esta planilha do Excel. Tente exportar em .csv ou .ofx.'); resolve(false); return; }
            resolve(loadTable(rows, name));
          }).catch(function () { showImportError('Não consegui carregar o leitor de Excel. Tente de novo ou envie em .csv/.ofx.'); resolve(false); });
        };
        frx.onerror = function () { showImportError('Não consegui ler o arquivo.'); resolve(false); };
        frx.readAsArrayBuffer(file);
      });
    }
    return readText(file).then(function (txt) {
      if (isO || /<OFX>/i.test(txt.slice(0, 3000))) {
        var o = parseOFX(txt);
        if (!o || !o.tx.length) { showImportError('Este OFX não tem lançamentos que eu consiga ler.'); return false; }
        return finishImport(addAccount(o, o.tx, name, null), name, '');
      }
      return loadTable(parseCSV(txt), name);
    }).catch(function () { showImportError('Não consegui ler o arquivo.'); return false; });
  }
  function handleFiles(list) {
    var files = Array.prototype.slice.call(list || []);
    if (!files.length || state.running) return;
    showImportError('');
    files.reduce(function (pr, f) { return pr.then(function () { return handleFile(f); }); }, Promise.resolve()).then(function () { $('file-input').value = ''; });
  }
  function loadPasted() {
    var t = $('in-paste').value;
    if (!t.trim()) { toast('Cole as linhas do extrato primeiro.'); return; }
    if (/<OFX>/i.test(t)) { var o = parseOFX(t); if (o && o.tx.length && finishImport(addAccount(o, o.tx, 'extrato colado', null), 'extrato colado', '')) $('in-paste').value = ''; return; }
    if (loadTable(parseCSV(t), 'extrato colado')) $('in-paste').value = '';
  }
  function loadExample() {
    if (state.running) return;
    if (state.per && state.per.tx.length) { startNew(true); }
    var p = ensurePeriod();
    p.negocio = 'Estúdio de edição de vídeo e cursos online para criadores (MEI). Vende cursos na Hotmart/Kiwify e presta serviço de edição por Pix.';
    Promise.all([fetch('samples/exemplo-conta-pj.ofx').then(function (r) { if (!r.ok) throw new Error(); return r.text(); }), fetch('samples/exemplo-fatura-cartao.csv').then(function (r) { if (!r.ok) throw new Error(); return r.text(); })]).then(function (res) {
      var o = parseOFX(res[0]);
      addAccount(o, o.tx, 'exemplo-conta-pj.ofx', null);
      loadTable(parseCSV(res[1]), 'exemplo-fatura-cartao.csv');
      p.nome = 'Exemplo — Estúdio de vídeo, setembro';
      saveNow(); paintAll();
    }).catch(function () { showImportError('Não consegui carregar o exemplo. Tente de novo.'); });
  }
  function refreshMetrics() {
    var p = state.per;
    state.m = p && p.tx && p.tx.length ? compute(p) : null;
    state.cmp = null;
    if (p && p.compareId && p.compareId !== p.id) {
      var o = getPeriod(p.compareId);
      if (o && o.tx && o.tx.length) { state.cmp = compute(o); state.cmp.__nome = o.nome || periodName(state.cmp); }
      else p.compareId = '';
    }
  }

  // ───────────────────────── rendering ─────────────────────────
  function hasData() { return !!(state.per && state.per.tx && state.per.tx.length); }
  function gotoTab(name) {
    document.querySelectorAll('.tab').forEach(function (t) { var on = t.getAttribute('data-tab') === name; t.classList.toggle('on', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); });
    document.querySelectorAll('.pane').forEach(function (pn) { pn.classList.toggle('on', pn.id === 'pane-' + name); });
    if (name === 'extratos') renderIntake();
    if (name === 'lancamentos') renderTx();
    if (name === 'painel') renderDash();
    if (name === 'relatorio') renderReport();
    if (name === 'arquivo') { renderArchive(); renderRules(); }
    var main = document.querySelector('.app-main'); if (main && main.getBoundingClientRect().top < 0) main.scrollIntoView({ block: 'start' });
  }
  function renderHeader() {
    var pill = $('period-pill'), p = state.per;
    if (hasData() && state.m) { pill.textContent = shortTxt(p.nome || periodName(state.m), 44) + ' · ' + plural(state.m.n, 'lançamento', 'lançamentos'); pill.hidden = false; } else pill.hidden = true;
    var pend = hasData() && state.m ? state.m.semCat : 0, badge = $('tab-badge');
    badge.textContent = pend ? fmtInt(pend) : ''; badge.hidden = !pend;
  }
  function optCols(raw, sel) {
    return '<option value="-1">— não tem —</option>' + raw.headers.map(function (h, i) { return '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>' + colLetter(i) + ' · ' + esc(shortTxt(h, 40)) + '</option>'; }).join('');
  }
  function renderIntake() {
    var p = state.per || newPeriod(), has = hasData();
    $('accounts-wrap').hidden = !has && !state.pendingRaw;
    $('in-negocio').value = document.activeElement === $('in-negocio') ? $('in-negocio').value : (p.negocio || '');
    document.querySelectorAll('input[name="modo"]').forEach(function (r) { r.checked = r.value === (p.modo || 'misto'); });
    if (document.activeElement !== $('in-nome')) $('in-nome').value = p.nome || '';
    $('to-lanc').hidden = !has;
    var box = $('accounts');
    box.innerHTML = p.accounts.map(function (a) {
      var txs = p.tx.filter(function (t) { return t.a === a.id; }), tin = 0, tout = 0, t0 = Infinity, t1 = -Infinity;
      txs.forEach(function (t) { if (t.v > 0) tin += t.v; else tout -= t.v; if (t.t < t0) t0 = t.t; if (t.t > t1) t1 = t.t; });
      return '<article class="chq" data-acc="' + esc(a.id) + '"><div class="chq-top"><p class="chq-bank">' + esc(a.banco) + '<span>' + (a.kind === 'cartao' ? 'Fatura de cartão' : 'Conta') + ' · ' + (a.src === 'ofx' ? 'OFX' : 'planilha') + '</span></p><p class="chq-n">' + plural(txs.length, 'lançamento', 'lançamentos') + '</p></div>' +
        '<div class="chq-fields"><div class="field"><label for="acc-nome-' + esc(a.id) + '">Nome desta conta</label><input type="text" id="acc-nome-' + esc(a.id) + '" data-acc-nome="' + esc(a.id) + '" maxlength="40" value="' + esc(a.nome) + '"></div>' +
        '<div class="field"><label for="acc-tit-' + esc(a.id) + '">De quem é</label><select id="acc-tit-' + esc(a.id) + '" data-acc-tit="' + esc(a.id) + '"><option value="pj"' + (a.titular === 'pj' ? ' selected' : '') + '>Da empresa (PJ / MEI)</option><option value="pf"' + (a.titular === 'pf' ? ' selected' : '') + '>Pessoal (PF)</option></select></div></div>' +
        '<p class="chq-line"><span>' + (txs.length ? esc(dmy(t0)) + ' a ' + esc(dmy(t1)) : '—') + '</span><span class="in">+ ' + brl2(tin) + '</span><span class="out">− ' + brl2(tout) + '</span>' + (a.saldo != null ? '<span>saldo ' + brl2(a.saldo) + '</span>' : '') + '</p>' +
        '<p class="chq-micr" aria-hidden="true">⑆ ' + esc(hash(a.id).slice(0, 4).toUpperCase()) + ' ⑆ ' + esc(String(txs.length).padStart(4, '0')) + ' ⑈ ' + esc(fold(a.banco).slice(0, 3).toUpperCase()) + ' ⑈</p>' +
        '<div class="chq-actions">' + (state.raws[a.id] ? '<button type="button" class="btn-ghost btn-sm" data-acc-map="' + esc(a.id) + '">Conferir colunas</button>' : (a.src === 'planilha' ? '<span class="muted small">Para mudar as colunas, importe o arquivo de novo.</span>' : '')) + '<button type="button" class="btn-ghost btn-sm" data-acc-del="' + esc(a.id) + '">Remover</button></div></article>';
    }).join('');
    box.querySelectorAll('[data-acc-nome]').forEach(function (inp) { inp.addEventListener('input', function () { var a = findAcc(inp.getAttribute('data-acc-nome')); if (a) { a.nome = inp.value.slice(0, 40) || a.banco; save(); } }); });
    box.querySelectorAll('[data-acc-tit]').forEach(function (sel) { sel.addEventListener('change', function () { var a = findAcc(sel.getAttribute('data-acc-tit')); if (a) { a.titular = sel.value; p.report = null; applyRules(p, false); refreshMetrics(); save(); renderHeader(); toast('Conta marcada como ' + (sel.value === 'pf' ? 'pessoal' : 'da empresa')); } }); });
    box.querySelectorAll('[data-acc-map]').forEach(function (b) { b.addEventListener('click', function () { state.mapAcc = b.getAttribute('data-acc-map'); state.pendingRaw = null; openMapping(); }); });
    box.querySelectorAll('[data-acc-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (state.running) return;
        var id = b.getAttribute('data-acc-del'), a = findAcc(id); if (!a) return;
        if (!confirm('Remover “' + a.nome + '” e os lançamentos dela deste mês?')) return;
        p.accounts = p.accounts.filter(function (x) { return x.id !== id; }); p.tx = p.tx.filter(function (t) { return t.a !== id; }); delete state.raws[id];
        if (state.mapAcc === id) { state.mapAcc = ''; $('mapping').hidden = true; }
        p.report = null; refreshMetrics();
        if (!p.tx.length) { try { localStorage.setItem(LIST_SLOT, JSON.stringify(loadList().filter(function (x) { return x.id !== p.id; }))); localStorage.removeItem(CURRENT_SLOT); } catch (e) {} }
        else saveNow();
        paintAll(); toast('Arquivo removido');
      });
    });
    var dupe = $('dupe-note'); dupe.hidden = !(p.dupes > 0); dupe.textContent = p.dupes ? plural(p.dupes, 'lançamento repetido entre arquivos foi ignorado', 'lançamentos repetidos entre arquivos foram ignorados') + ' (mesma conta, mesmo dia, mesmo valor e descrição).' : '';
  }
  function findAcc(id) { return state.per.accounts.filter(function (a) { return a.id === id; })[0]; }
  function openMapping() {
    var pr = state.pendingRaw, raw = pr ? pr.raw : state.raws[state.mapAcc];
    var box = $('mapping'); if (!raw) { box.hidden = true; return; }
    box.hidden = false;
    var acc = state.mapAcc ? findAcc(state.mapAcc) : null;
    var map = Object.assign({}, raw.map), invert = !!raw.invert;
    $('map-title').textContent = 'Colunas de “' + shortTxt(raw.file || (acc && acc.file) || 'planilha', 50) + '”';
    $('field-list').innerHTML = FIELDS.map(function (f) {
      var ci = map[f.id], smp = ci != null ? colSample(raw, ci, 3) : [];
      return '<div class="fld' + (f.req && ci == null ? ' fld-missing' : '') + '"><div class="fld-name"><label for="fld-' + f.id + '">' + esc(f.label) + (f.req ? ' <span class="req">*</span>' : '') + '</label>' + (f.note ? '<span class="fld-note">' + esc(f.note) + '</span>' : '') + '</div>' +
        '<select id="fld-' + f.id + '" data-field="' + f.id + '">' + optCols(raw, ci) + '</select>' +
        '<p class="fld-sample">' + (smp.length ? '<b>ex.:</b> ' + esc(smp.map(function (v) { return shortTxt(maskDigits(v) === '#' ? v : v, 30); }).join(' · ')) : '<span class="muted">' + (ci != null ? '(coluna vazia)' : 'sem coluna') + '</span>') + '</p></div>';
    }).join('');
    $('map-invert').checked = invert;
    function preview() {
      var res = txFromRaw(raw, map, $('map-invert').checked), ok = map.data != null && map.descricao != null && (map.valor != null || map.entrada != null || map.saida != null);
      var tin = 0, tout = 0; res.tx.forEach(function (t) { if (t.v > 0) tin += t.v; else tout -= t.v; });
      $('map-preview').innerHTML = ok ? '<b>' + plural(res.tx.length, 'lançamento', 'lançamentos') + '</b> lidos · entradas ' + brl2(tin) + ' · saídas ' + brl2(tout) + (res.skipped.semData + res.skipped.semValor ? ' · ' + plural(res.skipped.semData + res.skipped.semValor, 'linha ficou', 'linhas ficaram') + ' de fora' : '') : 'Escolha pelo menos a data, a descrição e o valor (ou as colunas de entrada e saída).';
      $('map-apply').disabled = !ok || !res.tx.length;
    }
    $('field-list').querySelectorAll('select[data-field]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var f = sel.getAttribute('data-field'), v = parseInt(sel.value, 10);
        Object.keys(map).forEach(function (k) { if (k !== f && map[k] === v) delete map[k]; });
        if (v < 0) delete map[f]; else map[f] = v;
        openMapping.map = map; preview();
        sel.closest('.fld').classList.toggle('fld-missing', !!(FIELDS.filter(function (x) { return x.id === f; })[0].req && v < 0));
      });
    });
    $('map-invert').onchange = preview;
    $('map-apply').onclick = function () {
      var inv = $('map-invert').checked;
      if (pr) {
        raw.map = map; raw.invert = inv;
        var res = txFromRaw(raw, map, inv);
        var r = addAccount({ banco: pr.src.banco, kind: inv ? 'cartao' : pr.src.kind, invert: inv }, res.tx, raw.file, raw);
        state.pendingRaw = null; box.hidden = true;
        finishImport(r, raw.file, '');
      } else { remapAccount(state.mapAcc, map, inv); box.hidden = true; state.mapAcc = ''; toast('Colunas atualizadas'); }
    };
    $('map-cancel').onclick = function () { state.pendingRaw = null; state.mapAcc = ''; box.hidden = true; showImportError(''); renderIntake(); };
    preview();
    box.scrollIntoView({ block: 'nearest' });
  }
  function txFiltered() {
    var p = state.per, q = fold(state.q), out = [];
    p.tx.forEach(function (t) {
      if (state.filter === 'sem' && t.c) return;
      if (state.filter === 'ia' && t.s !== 'ia') return;
      if (state.filter === 'voce' && t.s !== 'voce' && t.s !== 'regra') return;
      if (state.filter === 'auto' && t.s !== 'auto') return;
      if (state.facc && t.a !== state.facc) return;
      if (state.fcat && t.c !== state.fcat) return;
      if (q && fold(t.d).indexOf(q) === -1 && fold(CAT[t.c] ? CAT[t.c].label : '').indexOf(q) === -1) return;
      out.push(t);
    });
    return out.sort(function (a, b) { return b.t - a.t || Math.abs(b.v) - Math.abs(a.v); });
  }
  function renderTx() {
    var has = hasData();
    $('tx-empty').hidden = has; $('tx-wrap').hidden = !has;
    if (!has) return;
    var p = state.per, all = p.tx;
    var cnt = { todos: all.length, sem: 0, ia: 0, voce: 0, auto: 0 };
    all.forEach(function (t) { if (!t.c) cnt.sem++; if (t.s === 'ia') cnt.ia++; if (t.s === 'voce' || t.s === 'regra') cnt.voce++; if (t.s === 'auto') cnt.auto++; });
    document.querySelectorAll('[data-filter]').forEach(function (b) { var f = b.getAttribute('data-filter'); b.classList.toggle('on', state.filter === f); b.setAttribute('aria-pressed', state.filter === f ? 'true' : 'false'); b.querySelector('.n').textContent = fmtInt(cnt[f]); });
    var pend = pendingGroups();
    if (!state.running) {
      $('cat-ai').textContent = pend.length ? 'Categorizar com IA (' + plural(pend.length, 'descrição nova', 'descrições novas') + ')' : 'Tudo categorizado';
      $('cat-ai').disabled = !pend.length;
    }
    var R = loadRules(), known = Object.keys(R).length;
    $('cat-hint').textContent = (cnt.voce + cnt.ia + cnt.auto ? fmtInt(all.length - cnt.sem) + ' de ' + fmtInt(all.length) + ' já categorizados' + (known ? ' (' + plural(known, 'regra aprendida', 'regras aprendidas') + ' neste navegador)' : '') + '. ' : '') + (pend.length ? 'A IA recebe só a descrição de cada lançamento novo — sem número de conta, CPF ou saldo.' : 'Corrija o que precisar: cada escolha vira regra para os próximos meses.');
    var accSel = $('f-acc'); accSel.innerHTML = '<option value="">Todas as contas</option>' + p.accounts.map(function (a) { return '<option value="' + esc(a.id) + '"' + (a.id === state.facc ? ' selected' : '') + '>' + esc(a.nome) + '</option>'; }).join('');
    var catSel = $('f-cat'); catSel.innerHTML = '<option value="">Todas as categorias</option>' + CATS.map(function (c) { return '<option value="' + c.id + '"' + (c.id === state.fcat ? ' selected' : '') + '>' + esc(c.label) + '</option>'; }).join('');
    var list = txFiltered(), shown = list.slice(0, state.shown);
    var accs = {}; p.accounts.forEach(function (a) { accs[a.id] = a; });
    $('tx-count').textContent = list.length === all.length ? plural(list.length, 'lançamento', 'lançamentos') : plural(list.length, 'lançamento', 'lançamentos') + ' neste filtro (de ' + fmtInt(all.length) + ')';
    $('tx-body').innerHTML = shown.length ? shown.map(function (t) {
      var a = accs[t.a] || {}, src = t.s ? '<span class="stamp st-' + t.s + '">' + SRC_LABEL[t.s] + '</span>' : '<span class="stamp st-none">A definir</span>';
      return '<tr class="' + (t.c ? '' : 'pending') + '"><td class="d">' + dm(t.t) + '</td><td class="desc"><span class="desc-t">' + esc(shortTxt(t.d, 90)) + '</span><span class="desc-acc">' + esc(a.nome || '') + (t.sub ? ' · recorrente' : '') + '</span></td><td class="num ' + (t.v < 0 ? 'out' : 'in') + '">' + (t.v < 0 ? '− ' : '+ ') + NF2.format(Math.abs(t.v)) + '</td><td class="catc"><select data-tx="' + esc(t.id) + '" aria-label="Categoria de ' + esc(shortTxt(t.d, 40)) + '">' + catOptions(t.c, t.v >= 0 ? 'in' : 'out') + '</select></td><td class="srcc">' + src + '</td></tr>';
    }).join('') : '<tr><td colspan="5" class="muted center">Nenhum lançamento neste filtro.</td></tr>';
    $('tx-more').hidden = list.length <= state.shown;
    $('tx-more').textContent = 'Mostrar mais ' + Math.min(PAGE, list.length - state.shown) + ' (de ' + fmtInt(list.length - state.shown) + ' restantes)';
    $('tx-body').querySelectorAll('select[data-tx]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var id = sel.getAttribute('data-tx'), t = p.tx.filter(function (x) { return x.id === id; })[0]; if (!t) return;
        var n = setCategory(t, sel.value, $('apply-all').checked);
        refreshMetrics(); save(); renderHeader();
        var keepScroll = window.scrollY; renderTx(); window.scrollTo(0, keepScroll);
        toast(sel.value ? (n > 1 ? plural(n, 'lançamento igual atualizado', 'lançamentos iguais atualizados') + ' · regra salva' : 'Categoria salva') : 'Categoria removida');
      });
    });
  }
  function renderCompareSelect(sel) {
    var p = state.per, list = loadList().filter(function (x) { return x.id !== p.id && x.tx && x.tx.length; });
    sel.innerHTML = '<option value="">Não comparar</option>' + list.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === p.compareId ? ' selected' : '') + '>' + esc(shortTxt(x.nome || 'Mês sem nome', 56)) + '</option>'; }).join('');
    sel.disabled = !list.length;
    return list.length;
  }
  function renderDash() {
    var has = hasData() && state.m;
    $('dash-empty').hidden = has; $('dash').hidden = !has;
    if (!has) return;
    var m = state.m, c = state.cmp;
    var n = renderCompareSelect($('cmp-select'));
    $('cmp-note').textContent = n ? (c ? 'Comparando com “' + c.__nome + '”.' : 'Escolha um mês salvo para ver a variação.') : 'Importe o extrato de outro mês para comparar — cada mês fica salvo em “Meses e regras”.';
    $('ticker').innerHTML = tickerHTML(m, c);
    $('dash-blocks').innerHTML = dashboardHTML(m, c); fixW($('dash-blocks'));
  }
  function renderReportHint() {
    if (state.running) return;
    var r = state.per && state.per.report;
    $('report-hint').textContent = r ? 'Mudou categorias ou a comparação? Reescreva para atualizar o texto.' : 'Leva de 15 a 60 segundos. Só os totais do mês vão para a IA — nenhum lançamento individual.';
  }
  function renderReport() {
    var has = hasData() && state.m;
    $('report-empty').hidden = has; $('report-wrap').hidden = !has;
    if (!has) return;
    if (window.ApiKeyManager) { var ms = $('model-select'); if (ms && !ms.options.length) ApiKeyManager.renderModelPicker('model-select'); }
    renderCompareSelect($('cmp-select-r'));
    $('report').innerHTML = reportInnerHTML(); fixW($('report'));
    if (!state.running) $('summary-btn').textContent = state.per.report ? 'Reescrever a análise' : 'Escrever a análise';
    var pend = state.m.semCat;
    $('report-pending').hidden = !pend;
    $('report-pending').textContent = pend ? plural(pend, 'lançamento ainda está', 'lançamentos ainda estão') + ' sem categoria e fora do DRE (' + brl2(state.m.semCatV) + '). Categorize na aba Lançamentos para o fechamento ficar completo.' : '';
    renderReportHint();
  }
  function renderArchive() {
    var list = loadList(), cur = state.per && state.per.id, box = $('archive');
    if (!list.length) { box.innerHTML = '<div class="empty"><p class="empty-title">Nenhum mês salvo ainda.</p><p>Importe um extrato — ele é guardado aqui automaticamente, só neste navegador.</p></div>'; return; }
    box.innerHTML = list.map(function (x) {
      var mm = x.tx && x.tx.length ? compute(x) : null, d = new Date(x.updatedAt || x.createdAt);
      return '<article class="arch-card' + (x.id === cur ? ' current' : '') + '"><p class="arch-kicker">' + esc((x.accounts || []).map(function (a) { return a.banco; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(' · ') || 'Extrato') + ' · atualizado em ' + pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear() + '</p><h3 class="arch-name">' + esc(x.nome || 'Mês sem nome') + '</h3>' +
        (mm ? '<p class="arch-nums">' + (mm.temPJ ? '<span><b>' + esc(brl(mm.dre.receita)) + '</b> receita</span><span><b class="' + (mm.dre.resultado < 0 ? 'neg' : '') + '">' + esc(brl(mm.dre.resultado)) + '</b> sobrou</span>' : '<span><b>' + esc(brl(mm.entradas)) + '</b> entradas</span><span><b>' + esc(brl(mm.saidas)) + '</b> saídas</span>') + '<span><b>' + fmtInt(mm.n) + '</b> lançamentos</span></p><p class="arch-meta">' + esc(dmy(mm.start)) + ' a ' + esc(dmy(mm.end)) + (x.report ? ' · com análise' : '') + (mm.semCat ? ' · ' + fmtInt(mm.semCat) + ' sem categoria' : '') + '</p>' : '') +
        '<div class="arch-actions">' + (x.id === cur ? '<span class="tag">Aberto agora</span>' : '<button type="button" class="btn-secondary btn-sm" data-open="' + esc(x.id) + '">Abrir</button>' + (cur && hasData() ? '<button type="button" class="btn-ghost btn-sm" data-cmp="' + esc(x.id) + '">Comparar com o aberto</button>' : '')) + '<button type="button" class="btn-ghost btn-sm" data-delete="' + esc(x.id) + '">Excluir</button></div></article>';
    }).join('');
    box.querySelectorAll('[data-open]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (state.running) return; saveNow();
        var x = getPeriod(b.getAttribute('data-open')); if (!x) return;
        state.per = x; state.raws = {}; state.pendingRaw = null; state.mapAcc = ''; resetFilters();
        try { localStorage.setItem(CURRENT_SLOT, x.id); } catch (e) {}
        refreshMetrics(); paintAll(); gotoTab('painel'); toast('Mês aberto');
      });
    });
    box.querySelectorAll('[data-cmp]').forEach(function (b) {
      b.addEventListener('click', function () { state.per.compareId = b.getAttribute('data-cmp'); refreshMetrics(); saveNow(); gotoTab('painel'); toast('Comparação ligada'); });
    });
    box.querySelectorAll('[data-delete]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (state.running) return;
        var id = b.getAttribute('data-delete'), x = getPeriod(id);
        if (!confirm('Excluir “' + ((x && x.nome) || 'mês sem nome') + '” deste navegador? As regras aprendidas continuam.')) return;
        try { localStorage.setItem(LIST_SLOT, JSON.stringify(loadList().filter(function (y) { return y.id !== id; }))); } catch (e) {}
        if (state.per && state.per.compareId === id) state.per.compareId = '';
        if (state.per && state.per.id === id) { state.per = newPeriod(); state.raws = {}; try { localStorage.removeItem(CURRENT_SLOT); } catch (e) {} }
        refreshMetrics(); paintAll(); renderArchive(); toast('Mês excluído');
      });
    });
  }
  function renderRules() {
    var R = loadRules(), keys = Object.keys(R), q = fold($('rules-q').value);
    $('rules-count').textContent = keys.length ? plural(keys.length, 'regra aprendida', 'regras aprendidas') + ' (' + fmtInt(keys.filter(function (k) { return R[k].s === 'voce'; }).length) + ' suas, ' + fmtInt(keys.filter(function (k) { return R[k].s === 'ia'; }).length) + ' da IA).' : 'Nenhuma regra ainda. Cada categoria que você ou a IA escolher vira uma regra aqui.';
    var list = keys.filter(function (k) { return !q || k.indexOf(q) > -1 || fold(CAT[R[k].c] ? CAT[R[k].c].label : '').indexOf(q) > -1; }).sort(function (a, b) { return (R[b].u || 0) - (R[a].u || 0); }).slice(0, 200);
    $('rules-list').innerHTML = list.length ? list.map(function (k) {
      return '<li><span class="rl-dir ' + (k.indexOf('in:') === 0 ? 'in' : 'out') + '">' + (k.indexOf('in:') === 0 ? 'entrada' : 'saída') + '</span><span class="rl-k">' + esc(k.replace(/^(in|out):/, '')) + '</span><span class="rl-c">' + esc(CAT[R[k].c] ? CAT[R[k].c].label : R[k].c) + '</span><span class="stamp st-' + (R[k].s === 'voce' ? 'voce' : 'ia') + '">' + (R[k].s === 'voce' ? 'Você' : 'IA') + '</span><button type="button" class="btn-ghost btn-sm" data-rule-del="' + esc(k) + '" aria-label="Apagar regra ' + esc(k.replace(/^(in|out):/, '')) + '">Apagar</button></li>';
    }).join('') : (keys.length ? '<li class="muted">Nenhuma regra com esse termo.</li>' : '');
    $('rules-list').querySelectorAll('[data-rule-del]').forEach(function (b) { b.addEventListener('click', function () { delete loadRules()[b.getAttribute('data-rule-del')]; saveRules(); renderRules(); toast('Regra apagada (os lançamentos já categorizados não mudam)'); }); });
  }
  function resetFilters() { state.filter = 'todos'; state.facc = ''; state.fcat = ''; state.q = ''; state.shown = PAGE; var s = $('f-q'); if (s) s.value = ''; }
  function paintAll() {
    renderHeader(); renderIntake();
    if (state.pendingRaw || state.mapAcc) { /* mapping panel keeps its own state */ } else $('mapping').hidden = true;
    if ($('pane-lancamentos').classList.contains('on')) renderTx();
    if ($('pane-painel').classList.contains('on')) renderDash();
    if ($('pane-relatorio').classList.contains('on')) renderReport();
    if ($('pane-arquivo').classList.contains('on')) { renderArchive(); renderRules(); }
  }
  function startNew(silent) {
    if (state.running) return;
    saveNow(); state.per = newPeriod(); state.raws = {}; state.pendingRaw = null; state.mapAcc = ''; state.m = null; state.cmp = null; resetFilters();
    try { localStorage.removeItem(CURRENT_SLOT); } catch (e) {}
    showImportError(''); paintAll(); if (!silent) gotoTab('extratos');
  }
  function onCompareChange(sel) {
    state.per.compareId = sel.value; refreshMetrics(); saveNow();
    if ($('pane-painel').classList.contains('on')) renderDash(); else renderReport();
  }

  // ───────────────────────── init ─────────────────────────
  function init() {
    if (state.wired) { if (window.ApiKeyManager) { var s0 = $('model-select'); if (s0 && !s0.options.length) ApiKeyManager.renderModelPicker('model-select'); } renderTx(); return; }
    state.wired = true;
    var cur = null; try { cur = localStorage.getItem(CURRENT_SLOT); } catch (e) {}
    state.per = (cur && getPeriod(cur)) || newPeriod();
    refreshMetrics();

    if (window.ApiKeyManager) ApiKeyManager.renderModelPicker('model-select'); // COR-041/047

    document.querySelectorAll('.tab').forEach(function (b) { b.addEventListener('click', function () { gotoTab(b.getAttribute('data-tab')); }); });
    document.querySelectorAll('[data-goto]').forEach(function (b) { b.addEventListener('click', function () { gotoTab(b.getAttribute('data-goto')); }); });

    var dz = $('dropzone'), fi = $('file-input');
    fi.addEventListener('change', function () { handleFiles(fi.files); });
    ['dragenter', 'dragover'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('drag'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('drag'); }); });
    dz.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });
    $('paste-load').addEventListener('click', loadPasted);
    $('example-btn').addEventListener('click', loadExample);
    $('in-nome').addEventListener('input', function () { ensurePeriod().nome = this.value.slice(0, 100); save(); renderHeader(); });
    $('in-negocio').addEventListener('input', function () { ensurePeriod().negocio = this.value.slice(0, 400); save(); });
    document.querySelectorAll('input[name="modo"]').forEach(function (r) {
      r.addEventListener('change', function () {
        var p = ensurePeriod(); p.modo = r.value;
        if (r.value !== 'misto') p.accounts.forEach(function (a) { a.titular = r.value; });
        p.report = null; refreshMetrics(); save(); renderIntake();
      });
    });
    $('to-lanc').addEventListener('click', function () { saveNow(); gotoTab('lancamentos'); });

    $('cat-ai').addEventListener('click', runCategorize);
    $('cat-stop').addEventListener('click', function () { if (state.ctl) state.ctl.abort(); state.running = false; });
    document.querySelectorAll('[data-filter]').forEach(function (b) { b.addEventListener('click', function () { state.filter = b.getAttribute('data-filter'); state.shown = PAGE; renderTx(); }); });
    $('f-acc').addEventListener('change', function () { state.facc = this.value; state.shown = PAGE; renderTx(); });
    $('f-cat').addEventListener('change', function () { state.fcat = this.value; state.shown = PAGE; renderTx(); });
    var qT = null; $('f-q').addEventListener('input', function () { var v = this.value; clearTimeout(qT); qT = setTimeout(function () { state.q = v; state.shown = PAGE; renderTx(); }, 180); });
    $('tx-more').addEventListener('click', function () { state.shown += PAGE; renderTx(); });
    $('to-painel').addEventListener('click', function () { saveNow(); gotoTab('painel'); });

    $('cmp-select').addEventListener('change', function () { onCompareChange(this); });
    $('cmp-select-r').addEventListener('change', function () { onCompareChange(this); });
    $('summary-btn').addEventListener('click', generateSummary);
    $('dl-pdf').addEventListener('click', function () { window.print(); });
    $('dl-xlsx').addEventListener('click', exportXLSX);
    $('dl-html').addEventListener('click', exportHTML);
    $('dl-png').addEventListener('click', exportPNG);
    $('dl-csv').addEventListener('click', exportCSV);
    $('new-period').addEventListener('click', function () { startNew(false); });
    $('rules-q').addEventListener('input', renderRules);
    $('rules-export').addEventListener('click', exportRules);
    $('rules-file').addEventListener('change', function () { importRules(this.files && this.files[0]); });

    // COR-062: logout must leave the login form empty for the next person
    var lo = $('logout-btn');
    if (lo) lo.addEventListener('click', function () {
      var em = $('gate-email'), ph = $('gate-phone'), er = $('gate-error');
      if (em) em.value = ''; if (ph) ph.value = ''; if (er) { er.textContent = ''; er.style.display = 'none'; }
    });
    $('wipe-local').addEventListener('click', function () {
      if (state.running) { toast('Aguarde a IA terminar.'); return; }
      if (!confirm('Apagar deste navegador todos os meses, regras aprendidas, análises, a sua chave de IA e a sua sessão? Isso não pode ser desfeito.')) return;
      state.wiping = true;
      try {
        var drop = [];
        for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (/^(extrato|maestria_)/.test(k)) drop.push(k); }
        drop.forEach(function (k) { localStorage.removeItem(k); });
      } catch (e) {}
      location.reload();
    });
    window.addEventListener('beforeunload', function () { if (!state.wiping) saveNow(); });

    paintAll();
    if (hasData()) gotoTab(state.m && state.m.semCat ? 'lancamentos' : 'painel');
  }

  return { init: init, _t: { parseCSV: parseCSV, parseOFX: parseOFX, autoMap: autoMap, txFromRaw: txFromRaw, descKey: descKey, maskDigits: maskDigits, autoCat: autoCat, compute: compute, parseMoney: parseMoney, parseDate: parseDate, detectCsvSource: detectCsvSource, buildFacts: function (m, c) { return buildFacts(m, c); }, checkNumbers: checkNumbers, CATS: CATS } };
})();

// ── App init triggers: event + DOMContentLoaded + MutationObserver (COR-044) ──
(function () {
  var started = false;
  function go() { if (started) { App.init(); return; } started = true; App.init(); }
  document.addEventListener('maestria:app-ready', go);
  document.addEventListener('DOMContentLoaded', function () {
    var app = document.getElementById('app-screen');
    if (app && app.classList.contains('active')) { setTimeout(go, 100); }
    if (app) {
      var mo = new MutationObserver(function () { if (app.classList.contains('active')) go(); });
      mo.observe(app, { attributes: true, attributeFilter: ['class'] });
    }
  });
})();
