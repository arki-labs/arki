---
"@arki/journal": minor
---

`checkEventMapFile` returns an `EventMapFileFailed` failure (`journal.event_map_file_failed`) instead of rejecting when the file cannot be written, and no longer reports an unreadable file as `missing`: only "no such file" is `missing`. `scanEntrypoints` records a procedure file it cannot read (a broken symlink, no permission) as a `problems` entry and scans the rest.
