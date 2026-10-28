---
'@arki/dot': patch
---

Keep 1Password diagnostics private and preserve existing env-key backups with in-place Password item edits. Confirm absence before creating, refuse duplicate titles and provider read failures, and return `dot.env_vault_write_unconfirmed` when a write needs provider reconciliation before retry. Repeated pushes reread the vault and accept an already matching key without another write.

Docs impact: the upgrade guide, failure table and agent guide explain safe reconciliation and the native-child timeout. No demo impact: demos do not invoke vault backup commands.
