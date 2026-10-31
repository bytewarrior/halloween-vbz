/* Halloween in Vbz: Oberfläche, Karte, GPS, Abhaken, Import, Neuplanung. */
(function () {
  'use strict';
  const C = window.Core;
  const LS_KEY = 'suesses-route-v1';
  const BOUNDS = L.latLngBounds(window.VZ_DATA.bounds);
  const ARRIVE_M = 20, LEAVE_M = 40, TRACK_ACC = 35, TRACK_STEP = 6;

  // ------------------------------------------------------------- Zustand
  const state = Object.assign({
    stops: [],        // {id, key, label, note, lat, lon, approx, visited, visitedAt}
    order: [],        // IDs der offenen Stopps in geplanter Reihenfolge
    start: null,      // {lat, lon, label}
    roundtrip: true,
    dark: true,
    arrive: true,
    track: [],        // [[lat, lon, t]]
    started: false,   // „Los“ gedrückt: ab jetzt wird von der aktuellen Position aus geplant
    nextId: 1,
  }, load());

  function load() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; }
  }
  let saveTimer = null;
  function save(now) {
    clearTimeout(saveTimer);
    const run = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* voll/gesperrt */ } };
    if (now) run(); else saveTimer = setTimeout(run, 1500);
  }

  const byId = id => state.stops.find(s => s.id === id);
  const openStops = () => state.stops.filter(s => !s.visited);
  const doneStops = () => state.stops.filter(s => s.visited).sort((a, b) => a.visitedAt - b.visitedAt);

  // Gesnappte Routing-Punkte zwischenspeichern (Suche des nächsten Knotens kostet etwas)
  const snapCache = new Map();
  function pt(o) {
    const k = o.lat.toFixed(6) + ',' + o.lon.toFixed(6);
    let p = snapCache.get(k);
    if (!p) { p = C.snap({ lat: o.lat, lon: o.lon }); snapCache.set(k, p); }
    return Object.assign({}, p, { id: o.id });
  }

  // ------------------------------------------------------------- Karte
  const $ = id => document.getElementById(id);
  const map = L.map('map', { zoomControl: false }).fitBounds(BOUNDS);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, crossOrigin: true,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  const trackLine = L.polyline([], { color: '#b794f6', weight: 5, opacity: .9 }).addTo(map);
  const routeLine = L.polyline([], { color: '#ff7a18', weight: 5, opacity: .75, dashArray: '2 9', lineCap: 'round' }).addTo(map);
  const nextLine = L.polyline([], { color: '#ffd23f', weight: 6, opacity: .95 }).addTo(map);
  const markers = L.layerGroup().addTo(map);
  let startMarker = null, meMarker = null, accCircle = null;

  // ------------------------------------------------------------- GPS
  let gps = null, follow = true, pickMode = null;

  function gpsUsable() {
    return gps && Date.now() - gps.t < 120000 && gps.acc <= 60 &&
      BOUNDS.pad(1).contains([gps.lat, gps.lon]);
  }
  function anchor() {
    if (gpsUsable()) return pt(gps);
    const d = doneStops();
    if (d.length) return pt(d[d.length - 1]);
    return state.start ? pt(state.start) : null;
  }
  const endPt = () => (state.roundtrip && state.start ? pt(state.start) : null);

  function onPos(p) {
    const c = p.coords;
    gps = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, t: Date.now() };
    const ll = [gps.lat, gps.lon];
    if (!meMarker) {
      meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me">👻</div>', iconSize: [40, 40], iconAnchor: [20, 20] }), zIndexOffset: 1000, interactive: false }).addTo(map);
      accCircle = L.circle(ll, { radius: gps.acc, color: '#b794f6', weight: 1, fillOpacity: .08, interactive: false }).addTo(map);
    } else {
      meMarker.setLatLng(ll);
      accCircle.setLatLng(ll).setRadius(gps.acc);
    }
    if (follow) map.panTo(ll, { animate: true });

    if (gps.acc <= TRACK_ACC) {
      const last = state.track[state.track.length - 1];
      if (!last || C.haversine(gps, { lat: last[0], lon: last[1] }) >= TRACK_STEP) {
        state.track.push([+gps.lat.toFixed(6), +gps.lon.toFixed(6), Math.round(gps.t / 1000)]);
        trackLine.addLatLng(ll);
        save();
      }
    }
    if (!state.start && gpsUsable() && gps.acc <= 50) {
      state.start = { lat: gps.lat, lon: gps.lon, label: 'Startpunkt (GPS)' };
      toast('🏠 Start = eure aktuelle Position');
      if (!walkStarted()) replanFull();
      renderAll();
    } else if (!walkStarted() && state.start && state.stops.length && gpsUsable() && gps.acc <= TRACK_ACC &&
               C.haversine(gps, state.start) > 50) {
      // „Hier starten“ vergessen und einfach losgegangen
      state.started = true;
      autoReplan(true);
      save(true);
      renderAll();
      toast('🎃 Runde gestartet – die Route folgt euch jetzt. Start falsch? ⚙️ Mehr → Startpunkt', 6000);
    } else if (walkStarted() && autoReplan(false)) {
      renderAll();
    } else {
      scheduleRoute();
    }
    checkArrival();
    renderStats();
  }
  function onPosErr(e) {
    if (e.code === 1) toast('Standort ist gesperrt – bitte in Chrome für diese Seite erlauben.', 6000);
    renderStats();
  }
  if ('geolocation' in navigator) {
    navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 3000, timeout: 30000 });
  }

  // Bildschirm anlassen, solange die App sichtbar ist
  let wakeLock = null;
  function requestWake() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || wakeLock) return;
    navigator.wakeLock.request('screen').then(w => {
      wakeLock = w;
      w.addEventListener('release', () => { wakeLock = null; });
    }).catch(() => {});
  }
  document.addEventListener('visibilitychange', requestWake);
  document.addEventListener('click', requestWake, { once: true });
  requestWake();

  // ------------------------------------------------------------- Planung
  function replanFull() {
    const items = openStops().map(pt);
    const a = doneStops().length ? anchor() : (state.start ? pt(state.start) : anchor());
    state.order = C.optimize(a, items, endPt()).map(p => p.id);
    save();
  }
  function insertStops(ids) {
    let order = state.order.map(id => pt(byId(id)));
    const a = anchor(), e = endPt();
    for (const id of ids) order = C.insertCheapest(a, order, e, pt(byId(id)));
    state.order = order.map(p => p.id);
    save();
  }
  // Vor dem Start wird ab dem Startpunkt geplant, danach ab der aktuellen Position.
  const walkStarted = () => state.started || doneStops().length > 0;

  // Restroute ab der aktuellen Position neu optimieren (abgehakte Häuser bleiben fest).
  // Übernommen wird nur ein echter Gewinn, damit die Route nicht bei GPS-Zittern springt.
  let lastAuto = 0;
  function autoReplan(force) {
    if (state.order.length < 1 || (!force && Date.now() - lastAuto < 8000)) return false;
    lastAuto = Date.now();
    const a = anchor(), e = endPt();
    const cur = state.order.map(id => pt(byId(id)));
    const len = order => C.pathLength((a ? [a] : []).concat(order, e ? [e] : []));
    const curLen = len(cur);
    let best = C.optimize(a, cur, e, true);           // aktuelle Reihenfolge verbessern
    const fresh = C.optimize(a, cur, e);              // komplett neu
    if (len(fresh) < len(best)) best = fresh;
    const gain = curLen - len(best);
    if (gain <= (force ? 10 : Math.max(40, curLen * 0.015))) return false;
    const oldNext = state.order[0];
    state.order = best.map(p => p.id);
    save();
    if (!force && state.order[0] !== oldNext) toast(`🔀 Route angepasst – nächstes Ziel: ${byId(state.order[0]).label}`, 4000);
    return true;
  }

  function addStops(list) {
    const ids = [];
    for (const s of list) {
      if (s.key && state.stops.some(x => x.key === s.key)) continue;
      const stop = Object.assign({ id: state.nextId++, visited: false, visitedAt: 0 }, s);
      state.stops.push(stop);
      ids.push(stop.id);
    }
    if (!ids.length) return 0;
    if (walkStarted()) { insertStops(ids); autoReplan(true); } else replanFull();
    renderAll();
    if (!walkStarted()) fitAll();
    return ids.length;
  }
  function checkOff(id) {
    const s = byId(id);
    if (!s || s.visited) return;
    s.visited = true;
    s.visitedAt = Date.now();
    state.order = state.order.filter(x => x !== id);
    dismissed.add(id);
    state.started = true;
    autoReplan(true);
    save(true);
    renderAll();
    const left = openStops().length;
    toast(left ? `🍬 ${s.label} abgehakt` : '🎉 Alle Häuser geschafft! Ab nach Hause.', 5000, 'Rückgängig', () => uncheck(id));
  }
  function uncheck(id) {
    const s = byId(id);
    if (!s || !s.visited) return;
    s.visited = false;
    s.visitedAt = 0;
    state.order.unshift(id);
    save(true);
    renderAll();
  }
  function removeStop(id) {
    const s = byId(id);
    if (!s || !confirm(`„${s.label}“ entfernen?`)) return;
    state.stops = state.stops.filter(x => x.id !== id);
    state.order = state.order.filter(x => x !== id);
    map.closePopup();
    save(true);
    renderAll();
  }

  // ------------------------------------------------------------- Zeichnen
  let routeTimer = null, lastAnchorNode = -1;
  function scheduleRoute() {
    const a = anchor();
    if (a && a.node === lastAnchorNode) return;
    clearTimeout(routeTimer);
    routeTimer = setTimeout(renderRoute, 300);
  }
  let remaining = 0;
  function renderRoute() {
    const a = anchor(), e = endPt();
    lastAnchorNode = a ? a.node : -1;
    const seq = (a ? [a] : []).concat(state.order.map(id => pt(byId(id))), e ? [e] : []);
    if (seq.length < 2) {
      routeLine.setLatLngs([]); nextLine.setLatLngs([]); remaining = 0; renderStats();
      return;
    }
    const legs = [];
    for (let i = 0; i + 1 < seq.length; i++) legs.push(C.legCoords(seq[i], seq[i + 1]));
    // Erste Etappe hervorheben, wenn sie vom aktuellen Standort ausgeht
    const firstIsNext = !!a;
    nextLine.setLatLngs(firstIsNext ? legs[0] : []);
    routeLine.setLatLngs((firstIsNext ? legs.slice(1) : legs).reduce((acc, l) => acc.concat(l), []));
    remaining = C.pathLength(seq);
    renderStats();
  }

  function icon(html, cls, size) {
    return L.divIcon({ className: '', html: `<div class="pin ${cls}">${html}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2] });
  }
  const markerById = new Map();
  function renderMarkers() {
    markers.clearLayers();
    markerById.clear();
    const pos = new Map(state.order.map((id, i) => [id, i + 1]));
    for (const s of state.stops) {
      const n = pos.get(s.id);
      const cls = [s.visited ? 'done' : '', n === 1 ? 'next' : '', s.approx && !s.visited ? 'approx' : ''].join(' ');
      const html = s.visited ? '🍬' : `🎃<b>${n || '?'}</b>`;
      const m = L.marker([s.lat, s.lon], { icon: icon(html, cls, 40), draggable: false, zIndexOffset: s.visited ? -100 : 100 - (n || 0) });
      m.bindPopup(() => popupHtml(s), { autoPanPaddingTopLeft: [10, 70], autoPanPaddingBottomRight: [10, 80] });
      m.on('dragend', () => {
        m.dragging.disable();
        const ll = m.getLatLng();
        s.lat = ll.lat; s.lon = ll.lng; s.approx = false;
        save(true);
        renderAll();
        toast(`📌 ${s.label} verschoben`);
      });
      markers.addLayer(m);
      markerById.set(s.id, m);
    }
    if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
    if (state.start) {
      startMarker = L.marker([state.start.lat, state.start.lon], { icon: icon('🏠', 'start', 36), zIndexOffset: -200 })
        .bindPopup(`<div class="popup-title">🏠 Start</div><div class="popup-note">${esc(state.start.label || '')}</div>`)
        .addTo(map);
    }
  }
  // Google-Maps-Suche nach der Adresse, Kartenausschnitt um die geschätzte Lage
  function mapsLink(s) {
    return `https://www.google.com/maps/search/${encodeURIComponent(s.label)}/@${s.lat.toFixed(5)},${s.lon.toFixed(5)},18z`;
  }
  function popupHtml(s) {
    const n = state.order.indexOf(s.id) + 1;
    return `<div class="popup-title">${s.visited ? '🍬' : '🎃 ' + n + '.'} ${esc(s.label)}</div>` +
      (s.note ? `<div class="popup-note">${esc(s.note)}</div>` : '') +
      (s.approx && !s.visited ? '<div class="popup-note">⚠️ Lage geschätzt – mit „Verschieben“ korrigieren.</div>' +
        (/^pt:/.test(s.key || '') ? '' : `<a class="popup-link" target="_blank" rel="noopener" href="${mapsLink(s)}">🗺️ In Google Maps ansehen</a>`) : '') +
      '<div class="popup-actions">' +
      (s.visited ? `<button data-act="uncheck" data-id="${s.id}">↺ Zurück</button>`
        : `<button class="primary" data-act="check" data-id="${s.id}">✓ Abhaken</button>` +
          `<button data-act="move" data-id="${s.id}">📌 Verschieben</button>`) +
      `<button data-act="remove" data-id="${s.id}">🗑️</button></div>`;
  }
  function renderStats() {
    const total = state.stops.length, done = total - openStops().length;
    let html = total ? `🍬 <b>${done}/${total}</b>` : 'Noch keine Adressen';
    if (remaining > 0 && openStops().length) html += ` · noch <b>${(remaining / 1000).toFixed(1).replace('.', ',')} km</b>`;
    html += ' · <span class="ico">📡 </span>' + (gps ? `±${Math.round(gps.acc)} m` : 'kein GPS');
    $('stats').innerHTML = html;
  }
  function renderList() {
    const ul = $('stop-list');
    ul.innerHTML = '';
    const rows = state.order.map((id, i) => ({ s: byId(id), n: i + 1 })).concat(doneStops().map(s => ({ s, n: 0 })));
    for (const { s, n } of rows) {
      const li = document.createElement('li');
      if (s.visited) li.className = 'done';
      li.innerHTML = `<span class="num ${s.visited ? 'done' : n === 1 ? 'next' : ''}">${s.visited ? '✓' : n}</span>` +
        `<div class="main" data-act="goto" data-id="${s.id}"><div class="label">${esc(s.label)}${s.approx ? ' <span class="approx-tag">≈ geschätzt</span>' : ''}</div>` +
        (s.note ? `<div class="note">${esc(s.note)}</div>` : '') + '</div>' +
        (s.visited ? `<button data-act="uncheck" data-id="${s.id}">↺</button>` : `<button data-act="check" data-id="${s.id}">✓</button>`);
      ul.appendChild(li);
    }
    const open = openStops().length;
    $('list-summary').textContent = state.stops.length
      ? `${open} offen, ${state.stops.length - open} erledigt` + (remaining && open ? ` · noch ${(remaining / 1000).toFixed(1).replace('.', ',')} km` : '')
      : 'Noch keine Adressen – über „Adressen“ einfügen.';
  }
  function renderMenu() {
    $('start-info').textContent = state.start ? '🏠 ' + (state.start.label || 'gesetzt') : 'Noch nicht gesetzt – wird beim ersten GPS-Signal eure Position.';
    $('opt-round').checked = state.roundtrip;
    $('opt-dark').checked = state.dark;
    $('opt-arrive').checked = state.arrive;
  }
  function renderStartBar() {
    const show = !walkStarted() && state.stops.length > 0;
    $('startbar').hidden = !show;
    if (!show) return;
    $('startbar-text').textContent = state.start ? '🏠 ' + (state.start.label || 'Startpunkt') : 'Noch kein Startpunkt';
    $('btn-go').hidden = !state.start;
  }
  function renderAll() {
    document.body.classList.toggle('dark', state.dark);
    renderStartBar();
    renderMarkers();
    renderRoute();
    renderList();
    renderMenu();
    renderStats();
  }
  function fitAll() {
    const pts = state.stops.map(s => [s.lat, s.lon]);
    if (state.start) pts.push([state.start.lat, state.start.lon]);
    if (pts.length) {
      follow = false; $('btn-follow').classList.remove('on');
      map.fitBounds(pts, { paddingTopLeft: [30, 70], paddingBottomRight: [30, 90], maxZoom: 17 });
    }
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ------------------------------------------------------------- Ankunft
  const dismissed = new Set();
  let bannerId = null;
  function checkArrival() {
    if (!state.arrive || !gps || gps.acc > TRACK_ACC) return;
    let best = null, bd = Infinity;
    for (const s of openStops()) {
      const d = C.haversine(gps, s);
      if (d > LEAVE_M) dismissed.delete(s.id);
      if (d < bd) { bd = d; best = s; }
    }
    if (best && bd <= ARRIVE_M && !dismissed.has(best.id)) {
      if (bannerId !== best.id) {
        bannerId = best.id;
        $('banner-text').textContent = `🎃 ${best.label}` + (best.note ? ` – ${shortNote(best.note)}` : '');
        $('banner').hidden = false;
        if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
      }
    } else if (bannerId !== null && (!best || best.id !== bannerId || bd > LEAVE_M)) {
      hideBanner();
    }
  }
  function hideBanner() { bannerId = null; $('banner').hidden = true; }
  function shortNote(t) { t = t.replace(/\s+/g, ' '); return t.length > 70 ? t.slice(0, 68) + '…' : t; }
  $('banner-ok').onclick = () => { const id = bannerId; hideBanner(); checkOff(id); };
  $('banner-close').onclick = () => { dismissed.add(bannerId); hideBanner(); };

  // ------------------------------------------------------------- Toast
  let toastTimer = null;
  function toast(text, ms, action, fn) {
    const t = $('toast');
    t.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = text;
    t.appendChild(span);
    if (action) {
      const b = document.createElement('button');
      b.textContent = action;
      b.onclick = () => { t.hidden = true; fn(); };
      t.appendChild(b);
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || 3000);
  }

  // ------------------------------------------------------------- Sheets
  function openSheet(id) {
    document.querySelectorAll('.sheet.open').forEach(s => { if (s.id !== id) s.classList.remove('open'); });
    $(id).classList.toggle('open');
    if (id === 'sheet-list') renderList();
    if (id === 'sheet-menu') renderMenu();
  }
  const closeSheets = () => document.querySelectorAll('.sheet.open').forEach(s => s.classList.remove('open'));
  document.querySelectorAll('[data-sheet]').forEach(b => { b.onclick = () => openSheet(b.dataset.sheet); });
  document.querySelectorAll('.sheet .close').forEach(b => { b.onclick = closeSheets; });

  $('btn-follow').onclick = () => {
    follow = !follow;
    $('btn-follow').classList.toggle('on', follow);
    if (follow && gps) map.setView([gps.lat, gps.lon], Math.max(map.getZoom(), 17));
    else if (follow) toast('Noch kein GPS-Signal …');
  };
  map.on('dragstart', () => { follow = false; $('btn-follow').classList.remove('on'); });

  // Aktionen in Popups und Listen
  document.addEventListener('click', ev => {
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    const id = +el.dataset.id, act = el.dataset.act;
    if (act === 'check') { map.closePopup(); checkOff(id); }
    else if (act === 'uncheck') { map.closePopup(); uncheck(id); }
    else if (act === 'remove') removeStop(id);
    else if (act === 'move') {
      map.closePopup();
      const m = markerById.get(id);
      if (m) { m.dragging.enable(); toast('Kürbis jetzt an die richtige Stelle ziehen.', 5000); }
    }
    else if (act === 'goto') {
      const s = byId(id);
      closeSheets();
      follow = false; $('btn-follow').classList.remove('on');
      map.setView([s.lat, s.lon], 18);
    } else if (act === 'add-here' || act === 'start-here') {
      const lat = +el.dataset.lat, lon = +el.dataset.lon;
      map.closePopup();
      if (act === 'start-here') setStart({ lat, lon, label: 'Auf der Karte gewählt' });
      else {
        const label = 'Punkt ' + (state.stops.length + 1);
        addStops([{ key: 'pt:' + lat.toFixed(5) + ',' + lon.toFixed(5), label, note: '', lat, lon, approx: false }]);
        toast(`➕ ${label} hinzugefügt`);
      }
    }
  });

  // Langes Drücken auf die Karte
  map.on('contextmenu', ev => {
    const { lat, lng } = ev.latlng;
    L.popup().setLatLng(ev.latlng).setContent(
      '<div class="popup-actions">' +
      `<button class="primary" data-act="add-here" data-lat="${lat}" data-lon="${lng}">🎃 Haus hier</button>` +
      `<button data-act="start-here" data-lat="${lat}" data-lon="${lng}">🏠 Start hier</button></div>`).openOn(map);
  });
  map.on('click', ev => {
    if (pickMode !== 'start') return;
    pickMode = null;
    $('map').classList.remove('pick');
    setStart({ lat: ev.latlng.lat, lon: ev.latlng.lng, label: 'Auf der Karte gewählt' });
  });

  // ------------------------------------------------------------- Import
  let found = [];
  const streetList = $('streets');
  C.streets.forEach(n => { const o = document.createElement('option'); o.value = n; streetList.appendChild(o); });

  function detect() {
    const text = $('import-text').value;
    const P = C.parseChat(text);
    const onlyToday = $('only-today').checked && P.hasHeaders;
    // Einzeln kopierte Nachrichten haben keinen Zeitstempel – die immer mitnehmen
    const msgs = onlyToday ? P.msgs.filter(m => !m.date || C.isToday(m.date)) : P.msgs;
    found = [];
    const keys = new Set();
    for (const m of msgs) {
      const ex = C.extract(m.text);
      const note = m.text.replace(/\s+/g, ' ').trim();
      for (const f of ex.found) {
        const key = f.street + '|' + f.hn;
        if (keys.has(key)) continue;
        keys.add(key);
        const g = C.geocode(f.street, f.hn);
        found.push({ key, label: f.streetName + ' ' + f.hn, note, geo: g, time: m.time, dup: state.stops.some(s => s.key === key) });
      }
      for (const f of ex.noNumber) {
        const key = f.street + '|';
        if (keys.has(key)) continue;
        keys.add(key);
        found.push({ key, label: f.streetName + ' (ohne Nr.)', note, geo: C.geocode(f.street, ''), time: m.time, dup: state.stops.some(s => s.key === key), noNum: true });
      }
    }
    const ul = $('import-results');
    ul.innerHTML = '';
    found.forEach((f, i) => {
      const li = document.createElement('li');
      if (f.dup) li.className = 'dup';
      const checked = !f.dup && f.geo && !f.noNum;
      li.innerHTML = `<input type="checkbox" data-i="${i}" ${checked ? 'checked' : ''} ${f.geo ? '' : 'disabled'}>` +
        `<div class="main"><div class="label">${esc(f.label)}` +
        (f.dup ? ' <span class="approx-tag">schon drin</span>' : f.geo && f.geo.approx ? ' <span class="approx-tag">≈ geschätzt</span>' : '') +
        (f.geo ? '' : ' <span class="approx-tag">nicht gefunden</span>') + '</div>' +
        `<div class="note">${f.time ? esc(f.time) + ' · ' : ''}${esc(f.note)}</div></div>`;
      ul.appendChild(li);
    });
    const n = found.filter(f => !f.dup && !f.noNum).length;
    let sum = `${msgs.length} Nachricht${msgs.length === 1 ? '' : 'en'}` + (onlyToday ? ' von heute' : '') +
      ` · ${found.filter(f => !f.noNum).length} Adressen erkannt` + (n ? `, ${n} neu` : '');
    if (onlyToday && !msgs.length && P.msgs.length) sum = 'Keine Nachrichten von heute gefunden – Haken bei „nur heute“ entfernen?';
    $('import-summary').textContent = sum;
    $('btn-apply').hidden = !found.length;
  }
  function applyImport() {
    const list = [];
    $('import-results').querySelectorAll('input[type=checkbox]:checked').forEach(cb => {
      const f = found[+cb.dataset.i];
      if (f && f.geo) list.push({ key: f.key, label: f.label, note: f.note, lat: f.geo.lat, lon: f.geo.lon, approx: f.geo.approx });
    });
    const n = addStops(list);
    toast(n ? `🎃 ${n} Adresse${n === 1 ? '' : 'n'} hinzugefügt` : 'Nichts Neues dabei.');
    if (n) { $('import-text').value = ''; $('import-results').innerHTML = ''; $('import-summary').textContent = ''; $('btn-apply').hidden = true; closeSheets(); }
  }
  // „Straße“ + „Nr.“ aus zwei Eingabefeldern auflösen
  function resolveInput(streetEl, hnEl) {
    const r = C.extract(streetEl.value + ' ' + (hnEl.value || '1'));
    const f = r.found[0];
    if (!f) { toast('Straße nicht gefunden.'); return null; }
    const hn = hnEl.value.trim().toLowerCase().replace(/\s+/g, '');
    const g = C.geocode(f.street, hn);
    if (!g) { toast('Adresse nicht gefunden.'); return null; }
    return { key: f.street + '|' + hn, label: f.streetName + (hn ? ' ' + hn : ''), lat: g.lat, lon: g.lon, approx: g.approx };
  }

  $('btn-detect').onclick = detect;
  $('only-today').onchange = () => { if ($('import-text').value) detect(); };
  $('btn-apply').onclick = applyImport;
  $('btn-paste').onclick = () => {
    if (!navigator.clipboard || !navigator.clipboard.readText) { toast('Bitte lange ins Feld tippen → Einfügen.'); return; }
    navigator.clipboard.readText().then(t => {
      if (!t.trim()) { toast('Die Zwischenablage ist leer – erst in WhatsApp kopieren.', 4000); return; }
      // Anhängen statt ersetzen, damit man in Portionen kopieren kann
      const ta = $('import-text');
      ta.value = ta.value.trim() ? ta.value.replace(/\s+$/, '') + '\n' + t : t;
      ta.scrollTop = ta.scrollHeight;
      detect();
    })
      .catch(() => toast('Kein Zugriff auf die Zwischenablage – lange ins Feld tippen → Einfügen.', 5000));
  };
  $('btn-manual').onclick = () => {
    const r = resolveInput($('manual-street'), $('manual-hn'));
    if (!r) return;
    const n = addStops([Object.assign(r, { note: 'von Hand hinzugefügt' })]);
    toast(n ? `🎃 ${r.label} hinzugefügt` : `${r.label} ist schon drin.`);
    if (n) { $('manual-street').value = ''; $('manual-hn').value = ''; }
  };

  // ------------------------------------------------------------- Losgehen
  function go() {
    state.started = true;
    state.track = [];
    trackLine.setLatLngs([]);
    replanFull();
    save(true);
    renderAll();
    if (gps) { follow = true; $('btn-follow').classList.add('on'); map.setView([gps.lat, gps.lon], 17); }
    toast('🎃 Los geht’s! Viel Spaß beim Süßes-Sammeln.', 4000);
  }
  $('btn-start-here').onclick = () => {
    if (!gpsUsable()) { toast(gps ? 'Ihr seid zu weit weg vom Ort.' : 'Noch kein GPS-Signal …'); return; }
    state.start = { lat: gps.lat, lon: gps.lon, label: 'Hier gestartet' };
    go();
  };
  $('btn-go').onclick = go;

  // ------------------------------------------------------------- Einstellungen
  function setStart(s) {
    state.start = s;
    if (!walkStarted()) replanFull();
    save(true);
    renderAll();
    toast('🏠 Startpunkt gesetzt');
  }
  $('btn-start-gps').onclick = () => {
    if (!gps) { toast('Noch kein GPS-Signal …'); return; }
    setStart({ lat: gps.lat, lon: gps.lon, label: 'Aktuelle Position' });
  };
  $('btn-start-map').onclick = () => {
    pickMode = 'start';
    $('map').classList.add('pick');
    closeSheets();
    toast('Auf die Karte tippen, wo der Start ist.', 5000);
  };
  $('btn-start-addr').onclick = () => {
    const r = resolveInput($('start-street'), $('start-hn'));
    if (r) setStart({ lat: r.lat, lon: r.lon, label: r.label + (r.approx ? ' (≈)' : '') });
  };
  $('opt-round').onchange = e => { state.roundtrip = e.target.checked; save(true); renderAll(); };
  $('opt-dark').onchange = e => { state.dark = e.target.checked; save(true); renderAll(); };
  $('opt-arrive').onchange = e => { state.arrive = e.target.checked; if (!state.arrive) hideBanner(); save(true); };
  $('btn-reopt').onclick = () => {
    const before = remaining;
    const items = openStops().map(pt);
    state.order = C.optimize(anchor(), items, endPt()).map(p => p.id);
    save(true);
    renderAll();
    const saved = before - remaining;
    toast(saved > 20 ? `🔀 Neu geplant – ${Math.round(saved)} m kürzer` : '🔀 Route war schon gut.');
  };
  $('btn-clear-track').onclick = () => {
    if (!confirm('Gegangene Strecke löschen?')) return;
    state.track = [];
    trackLine.setLatLngs([]);
    save(true);
  };
  $('btn-reset').onclick = () => {
    if (!confirm('Alle Adressen, Start und Strecke löschen?')) return;
    Object.assign(state, { stops: [], order: [], start: null, track: [], started: false, nextId: 1 });
    trackLine.setLatLngs([]);
    save(true);
    renderAll();
    closeSheets();
  };

  // ------------------------------------------------------------- Dateien (Chat-Export)
  // WhatsApp exportiert als .txt oder – je nach Version – als .zip mit einer .txt darin.
  async function zipTexts(buf) {
    const dv = new DataView(buf), dec = new TextDecoder();
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP-Datei ist beschädigt.');
    const out = [];
    let p = dv.getUint32(eocd + 16, true);
    for (let k = dv.getUint16(eocd + 10, true); k > 0 && dv.getUint32(p, true) === 0x02014b50; k--) {
      const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const loff = dv.getUint32(p + 42, true);
      const name = dec.decode(new Uint8Array(buf, p + 46, nlen));
      p += 46 + nlen + elen + clen;
      if (!/\.txt$/i.test(name)) continue;
      const data = new Uint8Array(buf, loff + 30 + dv.getUint16(loff + 26, true) + dv.getUint16(loff + 28, true), size);
      if (method === 0) out.push(dec.decode(data));
      else if (method === 8) {
        const raw = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        out.push(dec.decode(await new Response(raw).arrayBuffer()));
      }
    }
    if (!out.length) throw new Error('In der ZIP-Datei ist kein Chat-Text.');
    return out.join('\n');
  }
  async function fileToText(blob) {
    const buf = await blob.arrayBuffer();
    const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
    return head[0] === 0x50 && head[1] === 0x4b ? zipTexts(buf) : new TextDecoder().decode(buf);
  }
  // Export enthält den ganzen Verlauf; die Nachrichten von heute stehen am Ende.
  function loadChatText(text) {
    const lines = text.replace(/\r/g, '').split('\n');
    $('import-text').value = lines.length > 3000 ? lines.slice(-3000).join('\n') : text;
    detect();
  }
  $('btn-file').onclick = () => $('file-input').click();
  $('file-input').onchange = ev => {
    const f = ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    fileToText(f).then(loadChatText).catch(e => toast('Datei konnte nicht gelesen werden: ' + e.message, 6000));
  };

  // ------------------------------------------------------------- Teilen (Web Share Target)
  async function receiveShare() {
    if (!/[?&]share=1/.test(location.search) || !window.caches) return;
    history.replaceState(null, '', location.pathname);
    const c = await caches.open('share');
    const r = await c.match('shared');
    if (!r) return;
    const d = await r.json();
    const parts = d.text ? [d.text] : [];
    try {
      for (let i = 0; i < (d.files || 0); i++) {
        const fr = await c.match('shared-file-' + i);
        if (fr) parts.push(await fileToText(await fr.blob()));
      }
    } catch (e) {
      toast('Geteilte Datei konnte nicht gelesen werden: ' + e.message, 6000);
    }
    for (const k of await c.keys()) await c.delete(k);
    openSheet('sheet-import');
    loadChatText(parts.join('\n'));
  }

  // ------------------------------------------------------------- Start
  // Alte Stopps ohne Plan (z. B. nach Update) in die Reihenfolge aufnehmen
  const known = new Set(state.order);
  state.order = state.order.filter(id => byId(id) && !byId(id).visited);
  const missing = openStops().filter(s => !known.has(s.id)).map(s => s.id);
  if (missing.length) insertStops(missing);

  trackLine.setLatLngs(state.track.map(t => [t[0], t[1]]));
  renderAll();
  if (state.stops.length) fitAll();
  // Beim allerersten Start die Anleitung zeigen (nicht, wenn gerade ein Chat geteilt wurde)
  if (!state.helpSeen && !/[?&]share=1/.test(location.search)) {
    state.helpSeen = true;
    save(true);
    setTimeout(() => openSheet('sheet-help'), 400);
  }
  receiveShare();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js');

  window.__app = { state, addStops, checkOff, detect, renderAll };   // für Tests
})();
