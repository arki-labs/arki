---
'@arki/cli': minor
---

New command option `passthrough: true` for commands that hand stdout to a child process (`dot env run -- <cmd>`, like `op run`): `run` returns the child's exit code, and on success no envelope is written in any mode, so a pipe carries only the child's output. A failure returned before the child starts is written as usual.
