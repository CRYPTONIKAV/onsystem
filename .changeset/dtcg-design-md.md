---
'onsystem': minor
---

Import and export design tokens as DTCG 2025.10 and DESIGN.md. DTCG files now read `$root` tokens and groups that `$extends` another, which were left out before. A DESIGN.md's front matter is a token source, which zero config reads when it finds no stylesheet or DTCG file. `onsystem export --format dtcg|design-md` prints the tokens it found, or writes them with `--out`: the DTCG file keeps colors as color objects, sizes as `{ value, unit }`, aliases as references, and the custom property, the Tailwind theme variable and the dark mode under `$extensions["com.github.dgesteves.onsystem"]`, so reading it back gives the same findings.
