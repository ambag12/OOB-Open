# Brand fonts

These files are not in the repository. Drop them here and the app picks them up
with no code change — `web/styles.css` already declares the `@font-face` rules
and the fallback stacks.

| File | Face | Where it is used | Source |
| --- | --- | --- | --- |
| `Belleza-Regular.woff2` | Belleza | headings (`h1`, `h2`) | Google Fonts, SIL Open Font License |
| `NeueMontreal-Regular.woff2` | Neue Montreal | body copy, sub-headings | Pangram Pangram, commercial licence |
| `NeueMontreal-Medium.woff2` | Neue Montreal Medium | emphasis | as above |
| `NeueMontreal-Bold.woff2` | Neue Montreal Bold | strong emphasis | as above |

Belleza is already wired up. For Neue Montreal, uncomment the `@font-face`
block at the top of `web/styles.css` once the files are here.

## They have to be self-hosted

The app sends `Content-Security-Policy: default-src 'self'`, so a stylesheet
that pulls fonts from `fonts.gstatic.com` is blocked by the browser and the
page silently falls back. Converting to `.woff2` and serving them from this
directory is the only route.

To convert from `.ttf`/`.otf`:

```bash
pip install fonttools brotli
python -c "from fontTools.ttLib import TTFont; f=TTFont('Belleza-Regular.ttf'); f.flavor='woff2'; f.save('Belleza-Regular.woff2')"
```

## Until then

Headings fall back to Optima → Candara → Gill Sans → Trebuchet MS, and body
copy to the system UI sans. Both are chosen to sit close to the real faces, so
the layout does not shift when the files arrive.
