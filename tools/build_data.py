"""Holt Hausnummern und Wegenetz eines Ortes aus OpenStreetMap (Overpass)
und schreibt sie kompakt nach ../data.js.

Der Ort wird über die ID seiner OSM-Grenzrelation angegeben (z. B. über
nominatim.openstreetmap.org suchen, „osm_id“ bei osm_type=relation).

Aufruf:  python tools/build_data.py <relation-id>              (lädt von Overpass)
         python tools/build_data.py <relation-id> raw.json     (gespeicherte Antwort)
"""
import json
import math
import sys
import urllib.parse
import urllib.request
from pathlib import Path

MAX_SEG = 25.0                            # m, längere Segmente werden unterteilt

# Gewichtung je Wegtyp: Feldwege nur nehmen, wenn sie deutlich kürzer sind.
COST = {
    "track": 2.5, "path": 2.0, "bridleway": 2.5, "cycleway": 1.3,
    "footway": 1.0, "pedestrian": 1.0, "steps": 1.3, "living_street": 1.0,
    "residential": 1.0, "service": 1.1, "unclassified": 1.0,
    "tertiary": 1.1, "secondary": 1.2, "primary": 1.4,
}
STREETLIKE = {"residential", "living_street", "service", "unclassified",
              "tertiary", "secondary", "primary", "pedestrian", "footway", "steps"}

QUERY = """[out:json][timeout:90];
rel({rel});map_to_area->.a;
nwr["addr:housenumber"](area.a);
out center tags;
way["highway"](area.a);
out geom tags;
"""


def fetch(rel):
    data = urllib.parse.urlencode({"data": QUERY.format(rel=int(rel))}).encode()
    req = urllib.request.Request("https://overpass-api.de/api/interpreter", data=data,
                                 headers={"User-Agent": "app-halloween-build/1.0"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def haversine(a, b):
    r = 6371000.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    raw = json.load(open(sys.argv[2], encoding="utf-8")) if len(sys.argv) > 2 else fetch(sys.argv[1])
    elems = raw["elements"]

    # --- Hausnummern ---------------------------------------------------------
    addrs = {}
    for e in elems:
        t = e.get("tags", {})
        if "addr:housenumber" not in t:
            continue
        street = t.get("addr:street") or t.get("addr:place")
        if not street:
            continue
        lat, lon = (e["lat"], e["lon"]) if e["type"] == "node" else (e["center"]["lat"], e["center"]["lon"])
        for hn in t["addr:housenumber"].replace(";", ",").split(","):
            hn = hn.strip().lower().replace(" ", "")
            if hn:
                addrs[(street, hn)] = (round(lat, 6), round(lon, 6))

    # --- Wegenetz ------------------------------------------------------------
    node_idx = {}
    nodes = []          # [lat, lon]
    street_node = []    # 1 = liegt an einer Straße (nicht nur Feldweg)
    edges = {}          # (a, b) -> Kosten

    def node(lat, lon, streetlike):
        key = (round(lat, 6), round(lon, 6))
        i = node_idx.get(key)
        if i is None:
            i = node_idx[key] = len(nodes)
            nodes.append(list(key))
            street_node.append(0)
        if streetlike:
            street_node[i] = 1
        return i

    street_geom = {}    # Name -> Liste von Polylinien
    for e in elems:
        t = e.get("tags", {})
        hw = t.get("highway")
        if e["type"] != "way" or hw not in COST or "geometry" not in e:
            continue
        if t.get("access") in ("private", "no") and t.get("foot") not in ("yes", "designated"):
            continue
        streetlike = hw in STREETLIKE
        pts = [(g["lat"], g["lon"]) for g in e["geometry"]]
        if t.get("name"):
            street_geom.setdefault(t["name"], []).append([[round(a, 6), round(b, 6)] for a, b in pts])
        prev = None
        for i, p in enumerate(pts):
            if prev is not None:
                d = haversine(prev, p)
                steps = max(1, math.ceil(d / MAX_SEG))
                last = node(*prev, streetlike)
                for s in range(1, steps + 1):
                    f = s / steps
                    q = (prev[0] + (p[0] - prev[0]) * f, prev[1] + (p[1] - prev[1]) * f)
                    cur = node(*q, streetlike)
                    if cur != last:
                        w = round(d / steps * COST[hw], 1)
                        k = (min(last, cur), max(last, cur))
                        edges[k] = min(edges.get(k, 1e9), w)
                    last = cur
            prev = p

    streets = sorted({s for s, _ in addrs} | set(street_geom))
    sidx = {s: i for i, s in enumerate(streets)}
    # Kartenmitte und Ausschnitt aus den Hausnummern (sonst aus dem Wegenetz)
    pts = list(addrs.values()) or [tuple(n) for n in nodes]
    lats, lons = [a for a, _ in pts], [b for _, b in pts]
    out = {
        "source": "© OpenStreetMap-Mitwirkende (ODbL)",
        "center": [round(sum(lats) / len(lats), 5), round(sum(lons) / len(lons), 5)],
        "bounds": [[min(lats), min(lons)], [max(lats), max(lons)]],
        "streets": streets,
        "addr": [[sidx[s], hn, ll[0], ll[1]] for (s, hn), ll in sorted(addrs.items())],
        "geom": {sidx[s]: g for s, g in street_geom.items()},
        "nodes": [c for n in nodes for c in n],
        "streetNode": street_node,
        "edges": [x for (a, b), w in edges.items() for x in (a, b, w)],
    }
    target = Path(__file__).resolve().parent.parent / "data.js"
    target.write_text("// Automatisch erzeugt von tools/build_data.py – nicht von Hand bearbeiten.\n"
                      "window.VZ_DATA = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n",
                      encoding="utf-8")
    print(f"{len(streets)} Straßen, {len(addrs)} Hausnummern, {len(nodes)} Knoten, {len(edges)} Kanten "
          f"-> {target} ({target.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
