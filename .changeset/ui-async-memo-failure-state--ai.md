---
'@arki/chat-ui': patch
---

`CodeBlock` now copies through `copyText` from `@arki/ui/copy-text`. The private copy of that helper in chat-ui is gone, so chat-ui needs `@arki/ui` 0.2.0 or later. Copy behaviour is unchanged.
