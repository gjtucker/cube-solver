# Bundled font

`inter-v20-latin.woff2` — Inter, variable weight axis 100–900, **latin subset
only**, as served by Google Fonts (`v20`). Vendored here so the app makes no
off-origin request: previously the page pulled this from `fonts.googleapis.com`
/ `fonts.gstatic.com`, which handed every visitor's IP and user agent to Google
on a first load.

Only the latin subset ships because nothing else is needed: every non-ASCII
character in the shipped source is either inside that subset (`° ± ³ · × – — ’
“ ” … ′`) or outside every Inter subset (`▶ ✓ ✕ ⧉ 🎉 📷 …`), where it falls back
to a system font — exactly as it did when the font came from Google.

Licence: SIL Open Font License 1.1, © 2016 The Inter Project Authors
(<https://github.com/rsms/inter>). Full text in `LICENSE-Inter.txt`, which the
OFL requires to travel with the font. The OFL covers the font only; the rest of
CubeSnap is GPL-3.0-or-later.

## Updating

```sh
curl -H 'User-Agent: Mozilla/5.0 ... Chrome/120' \
  'https://fonts.googleapis.com/css2?family=Inter:wght@400..800&display=swap'
# take the URL from the /* latin */ @font-face block, then:
curl -o fonts/inter-v20-<newver>-latin.woff2 '<that url>'
```

Then update the `@font-face` `src` in `style.css` and the filename in `sw.js`'s
`CORE` list. The version is in the filename so a new file cannot be served from
a stale cache entry.
