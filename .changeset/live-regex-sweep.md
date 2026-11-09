---
"@arki/live": patch
---

The live client reads the event stream in one pass. A line sent in many chunks with no line end was read again from its start with every chunk: seconds for a 2 MB frame. Chunks without a line end now wait aside until the line ends.
