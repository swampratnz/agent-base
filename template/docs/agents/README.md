# Agent context pack

Orientation for a **cold session** — an automated worker, or a human returning
after a month. Written down once and committed, so it is not re-derived from
the tree on every run.

| File | What it is for |
|---|---|
| [`module-map.md`](module-map.md) | Where things live. One line per `src/` subsystem and module. Gated by `npm run context:check`, so it cannot silently rot. |
| `recipes.md` | TODO: add one once this repo has a shape. The shape of a typical change here — which files it touches, and which gate fails if you miss one. |

Three rules:

1. **Read the pack before exploring the tree.** It replaces a broad search
   sweep; it does not precede one.
2. **Then read the code.** The map says which file, never what the code does.
3. **If it is wrong, fix it in your PR.** A wrong map is worse than no map,
   because it is confidently wrong and the next cold session cannot tell.

`npm run context:fix` adds, drops and sorts entries mechanically — and
deliberately **cannot** make the gate green: it writes a `TODO` stub and the
check keeps failing until someone writes the one-line description.
