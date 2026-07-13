---
'@arki/auth': patch
---

`applyProductionBootEnv` (testing/production-boot) now stubs
`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_EMAIL_API_TOKEN` (required by app env
schemas after the Cloudflare Email Service outbound migration, D-ING-021) and
no longer stubs `RESEND_API_KEY` (no app env requires it).
