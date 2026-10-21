---
'@arki/dot': minor
'@arki/cli': patch
---

`dot env`: encrypted env files from the command line. `init` (header, private key, `.gitignore`, agent read-deny), `set` (encrypts with the public key only, so agents can write without reading; refuses a no-op), `get` (shape only; `--reveal` on a terminal), `ls`, `check` (CI gate: unloadable files, refused keys, plaintext `secret()` keys in tracked files, tracked `.env.keys`), `encrypt` (`--from` imports a plaintext file), `decrypt`, `rotate` (every `.env.<env>` file together), `run -- <cmd>` (passthrough; redacts secrets when stdout is not a terminal), `explain`, and `keys push|pull` (1Password, key via stdin). Failures `dot.env_*`.

`@arki/cli`: a positional array argument is no longer split on commas (`node -e "f(a, b)"` stayed two pieces).
