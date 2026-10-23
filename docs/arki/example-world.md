# Example world

Every arki README, docs page, example and test fixture uses the same small world, so a reader
who meets Ada in `@arki/failure` meets the same Ada in `@arki/db`. Pick names from here before
you invent new ones. If you need something this page does not have, add it here first.

## The place

**Analytical Pizza**: a small pizzeria run by Charles Babbage. It takes orders, bakes pizzas,
proofs dough at night and sends a scooter out with deliveries. Prices are in EUR.

| Thing | Use |
|---|---|
| App name | `pizzeria` (for example `defineApp('pizzeria')`) |
| Shop email domain | `pizza.example` (for example `hello@pizza.example`) |
| Outside services | `oven.example` (the oven's API), `scooter.example` (delivery tracking). Both fail when an example needs a flaky dependency. |
| People's email domain | `example.com` |

## The people

All are computing pioneers. The joke is always the situation, never the person.

| Name | ID | Email | Role in examples |
|---|---|---|---|
| Ada Lovelace | `usr_ada` | `ada@example.com` | The regular customer; the default user. |
| Grace Hopper | `usr_grace` | `grace@example.com` | The second user; a moderator when roles matter. |
| Alan Turing | `usr_alan` | `alan@example.com` | The admin. |
| Katherine Johnson | `usr_katherine` | `katherine@example.com` | A third user when a list needs one. |
| Edsger Dijkstra | `usr_edsger` | `edsger@example.com` | Delivery driver; anything about routes or shortest paths. |
| Hedy Lamarr | `usr_hedy` | `hedy@example.com` | Anything about signals, radio, pub/sub. |
| Charles Babbage | `usr_charles` | `charles@pizza.example` | The owner; the sender of shop mail. |

Accounts, orgs and other prefixed IDs reuse the first name: `acc_ada`, `org_pizzeria`.

## The things

| Thing | Values |
|---|---|
| Pizzas | `margherita` (9.50 EUR), `funghi` (11.00 EUR), `quattro-formaggi` (12.50 EUR) |
| Orders | `ord_42` first; `ord_43`, `ord_44` after it |
| Topics and events | `order_placed`, `pizza_ready`, `order_delivered` |
| Jobs | `mail.order-confirmed.v1`, `mail.welcome.v1` |
| Schedules | `nightly-dough-proof` at `0 4 * * *` |
| Locks | `last-slice` |
| Failures | `pizza.out_of_dough`, `order.not_found`, `oven.too_cold` |
| Cache keys | `menu:today`, `oven:temperature` |

## The rules

- One joke per example at most. The code must still teach the thing first.
- Error messages and remediation text stay exact. A joke may sit next to the fix, never in place of it.
- Default UI text that a library ships (empty states, error pages, placeholders) stays neutral. It
  shows up inside other people's apps. Fun goes in the docs example of that component instead.
- Logger categories still start with `arki:`.
- No characters owned by someone else (cartoons, films, games). Historical people only.
- Do not change public API names to make a joke. Names say what a thing does.
