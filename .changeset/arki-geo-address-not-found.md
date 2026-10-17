---
'@arki/geo': minor
---

`geocode` returns `AddressNotFound` (`geo.address_not_found`, 404, data `{ address }`) when every provider that answered found nothing, in place of throwing `GeocodingError`. A caller can now tell "this address does not exist" from "the provider is down": the second one still throws `GeocodingError`. `batchGeocode` records `AddressNotFound` for a missing address. Import `AddressNotFound` from `@arki/geo`.
