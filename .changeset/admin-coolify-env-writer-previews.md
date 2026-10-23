---
'@arki/admin': patch
---

The Coolify env writer deletes the preview copies Coolify makes of every new variable, so a production key never reaches PR previews unhidden, and the probe leaves nothing behind. `removePreviewCopies(applicationUuid, keys)` cleans variables written before. Docs: the Coolify connection README explains why. No demo impact: the Coolify connection has no demo.
