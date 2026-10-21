---
"@arki/geo": minor
---

Fix the AI react/index wildcard target to resolve its existing TypeScript source. Remove Geo exports and typesVersions entries for unimplemented Apple, Mapbox, Leaflet and HERE modules; these paths never resolved. Google Maps and geocoding exports remain supported.
