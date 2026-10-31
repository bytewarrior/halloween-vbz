# Süßes-Route 🎃

Kleine Web-App (PWA) für Halloween im Dorf: Adressen aus dem WhatsApp-Gruppenchat
einfügen, daraus eine Rundtour zu Fuß berechnen, live auf der OpenStreetMap-Karte mitlaufen
und die Häuser abhaken. Neue Adressen werden nur in den noch offenen Teil der Route eingeplant.

- Läuft komplett im Browser (Chrome ab Android 9), keine Anmeldung, kein Server.
- Hausnummern und Wegenetz des Ortes sind eingebettet (`data.js`, aus OSM erzeugt mit
  `python tools/build_data.py <OSM-Relations-ID des Ortes>`), Routing passiert offline im Gerät.
- Adressen, Route und gegangene Strecke bleiben im `localStorage` des Geräts.

## Bedienung

1. Seite in Chrome öffnen, Standort erlauben, über ⋮ → „Zum Startbildschirm hinzufügen“ installieren.
2. In WhatsApp die Nachrichten markieren → ⋮ → Kopieren → in der App unter „Adressen“ einfügen
   → „Erkennen“ → „Übernehmen“. Alternativ Chat exportieren und an „Süßes-Route“ teilen.
3. Am Startpunkt „📍 Hier starten“ (oder „▶ Los“, wenn der Start schon gesetzt ist). Ab dann
   plant die App die Restroute laufend ab eurer Position neu – wer abkürzt oder ein anderes Haus
   zuerst besucht, bekommt automatisch die passende Reihenfolge.
4. Gelbe Linie = Weg zum nächsten Haus, orange gestrichelt = restliche Route, lila = gegangen.
5. Am Haus erscheint ein Hinweis zum Abhaken; sonst Kürbis antippen → „Abhaken“.

Kartendaten © OpenStreetMap-Mitwirkende (ODbL). Leaflet © Vladimir Agafonkin (BSD-2).
