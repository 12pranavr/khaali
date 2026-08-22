// khaali live — booking client. All berth state comes from the server; this file
// never decides what is available, it only renders what the server says and
// re-fetches whenever the server pushes a change.
const $ = s => document.querySelector(s);
const api = (p, o) => fetch(p, o).then(async r => {
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || j.reason || r.statusText), { body: j, status: r.status });
  return j;
});

const S = {
  meta: null, from: 5, to: 13, cls: 'SL', pax: 1,
  train: null, picks: [], av: null, page: 'search',
  who: localStorage.getItem('khaali-who') || ('phone-' + Math.random().toString(36).slice(2, 6)),
};
localStorage.setItem('khaali-who', S.who);

// ---------------------------------------------------------------- theme -----
const applyTheme = on => {
  document.documentElement.setAttribute('data-theme', on ? 'dark' : 'light');
  localStorage.setItem('khaali-theme', on ? 'dark' : 'light');
  $('#theme').textContent = on ? '☀' : '☾';
};
$('#theme').onclick = () => applyTheme(document.documentElement.getAttribute('data-theme') !== 'dark');
applyTheme(localStorage.getItem('khaali-theme')
  ? localStorage.getItem('khaali-theme') === 'dark'
  : matchMedia('(prefers-color-scheme:dark)').matches);

// ----------------------------------------------------------------- pages ----
const PAGES = ['search', 'trains', 'berths', 'done', 'live'];
function show(page) {
  S.page = page;
  PAGES.forEach(p => $('#pg' + p[0].toUpperCase() + p.slice(1)).classList.toggle('hidden', p !== page));
  $('#bar').classList.toggle('hidden', !(page === 'berths' && S.picks.length));
  scrollTo(0, 0);
}
const banner = (el, cls, html) => { $(el).innerHTML = html ? `<div class="banner ${cls}">${html}</div>` : ''; };

// ------------------------------------------------------------------ boot ----
(async function boot() {
  S.meta = await api('/api/meta');
  $('#who').textContent = S.who;

  const opts = sel => S.meta.stations.map(s => `<option value="${s.i}">${s.n}</option>`).join('');
  $('#from').innerHTML = opts(); $('#to').innerHTML = opts();
  $('#from').value = S.from; $('#to').value = S.to;
  $('#cls').innerHTML = S.meta.classes.map(c => `<option value="${c.k}">${c.label}</option>`).join('');
  $('#pax').innerHTML = [1, 2, 3, 4].map(n => `<option value="${n}">${n} passenger${n > 1 ? 's' : ''}</option>`).join('');

  $('#go').onclick = doSearch;
  $('#backSearch').onclick = () => show('search');
  $('#backTrains').onclick = () => { S.picks = []; doSearch(); };
  $('#again').onclick = () => { S.picks = []; S.train = null; show('search'); };
  $('#pay').onclick = doHold;

  $('#liveBtn').onclick = () => { S.backTo = S.page === 'live' ? S.backTo : S.page; openLive(); };
  $('#backFromLive').onclick = () => { stopLive(); show(S.backTo || 'search'); };

  live();
})();

// ------------------------------------------------------- live train board ---
let liveTimer = null;
const stopLive = () => { clearInterval(liveTimer); liveTimer = null; };

async function openLive() {
  show('live');
  await drawLive();
  stopLive();
  liveTimer = setInterval(drawLive, 5000);      // trains move; keep it honest
}

async function drawLive() {
  if (S.page !== 'live') return stopLive();
  const d = await api('/api/live');
  const running = d.trains.filter(t => t.state === 'run').length;
  $('#liveClock').textContent =
    `${d.clock} · ${running} of ${d.trains.length} trains moving right now · corridor is ${d.corridorKm} km`;

  const pct = km => (km / d.corridorKm) * 100;
  const major = new Set([0, 5, 11, 13]);
  const glyph = t => (t.dir === 1 ? '▶' : '◀');

  $('#corridor').innerHTML = `<div class="track">
    <div class="rail"></div>
    ${d.stations.map(s => `<div class="tick ${major.has(s.i) ? 'major' : ''}" style="left:${pct(s.km)}%"></div>`).join('')}
    ${d.stations.filter(s => major.has(s.i)).map(s =>
      `<div class="tlabel major" style="left:${pct(s.km)}%">${s.c}</div>`).join('')}
    ${d.stations.filter(s => !major.has(s.i)).map(s =>
      `<div class="tlabel" style="left:${pct(s.km)}%">${s.c}</div>`).join('')}
    ${d.trains.filter(t => t.state === 'run').map(t =>
      `<div class="tr" style="left:${pct(t.km)}%" title="${t.name}">
         <b>${t.no}</b><i>${glyph(t)}</i></div>`).join('')}
  </div>`;

  $('#liveList').innerHTML = d.trains.map(t => {
    const runNow = t.state === 'run';
    return `<div class="lrow">
      <span class="dot ${runNow ? 'run' : 'idle'}"></span>
      <div style="flex:1;min-width:170px">
        <div style="font-weight:700">${t.name} <span class="muted">${t.no}</span></div>
        <div class="muted">${t.originName} → ${t.destName} · ${t.stops} stops · dep ${t.departs}</div>
      </div>
      <div style="flex:1;min-width:190px" class="muted">${runNow
        ? `Moving · at km ${t.km} · left ${t.atName} · reaches <b>${t.nextName}</b> in ${t.nextEtaMin} min`
          + (t.delay ? ` · <span style="color:var(--accent)">running ${t.delay} min late</span>` : ' · on time')
        : `Not running · departs ${t.departs} from ${t.originName}, in ${fmtWait(t.startsInMin)}`}</div>
      ${runNow ? `<div class="prog"><i style="width:${(t.prog * 100).toFixed(1)}%"></i></div>` : ''}
    </div>`;
  }).join('');
}

const fmtWait = m => m == null ? '—'
  : m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;

// ------------------------------------------------------------- live feed ----
function live() {
  const es = new EventSource('/api/events');
  es.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'tick' || m.type === 'hello') return;
    // somebody else held, released or booked something — refresh what we're looking at
    if (S.page === 'berths' && S.train) refreshBerths(true);
    else if (S.page === 'trains') doSearch(true);
  };
  es.onerror = () => { /* browser retries automatically */ };
}

// ---------------------------------------------------------------- search ----
async function doSearch(quiet) {
  S.from = +$('#from').value; S.to = +$('#to').value;
  S.cls = $('#cls').value; S.pax = +$('#pax').value;
  if (S.from === S.to) return banner('#searchMsg', 'err', 'Pick two different stations.');
  banner('#searchMsg', '', '');

  const r = await api(`/api/search?from=${S.from}&to=${S.to}&cls=${S.cls}&date=${S.meta.today}`);
  if (r.noDirect) {
    show('search');
    return banner('#searchMsg', 'err',
      `No direct train runs ${r.fromName} → ${r.toName}. This is one of the 25 pairs with no through service.`);
  }
  $('#trainsTitle').textContent = `${r.fromName} → ${r.toName}`;
  $('#trainsSub').textContent = `${r.trains.length} train${r.trains.length > 1 ? 's' : ''} · ${r.km} km · counts are for your two stations`;
  $('#trainList').innerHTML = r.trains.map(t => {
    const liveTag = t.live.state === 'run'
      ? `<span class="pill live">running · at ${t.live.atName}${t.live.delay ? ` · +${t.live.delay}m` : ''}</span>`
      : '<span class="pill" style="background:var(--line2);color:var(--ink3)">not running now</span>';
    return `<div class="train" data-no="${t.no}">
      <div class="tname">${t.name}</div><div class="tno">${t.no} · runs daily</div>
      <div class="times">
        <div><b>${t.dep || '—'}</b><div class="muted">Pf ${t.platFrom}</div></div>
        <div class="dur">${fmtDur(t.durMin)}<i></i></div>
        <div><b>${t.arr || '—'}</b><div class="muted">Pf ${t.platTo}</div></div>
      </div>
      <div class="pills">
        <span class="pill free">${t.counts.free} free your whole way</span>
        <span class="pill part">${t.counts.part} partial</span>
        ${t.counts.locked ? `<span class="pill lock">${t.counts.locked} being paid for</span>` : ''}
        ${liveTag}
      </div>
      <div style="margin-top:11px"><button class="btn pick" data-no="${t.no}">₹${t.price} · choose berths</button></div>
    </div>`;
  }).join('');
  $('#trainList').querySelectorAll('.pick').forEach(b => {
    b.onclick = () => { S.train = b.dataset.no; S.picks = []; openBerths(); };
  });
  if (!quiet || S.page === 'search') show('trains');
}

const fmtDur = m => m == null ? '—' : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;

// ---------------------------------------------------------------- berths ----
async function openBerths() { await refreshBerths(); show('berths'); }

async function refreshBerths(quiet) {
  const av = await api(`/api/availability?train=${S.train}&cls=${S.cls}&from=${S.from}&to=${S.to}&date=${S.meta.today}`);
  S.av = av;

  // drop any pick the server no longer considers free
  const before = S.picks.length;
  S.picks = S.picks.filter(i => av.berths.find(b => b.idx === i)?.k === 'free');
  if (S.picks.length !== before) {
    banner('#berthMsg', 'lock', 'Someone else took a berth you had selected. It has been removed.');
  } else if (!quiet) banner('#berthMsg', '', '');

  const st = S.meta.stations;
  $('#berthTitle').textContent = `${S.train} · ${st[S.from].n} → ${st[S.to].n}`;
  $('#berthSub').textContent =
    `${av.counts.free} free your whole way · ${av.counts.part} partial · ${av.counts.locked} being paid for · `
    + `${av.pack.freed} more would open if the chart were repacked · ₹${av.price} each`;

  // legend, with the real price range for partials on this journey
  const partPrices = av.berths.filter(b => b.k === 'part').map(b => b.price);
  const lo = partPrices.length ? Math.min(...partPrices) : null;
  const hi = partPrices.length ? Math.max(...partPrices) : null;
  $('#legend').innerHTML = `
    <div><span class="sw" style="border-color:var(--ok)"></span>
      <span style="flex:1"><b>Free your whole way</b><br><span class="muted">Nobody is on it while you travel</span></span>
      <b style="flex:none">₹${av.price}</b></div>
    <div><span class="sw" style="border-color:var(--warn);border-style:dashed"></span>
      <span style="flex:1"><b>Covers part of your trip</b><br><span class="muted">Priced for the distance you actually get</span></span>
      <b style="flex:none">${lo == null ? '—' : (lo === hi ? '₹' + lo : '₹' + lo + '–' + hi)}</b></div>
    <div><span class="sw" style="border-color:var(--lock);background:var(--lock-bg)"></span>
      <span style="flex:1"><b>Being paid for</b><br><span class="muted">Locked by someone else right now</span></span></div>
    <div><span class="sw" style="background:var(--line2)"></span>
      <span style="flex:1"><b>Taken</b><br><span class="muted">Someone rides it across your whole stretch</span></span>
      <b style="flex:none;color:var(--ink3)">—</b></div>`;

  const byCoach = {};
  av.berths.forEach(b => { (byCoach[b.coach] ||= []).push(b); });
  $('#coaches').innerHTML = Object.entries(byCoach).map(([cid, list]) => {
    const n = list.reduce((a, b) => (a[b.k]++, a), { free: 0, part: 0, taken: 0, locked: 0 });
    return `<div class="coach">
      <div class="coachhead"><b>COACH ${cid}</b><i></i>
        <span class="muted">${n.free} free · ${n.part} partial · ${n.locked} locked · ${n.taken} taken</span></div>
      <div class="grid">${list.map(b => {
        const mine = S.picks.includes(b.idx);
        const dis = b.k === 'taken' || b.k === 'locked';
        const title = b.k === 'locked' ? 'Someone is paying for this right now'
          : b.k === 'part' ? `₹${b.price} · yours for ${b.km} of ${av.km} km (${b.mode === 'from' ? 'free from' : 'yours until'} ${st[b.at]?.n || ''})`
          : b.k === 'taken' ? 'Taken across your whole stretch'
          : `₹${b.price} · ${b.type} · free your whole way`;
        return `<button class="b ${mine ? 'mine' : b.k}" data-i="${b.idx}" ${dis ? 'disabled' : ''} title="${title}">${b.no}</button>`;
      }).join('')}</div></div>`;
  }).join('');

  $('#coaches').querySelectorAll('.b:not([disabled])').forEach(el => {
    el.onclick = () => {
      const i = +el.dataset.i;
      const at = S.picks.indexOf(i);
      if (at >= 0) S.picks.splice(at, 1);
      else { if (S.picks.length >= S.pax) S.picks.shift(); S.picks.push(i); }
      refreshBerths(true);
    };
  });

  const ready = S.picks.length === S.pax;
  const chosen = S.picks.map(i => av.berths.find(x => x.idx === i)).filter(Boolean);
  const total = chosen.reduce((a, b) => a + (b.price || 0), 0);
  const partials = chosen.filter(b => b.k === 'part');

  $('#bar').classList.toggle('hidden', !S.picks.length);
  $('#barTitle').textContent = chosen.map(b => `${b.coach}/${b.no}`).join(', ');
  $('#barSub').innerHTML = ready
    ? `<b>₹${total}</b> for ${S.pax}`
      + (partials.length ? ` · <span style="color:var(--warn)">${partials.length} partial, `
          + `not ticketed for ${Math.max(...partials.map(b => av.km - b.km))} km</span>` : '')
      + ` · locked for 5 minutes once you continue`
    : `Pick ${S.pax - S.picks.length} more`;
  $('#pay').disabled = !ready;
  $('#pay').textContent = ready ? `Hold & pay ₹${total}` : 'Hold & pay';
}

// ------------------------------------------------------------------ hold ----
async function doHold() {
  $('#pay').disabled = true;
  try {
    const r = await api('/api/hold', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        train: S.train, cls: S.cls, from: S.from, to: S.to,
        berthIdxs: S.picks, pax: S.pax, who: S.who, date: S.meta.today,
      }),
    });
    location.href = '/pay/' + r.hold.id;
  } catch (e) {
    $('#pay').disabled = false;
    banner('#berthMsg', 'lock',
      e.status === 409
        ? 'Too slow — someone else just took one of those berths. Pick again.'
        : 'Could not hold those berths: ' + e.message);
    refreshBerths(true);
  }
}

// coming back from a successful payment
const done = new URLSearchParams(location.search).get('pnr');
if (done) {
  api('/api/booking/' + done).then(b => {
    $('#dPnr').textContent = b.pnr;
    $('#dBody').innerHTML =
      `${b.berths.join(', ')} · ${b.pax} passenger${b.pax > 1 ? 's' : ''} · ₹${b.amount} paid`;
    show('done');
  }).catch(() => {});
}
