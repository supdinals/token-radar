// Token Radar dashboard: renders window.RADAR (written beside this folder by
// main.ts) as a sortable, filterable board plus a per-protocol detail view
// with the value model's full breakdown and the farm plan as a checklist.
// Static and offline: no fetch, no imports, every byte shown comes from data.js.
(function () {
  'use strict';
  var D = window.RADAR;
  if (!D) return;
  var app = document.getElementById('app');
  var S = { q: '', cat: 'all', chain: 'all', watch: false, sort: 'rank', dir: 1, slug: null };

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtPct(n) { return n === null || n === undefined ? 'n/a' : (n > 0 ? '+' : '') + n.toFixed(2) + '%'; }
  function fmtX(n) { return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '.0') + 'x'; }
  function fmtAge(d) {
    if (d === null || d === undefined) return 'unknown';
    if (d >= 365) return (d / 365).toFixed(1) + 'y (' + d + 'd)';
    return d + 'd';
  }
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) node.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) node.appendChild(x); });
      else node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function readHash() {
    var p = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    S.slug = p.get('p'); S.q = p.get('q') || '';
    S.cat = p.get('category') || 'all'; S.chain = p.get('chain') || 'all';
    S.watch = p.get('watch') === '1';
  }
  function writeHash() {
    var p = new URLSearchParams();
    if (S.slug) p.set('p', S.slug);
    if (S.q) p.set('q', S.q);
    if (S.cat !== 'all') p.set('category', S.cat);
    if (S.chain !== 'all') p.set('chain', S.chain);
    if (S.watch) p.set('watch', '1');
    var s = p.toString();
    window.history.replaceState(null, '', s ? '#' + s : window.location.pathname + window.location.search);
  }
  function go(patch) { Object.assign(S, patch); writeHash(); render(); window.scrollTo(0, 0); }

  function visibleRows() {
    var q = S.q.trim().toLowerCase();
    return D.rows.filter(function (r) {
      if (S.cat !== 'all' && (r.category || 'Other') !== S.cat) return false;
      if (S.chain !== 'all' && r.chains.indexOf(S.chain) < 0) return false;
      if (S.watch && !r.watchlist) return false;
      if (!q) return true;
      return [r.name, r.slug, r.category || '', r.chains.join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }
  function sorted(list) {
    var k = S.sort, dir = S.dir;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (k === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (k === 'cat') { av = (a.category || '').toLowerCase(); bv = (b.category || '').toLowerCase(); }
      else if (k === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (k === 'chg') { av = a.change_7d === null ? -1e9 : a.change_7d; bv = b.change_7d === null ? -1e9 : b.change_7d; }
      else if (k === 'ratio') { av = a.implied_value_usd / a.tvl_usd; bv = b.implied_value_usd / b.tvl_usd; }
      else if (k === 'implied') { av = a.implied_value_usd; bv = b.implied_value_usd; }
      else { av = a.rank; bv = b.rank; }
      if (av < bv) return -dir; if (av > bv) return dir;
      return a.rank - b.rank;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('span', { class: 'scope' }),
      el('div', { class: 'brand' }, 'TOKEN RADAR', el('small', { text: 'pre-token launch board · model ' + D.model_version })),
      el('div', { class: 'top-meta' },
        el('div', { text: 'snapshot ' + D.as_of + ' · DefiLlama' }),
        el('div', { text: D.protocol_count + ' protocols scanned · ' + D.tokened_count + ' already tokened (comparables)' })));
  }
  function stats() {
    var top = D.rows[0];
    function stat(label, value) { return el('div', { class: 'stat' }, el('span', { text: label }), el('b', { text: value })); }
    return el('section', { class: 'stats' },
      stat('Board rows', String(D.board_size)),
      stat('Watchlist covered', D.watchlist_size + ' / ' + D.watchlist_size),
      stat('Early rows below $50M floor', String(D.early_size)),
      stat('Global median mcap/TVL', fmtX(D.global_median_multiple)),
      stat('Top implied · ' + (top ? top.name : ''), top ? fmtUsd(top.implied_value_usd) : 'n/a'));
  }
  function controls() {
    var cats = Array.from(new Set(D.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(D.rows.reduce(function (a, r) { return a.concat(r.chains); }, []))).sort();
    var search = el('input', { type: 'search', placeholder: 'Search name, slug, category, chain', value: S.q, 'aria-label': 'Search the board' });
    var timer = null;
    search.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { S.q = search.value; writeHash(); renderTable(); }, 120);
    });
    function select(id, label, values, current, allLabel) {
      var sel = el('select', { id: id, 'aria-label': label }, el('option', { value: 'all', text: allLabel }));
      values.forEach(function (v) {
        var o = el('option', { value: v, text: v });
        if (v === current) o.setAttribute('selected', 'selected');
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () {
        if (id === 'fcat') S.cat = sel.value; else S.chain = sel.value;
        writeHash(); renderTable();
      });
      return el('div', { class: 'field' }, el('label', { for: id, text: label }), sel);
    }
    var watchBox = el('input', { type: 'checkbox', id: 'fwatch' });
    if (S.watch) watchBox.setAttribute('checked', 'checked');
    watchBox.addEventListener('change', function () { S.watch = watchBox.checked; writeHash(); renderTable(); });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'fq', text: 'Search' }), search),
      select('fcat', 'Category', cats, S.cat, 'All categories'),
      select('fchain', 'Chain', chains, S.chain, 'All chains'),
      el('label', { class: 'check' }, watchBox, ' Watchlist only'),
      el('span', { class: 'count', id: 'rowcount' }));
  }
  function sortTh(key, label) {
    var arrow = S.sort === key ? (S.dir === 1 ? ' ↑' : ' ↓') : '';
    return el('th', { scope: 'col' }, el('button', { type: 'button', onclick: function () {
      if (S.sort === key) S.dir = -S.dir; else { S.sort = key; S.dir = key === 'rank' || key === 'name' || key === 'cat' ? 1 : -1; }
      renderTable();
    } }, label + arrow));
  }
  function boardPanel() {
    return el('div', { class: 'panel' }, el('div', { class: 'twrap', id: 'twrap' }));
  }
  function renderTable() {
    var wrap = document.getElementById('twrap');
    if (!wrap) return;
    var count = document.getElementById('rowcount');
    var list = sorted(visibleRows());
    if (count) count.textContent = list.length + ' of ' + D.board_size + ' rows';
    wrap.textContent = '';
    if (list.length === 0) {
      wrap.appendChild(el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category or chain.' }),
        el('button', { class: 'btn', type: 'button', text: 'Clear filters', onclick: function () { go({ q: '', cat: 'all', chain: 'all', watch: false }); } })));
      return;
    }
    var max = Math.max.apply(null, list.map(function (r) { return r.implied_value_usd; }));
    var tbody = el('tbody');
    list.forEach(function (r) {
      var tr = el('tr', { tabindex: '0', onclick: function () { go({ slug: r.slug }); },
        onkeydown: function (e) { if (e.key === 'Enter') go({ slug: r.slug }); } },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', { class: 'pname' }, el('b', { text: r.name }),
          el('span', { class: 'pill pre', text: 'PRE-TOKEN' }),
          r.watchlist ? el('span', { class: 'pill wl', text: '★ WATCHLIST' }) : null,
          el('span', { class: 'sub', text: r.slug + ' · ' + (r.chains.slice(0, 3).join(', ') || 'no chains listed') })),
        el('td', { text: r.category || 'Other' }),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', null, el('span', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round(r.implied_value_usd / max * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })),
        el('td', { class: 'num', text: fmtX(r.implied_value_usd / r.tvl_usd) }));
      tbody.appendChild(tr);
    });
    wrap.appendChild(el('table', null,
      el('caption', { text: 'Pre-token protocols ranked by implied value. Protocols whose token already trades are never rows: they are the comparables that price this board. Select a row for its model breakdown and farm plan.' }),
      el('thead', null, el('tr', null,
        sortTh('rank', 'Rank'), sortTh('name', 'Protocol'), sortTh('cat', 'Category'),
        sortTh('tvl', 'TVL'), sortTh('chg', '7d'), sortTh('implied', 'Implied value'), sortTh('ratio', 'Impl/TVL'))),
      tbody));
  }
  function modelPanel() {
    var c = D.constants;
    var top = D.categories.slice(0, 10);
    var tbody = el('tbody');
    top.forEach(function (x) {
      tbody.appendChild(el('tr', null,
        el('td', { text: x.category }),
        el('td', { class: 'num', text: String(x.comparables) }),
        el('td', { class: 'num', text: fmtX(x.median_multiple) }),
        el('td', { class: 'num', text: fmtX(x.multiple) })));
    });
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is derived — from this snapshot, not from a name list' }),
      el('div', { class: 'formula', text: 'implied = TVL x category multiple x momentum x maturity · category multiple = median mcap/TVL of tokened peers, shrunk toward the global median (' + fmtX(D.global_median_multiple) + ') by n/(n+' + c.shrink_prior_weight + '), clamped ' + c.multiple_floor + 'x-' + c.multiple_cap + 'x · momentum = 1 + clamp(7d change, ' + c.growth_floor_pct + '%, +' + c.growth_cap_pct + '%) x ' + c.momentum_weight + ' · maturity = ' + c.maturity_base + ' + ' + c.maturity_range + ' x min(age days, ' + c.maturity_days + ') / ' + c.maturity_days }),
      el('p', { text: 'Every protocol that already records a token contributes its market-cap/TVL ratio as one comparable. Medians ignore the outliers a mean would chase; shrinkage keeps a category with one or two comparables honest. The board holds all ' + D.watchlist_size + ' watchlist protocols at or above the $50M floor plus the ' + D.early_size + ' strongest pre-token protocols below it.' }),
      el('table', { class: 'mult' },
        el('thead', null, el('tr', null,
          el('th', { text: 'Category' }), el('th', { text: 'Tokened peers' }), el('th', { text: 'Median mcap/TVL' }), el('th', { text: 'Multiple used' }))),
        tbody));
  }
  function boardView() {
    var frag = document.createDocumentFragment();
    var wrap = el('div', { class: 'wrap' });
    wrap.appendChild(header()); wrap.appendChild(stats()); wrap.appendChild(controls());
    wrap.appendChild(boardPanel()); wrap.appendChild(modelPanel());
    wrap.appendChild(el('p', { class: 'foot', text: 'Implied value is this model\u2019s claim, not a price prediction. Farm plans are generated per protocol from its category, chains, TVL tier and track record.' }));
    frag.appendChild(wrap);
    app.appendChild(frag);
    renderTable();
  }

  function detailView(r) {
    var wrap = el('div', { class: 'wrap' });
    wrap.appendChild(header());
    wrap.appendChild(el('div', { class: 'dhead' },
      el('div', null,
        el('button', { class: 'back', type: 'button', text: '← back to the board', onclick: function () { go({ slug: null }); } }),
        el('h1', null, r.name + ' ',
          el('span', { class: 'pill pre', text: 'PRE-TOKEN' }),
          r.watchlist ? el('span', { class: 'pill wl', text: '★ WATCHLIST' }) : null),
        el('p', { class: 'sub', text: 'rank #' + r.rank + ' of ' + D.board_size + ' · ' + (r.category || 'Other') + ' · ' + (r.chains.join(', ') || 'no chains listed') }))));
    var facts = el('div', { class: 'dpanel' }, el('h2', { text: 'The record' }),
      el('div', { class: 'kv' },
        el('span', { text: 'TVL' }), el('b', { text: fmtUsd(r.tvl_usd) }),
        el('span', { text: 'TVL change, 7 days' }), el('b', { text: fmtPct(r.change_7d) }),
        el('span', { text: 'Tracked since' }), el('b', { text: r.listed_at || 'not reported' }),
        el('span', { text: 'Age with no token on record' }), el('b', { text: fmtAge(r.age_days) }),
        el('span', { text: 'Chains' }), el('b', { text: String(r.chains.length) }),
        el('span', { text: 'Implied value' }), el('b', { text: fmtUsd(r.implied_value_usd) }),
        el('span', { text: 'Implied / TVL' }), el('b', { text: fmtX(r.implied_value_usd / r.tvl_usd) })));
    var m = r.model;
    var catRow = D.categories.filter(function (x) { return x.category === r.category; })[0];
    function mrow(label, value) { return el('div', { class: 'row' }, el('span', { text: label }), el('b', { text: value })); }
    var math = el('div', { class: 'dpanel' }, el('h2', { text: 'Implied value — the math' }),
      el('div', { class: 'math' },
        mrow('TVL', fmtUsd(r.tvl_usd)),
        mrow('x category multiple (' + (r.category || 'global') + ')', fmtX(m.category_multiple)),
        mrow('  from ' + m.comparables + ' tokened peers, median ' + (catRow ? fmtX(catRow.median_multiple) : fmtX(D.global_median_multiple)) + ', shrunk to global ' + fmtX(D.global_median_multiple), ''),
        mrow('= base value', fmtUsd(m.base_value_usd)),
        mrow('x momentum (7d ' + fmtPct(r.change_7d) + ', clamped)', 'x' + m.momentum_factor.toFixed(3)),
        mrow('x maturity (' + fmtAge(r.age_days) + ' with no token)', 'x' + m.maturity_factor.toFixed(3)),
        el('div', { class: 'row total' }, el('span', { text: '= implied value' }), el('b', { text: fmtUsd(r.implied_value_usd) }))),
      el('p', { class: 'note', text: 'Same function, same constants for every row on the board — model ' + D.model_version + '. The multiple comes from protocols whose token already trades; this protocol records no token, so its value is the model\u2019s estimate, never a market price.' }));
    var steps = el('ol', { class: 'steps' }, r.farm_steps.map(function (s, i) {
      var box = el('input', { type: 'checkbox', id: 'step' + i });
      return el('li', null, box, el('label', { for: 'step' + i, text: s }));
    }));
    var plan = el('div', { class: 'dpanel' }, el('h2', { text: 'Farm plan — ' + r.farm_steps.length + ' steps' }), steps,
      el('p', { class: 'note', text: 'Tick steps off as you work them. Amounts are scaled to this protocol\u2019s TVL tier; adjust to your own risk, and never farm with funds you cannot lock up.' }));
    var grid = el('div', { class: 'dgrid' },
      el('div', null, facts, el('div', { style: 'height:14px' }), math),
      plan);
    wrap.appendChild(grid);
    wrap.appendChild(el('p', { class: 'foot', text: 'Snapshot ' + D.as_of + ' · slug ' + r.slug + ' · figures are the snapshot\u2019s own, the value is the model\u2019s.' }));
    app.appendChild(wrap);
  }

  function render() {
    app.textContent = '';
    if (S.slug) {
      var row = D.rows.filter(function (r) { return r.slug === S.slug; })[0];
      if (row) { detailView(row); app.setAttribute('aria-busy', 'false'); return; }
      S.slug = null;
    }
    boardView();
    app.setAttribute('aria-busy', 'false');
  }
  readHash();
  render();
  window.addEventListener('hashchange', function () { readHash(); render(); });
})();
