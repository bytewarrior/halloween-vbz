/* Kernlogik ohne Oberfläche: WhatsApp-Text zerlegen, Adressen erkennen und
 * verorten, Fußwege im eingebetteten OSM-Wegenetz routen, Reihenfolge planen. */
(function (global) {
  'use strict';
  const D = global.VZ_DATA;

  // ---------------------------------------------------------------- Hilfen
  function norm(s) {
    return s.toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, ' ').trim();
  }
  // Vergleichsform eines Straßennamens: ohne Leerzeichen, „straße“ → „str“
  // (auch vertippt: „strase“, „stasse“, „strsse“ …)
  function stem(s) {
    return norm(s).replace(/ /g, '').replace(/st(r?a?s{1,2}e)$/, 'str');
  }
  function lev(a, b) {
    const n = b.length;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  }
  function haversine(a, b) {
    const r = 6371000, rad = Math.PI / 180;
    const dp = (b.lat - a.lat) * rad, dl = (b.lon - a.lon) * rad;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dl / 2) ** 2;
    return 2 * r * Math.asin(Math.sqrt(h));
  }

  // ------------------------------------------------------- Straßen, Adressen
  const STREETS = D.streets.map((name, i) => ({ i, name, stem: stem(name) }));
  const ADDR = new Map();          // "s|hn" -> {lat, lon}
  const BYSTREET = new Map();      // s -> [{n, lat, lon}] nach Nummer sortiert
  for (const [s, hn, lat, lon] of D.addr) {
    ADDR.set(s + '|' + hn, { lat, lon });
    const n = parseInt(hn, 10);
    if (!isNaN(n)) {
      if (!BYSTREET.has(s)) BYSTREET.set(s, []);
      BYSTREET.get(s).push({ n, lat, lon });
    }
  }
  for (const list of BYSTREET.values()) list.sort((a, b) => a.n - b.n);

  // ------------------------------------------------------- WhatsApp-Format
  // [11:13, 31.10.2026] Name: Text           (Android, kopierte Nachrichten)
  // 31.10.26, 11:13 - Name: Text             (Android, Chat-Export)
  // [31.10.26, 11:13:05] Name: Text          (iPhone)
  const H_TIME_FIRST = /^‎?\[(\d{1,2}):(\d{2})(?::\d{2})?,\s*(\d{1,2})[./](\d{1,2})[./](\d{2,4})\]\s*([^:]{1,80}?):\s?(.*)$/;
  const H_DATE_FIRST = /^‎?\[?(\d{1,2})[./](\d{1,2})[./](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::\d{2})?\]?\s*(?:-\s*)?([^:]{1,80}?):\s?(.*)$/;

  function mkDate(d, m, y) {
    d = +d; m = +m; y = +y;
    if (y < 100) y += 2000;
    if (m > 12 && d <= 12) [d, m] = [m, d];   // US-Format
    return { y, m, d };
  }
  function parseHeader(line) {
    let m = H_TIME_FIRST.exec(line);
    if (m) return { date: mkDate(m[3], m[4], m[5]), time: m[1].padStart(2, '0') + ':' + m[2], sender: m[6].trim(), text: m[7] };
    m = H_DATE_FIRST.exec(line);
    if (m) return { date: mkDate(m[1], m[2], m[3]), time: m[4].padStart(2, '0') + ':' + m[5], sender: m[6].trim(), text: m[7] };
    return null;
  }
  function parseChat(text) {
    const msgs = [];
    let cur = null, headers = 0;
    for (const line of text.replace(/\r/g, '').split('\n')) {
      const h = parseHeader(line);
      if (h) { headers++; cur = h; msgs.push(cur); }
      else if (cur) cur.text += '\n' + line;
      else { cur = { date: null, time: null, sender: '', text: line }; msgs.push(cur); }
    }
    msgs.forEach(m => { m.text = m.text.trim(); });
    return { msgs: msgs.filter(m => m.text), hasHeaders: headers > 0 };
  }
  function isToday(date, now) {
    now = now || new Date();
    return !!date && date.y === now.getFullYear() && date.m === now.getMonth() + 1 && date.d === now.getDate();
  }

  // ------------------------------------------------------- Adresserkennung
  const TOKEN = /([A-Za-zÄÖÜäöüß]+\.?)|(\d+)(\s?[a-zA-Z](?![A-Za-zÄÖÜäöüß]))?|([^\sA-Za-zÄÖÜäöüß\d])/g;
  const SKIP = new Set(['nr', 'nr.', 'hausnummer', 'hnr', 'hnr.', 'no', 'no.']);
  const JOIN = new Set([',', '/', '-', '+', '&', 'und', 'u.', 'sowie']);

  function tokenize(text) {
    const out = [];
    let m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(text))) {
      if (m[1]) out.push({ t: 'w', v: m[1] });
      else if (m[2]) out.push({ t: 'n', v: m[2], s: (m[3] || '').trim().toLowerCase() });
      else out.push({ t: 'p', v: m[4] });
    }
    return out;
  }
  function matchStreet(words) {
    let best = null;
    for (let k = 1; k <= Math.min(4, words.length); k++) {
      const cand = stem(words.slice(-k).join(' '));
      if (cand.length < 3) continue;
      for (const st of STREETS) {
        const L = st.stem.length, max = L >= 12 ? 2 : L >= 6 ? 1 : 0;
        if (Math.abs(cand.length - L) > max) continue;
        const d = lev(cand, st.stem);
        if (d <= max && (!best || d < best.d)) best = { st, d };
      }
    }
    return best && best.st;
  }

  // Liefert {found: [{street, streetName, hn}], noNumber: [{street, streetName}]}
  function extract(text) {
    const tok = tokenize(text);
    const found = [], seen = new Set();
    for (let i = 0; i < tok.length; i++) {
      if (tok[i].t !== 'n') continue;
      // Wörter vor der Zahl einsammeln (Bindestriche überspringen, „Nr.“ ignorieren)
      const words = [];
      let j = i - 1;
      while (j >= 0 && tok[j].t === 'w' && SKIP.has(tok[j].v.toLowerCase())) j--;
      for (; j >= 0 && words.length < 4; j--) {
        if (tok[j].t === 'w') words.unshift(tok[j].v);
        else if (!(tok[j].t === 'p' && tok[j].v === '-')) break;
      }
      const st = words.length && matchStreet(words);
      if (!st) continue;
      // Nummernliste: „5“, „5a“, „5 und 7“, „12-14“, „3, 4“
      const nums = [tok[i]];
      let k = i + 1;
      while (k + 1 < tok.length && JOIN.has(tok[k].v.toLowerCase()) && tok[k + 1].t === 'n') {
        nums.push(tok[k + 1]);
        k += 2;
      }
      i = k - 1;
      for (const n of nums) {
        if (+n.v < 1 || +n.v > 400) continue;
        const hn = String(+n.v) + n.s;
        const key = st.i + '|' + hn;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ street: st.i, streetName: st.name, hn });
      }
    }
    // Straßen, die ohne Hausnummer erwähnt werden
    const flat = norm(text).replace(/ /g, '');
    const noNumber = STREETS
      .filter(st => !found.some(f => f.street === st.i) && st.stem.length >= 6 && flat.includes(st.stem))
      .map(st => ({ street: st.i, streetName: st.name }));
    return { found, noNumber };
  }

  // ------------------------------------------------------- Verortung
  function streetMid(s) {
    const g = D.geom[s];
    if (!g) return null;
    let best = g[0];
    for (const line of g) if (line.length > best.length) best = line;
    const p = best[Math.floor(best.length / 2)];
    return { lat: p[0], lon: p[1] };
  }
  // {lat, lon, approx} oder null
  function geocode(s, hn) {
    if (hn) {
      const hit = ADDR.get(s + '|' + hn);
      if (hit) return { lat: hit.lat, lon: hit.lon, approx: false };
      const n = parseInt(hn, 10);
      const base = ADDR.get(s + '|' + n);
      if (base) return { lat: base.lat, lon: base.lon, approx: true };
      const list = BYSTREET.get(s);
      if (list && list.length) {
        // Nachbarn gleicher Straßenseite bevorzugen
        const same = list.filter(a => a.n % 2 === n % 2);
        const pool = same.length >= 1 ? same : list;
        let lo = null, hi = null;
        for (const a of pool) {
          if (a.n < n) lo = a;
          else if (a.n > n && !hi) hi = a;
        }
        if (lo && hi) {
          const f = (n - lo.n) / (hi.n - lo.n);
          return { lat: lo.lat + (hi.lat - lo.lat) * f, lon: lo.lon + (hi.lon - lo.lon) * f, approx: true };
        }
        const one = lo || hi;
        return { lat: one.lat, lon: one.lon, approx: true };
      }
    }
    const mid = streetMid(s);
    return mid && { lat: mid.lat, lon: mid.lon, approx: true };
  }

  // ------------------------------------------------------- Wegenetz
  const NN = D.nodes.length / 2;
  const LAT = new Float64Array(NN), LON = new Float64Array(NN);
  for (let i = 0; i < NN; i++) { LAT[i] = D.nodes[2 * i]; LON[i] = D.nodes[2 * i + 1]; }
  const deg = new Int32Array(NN + 1);
  for (let e = 0; e < D.edges.length; e += 3) { deg[D.edges[e]]++; deg[D.edges[e + 1]]++; }
  const OFF = new Int32Array(NN + 1);
  for (let i = 0; i < NN; i++) OFF[i + 1] = OFF[i] + deg[i];
  const TO = new Int32Array(OFF[NN]), W = new Float32Array(OFF[NN]), fill = OFF.slice(0, NN);
  for (let e = 0; e < D.edges.length; e += 3) {
    const a = D.edges[e], b = D.edges[e + 1], w = D.edges[e + 2];
    TO[fill[a]] = b; W[fill[a]++] = w;
    TO[fill[b]] = a; W[fill[b]++] = w;
  }
  const COSLAT = Math.cos(D.center[0] * Math.PI / 180);

  function nearestNode(lat, lon) {
    let best = -1, bestD = Infinity, bestS = -1, bestSD = Infinity;
    for (let i = 0; i < NN; i++) {
      const dx = (LON[i] - lon) * COSLAT * 111320, dy = (LAT[i] - lat) * 110540;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
      if (D.streetNode[i] && d < bestSD) { bestSD = d; bestS = i; }
    }
    // Häuser lieber an die Straße hängen als an einen Feldweg hinterm Haus
    return bestS >= 0 && bestSD < 80 * 80 ? bestS : best;
  }
  function snap(p) {
    const node = nearestNode(p.lat, p.lon);
    return Object.assign({}, p, { node, off: haversine(p, { lat: LAT[node], lon: LON[node] }) });
  }

  const cache = new Map();
  function dijkstra(src) {
    let r = cache.get(src);
    if (r) return r;
    const dist = new Float64Array(NN).fill(Infinity), prev = new Int32Array(NN).fill(-1);
    const heap = [];                         // [d, node] als Binärheap
    const push = (d, n) => {
      heap.push([d, n]);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]]; i = p;
      }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, rr = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (rr < heap.length && heap[rr][0] < heap[m][0]) m = rr;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
        }
      }
      return top;
    };
    dist[src] = 0; push(0, src);
    while (heap.length) {
      const [d, u] = pop();
      if (d > dist[u]) continue;
      for (let k = OFF[u]; k < OFF[u + 1]; k++) {
        const v = TO[k], nd = d + W[k];
        if (nd < dist[v]) { dist[v] = nd; prev[v] = u; push(nd, v); }
      }
    }
    r = { dist, prev };
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    cache.set(src, r);
    return r;
  }

  // Fußweg-Kosten zwischen zwei gesnappten Punkten (b ist bevorzugt ein fester Punkt)
  function dist(a, b) {
    if (!a || !b) return 0;
    if (a.node === b.node) return haversine(a, b);
    const src = cache.has(a.node) && !cache.has(b.node) ? a.node : b.node;
    const other = src === b.node ? a.node : b.node;
    const d = dijkstra(src).dist[other];
    return isFinite(d) ? d + a.off + b.off : haversine(a, b) * 1.5;
  }
  // Koordinatenliste des Fußwegs von a nach b
  function legCoords(a, b) {
    const sp = dijkstra(b.node);
    const out = [[a.lat, a.lon]];
    if (isFinite(sp.dist[a.node])) {
      for (let n = a.node; n !== -1; n = sp.prev[n]) out.push([LAT[n], LON[n]]);
    }
    out.push([b.lat, b.lon]);
    return out;
  }

  // ------------------------------------------------------- Tourplanung
  // seq: [anchor?, ...items, end?]  – lo/hi: bewegliche Indizes
  function pathLength(seq) {
    let s = 0;
    for (let i = 0; i + 1 < seq.length; i++) s += dist(seq[i], seq[i + 1]);
    return s;
  }
  function improve(seq, lo, hi) {
    const d = (a, b) => (a && b ? dist(a, b) : 0);
    let better = true, rounds = 0;
    while (better && rounds++ < 50) {
      better = false;
      // 2-opt: Teilstück umdrehen
      for (let i = lo; i < hi; i++) {
        for (let j = i + 1; j <= hi; j++) {
          const before = d(seq[i - 1], seq[i]) + d(seq[j], seq[j + 1]);
          const after = d(seq[i - 1], seq[j]) + d(seq[i], seq[j + 1]);
          if (after < before - 0.5) {
            const part = seq.slice(i, j + 1).reverse();
            seq.splice(i, j - i + 1, ...part);
            better = true;
          }
        }
      }
      // Or-opt: 1–3 Punkte an eine andere Stelle verschieben
      for (let len = 1; len <= 3; len++) {
        for (let i = lo; i + len - 1 <= hi; i++) {
          const seg = seq.slice(i, i + len);
          const rest = seq.slice(0, i).concat(seq.slice(i + len));
          const gain = d(seq[i - 1], seg[0]) + d(seg[len - 1], seq[i + len]) - d(seq[i - 1], seq[i + len]);
          const rhi = hi - len + 1;          // letzte zulässige Einfügeposition im Rest
          let best = null;
          for (let p = lo; p <= rhi; p++) {
            if (p === i) continue;
            for (const s of [seg, seg.slice().reverse()]) {
              const cost = d(rest[p - 1], s[0]) + d(s[len - 1], rest[p]) - d(rest[p - 1], rest[p]);
              if (cost < gain - 0.5 && (!best || cost < best.cost)) best = { p, s, cost };
            }
          }
          if (best) {
            rest.splice(best.p, 0, ...best.s);
            seq.splice(0, seq.length, ...rest);
            better = true;
          }
        }
      }
    }
    return seq;
  }
  // Reihenfolge der items ab anchor (optional) bis end (optional) optimieren.
  // keepOrder: von der gegebenen Reihenfolge ausgehen statt neu aufzubauen.
  function optimize(anchor, items, end, keepOrder) {
    if (!items.length) return [];
    const rest = items.slice(), order = keepOrder ? rest.splice(0) : [];
    let cur = anchor;
    if (!cur && !keepOrder) { cur = rest.shift(); order.push(cur); }
    while (rest.length) {
      let bi = 0, bd = Infinity;
      rest.forEach((x, i) => { const dd = dist(cur, x); if (dd < bd) { bd = dd; bi = i; } });
      cur = rest.splice(bi, 1)[0];
      order.push(cur);
    }
    const seq = (anchor ? [anchor] : []).concat(order, end ? [end] : []);
    const lo = anchor ? 1 : 0, hi = seq.length - 1 - (end ? 1 : 0);
    improve(seq, lo, hi);
    return seq.slice(lo, hi + 1);
  }
  // item an der günstigsten Stelle der bestehenden Reihenfolge einfügen
  function insertCheapest(anchor, order, end, item) {
    const seq = (anchor ? [anchor] : []).concat(order, end ? [end] : []);
    const d = (a, b) => (a && b ? dist(a, b) : 0);
    const lo = anchor ? 1 : 0, hi = seq.length - (end ? 1 : 0);
    let bp = lo, bc = Infinity;
    for (let p = lo; p <= hi; p++) {
      const c = d(seq[p - 1], item) + d(item, seq[p]) - d(seq[p - 1], seq[p]);
      if (c < bc) { bc = c; bp = p; }
    }
    seq.splice(bp, 0, item);
    return seq.slice(lo, seq.length - (end ? 1 : 0));
  }

  global.Core = {
    norm, stem, haversine, parseChat, isToday, extract, geocode,
    streets: D.streets, snap, dist, legCoords, pathLength, optimize, insertCheapest,
  };
})(window);
