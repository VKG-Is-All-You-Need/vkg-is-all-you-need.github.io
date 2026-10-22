# VKG is all you need

Static organization website. Chinese-first, responsive and accessible resource directory.

Publish the contents of this folder at the ROOT of the NEW public repository `VKG-Is-All-You-Need/vkg-is-all-you-need.github.io`. In Settings → Pages, choose Deploy from a branch → main → / (root). No custom workflow, build command, token, DNS or paid service is required.

Expected URL: https://vkg-is-all-you-need.github.io/

Local preview: `python -m http.server 8765 --bind 127.0.0.1` from this folder, then open http://127.0.0.1:8765/ . Opening index.html directly also works.

Files: index.html, styles.css, app.js, .nojekyll, assets/vkg-mark.svg, assets/vkg-hero.svg, PROVENANCE.md, README.md.

All cards are in the initial HTML. JavaScript progressively adds search, combined category filtering, result counts and empty-state reset. Without JavaScript the complete directory remains readable. See PROVENANCE.md for content and design attribution.
