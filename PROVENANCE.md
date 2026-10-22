# Sources and design provenance

Verified source snapshot: 2026-10-22.

## Content

- Resource guide: https://github.com/VKG-Is-All-You-Need/vkg-resources/blob/main/README.md . Resource descriptions and original links retain the guide's qualifications. This website does not claim to have installed or reproduced external tools, examples or research.
- Organization projects: https://github.com/VKG-Is-All-You-Need . Only vkg-resources and .github were present when checked.
- Original guide starting point: https://blog.homura.work/posts/study/paper/vkg/ . External papers, datasets and software remain with their original rightsholders; the site links to them rather than redistributing them.
- The worked example on the home page (`student` / `teacher` tables, mappings, ontology axioms and the rewritten SQL) was written for this site. The SQL is a simplified illustration, not verbatim Ontop output.

## Visual identity

- Identity artwork: https://github.com/VKG-Is-All-You-Need/.github/blob/main/profile/assets/vkg-hero.svg . The original banner is kept at `public/brand/vkg-hero.svg`; the geometric mark (`public/brand/vkg-mark.svg`) is extracted from its paths. The header logo, `public/favicon.svg` and `public/og.png` reuse the same paths.
- Fonts are self-hosted through Fontsource packages and licensed under the SIL Open Font License 1.1: Inter (The Inter Project Authors), Instrument Serif (The Instrument Serif Project Authors) and JetBrains Mono (The JetBrains Mono Project Authors).
- Icons are simple line drawings written for this site, except the GitHub mark, which is used only to link to GitHub.

## Design reference

Earlier versions of this site took their editorial hierarchy, fine dividers and directory layout from Editorial by HTML5 UP (AJ / @ajlkn), licensed under CC BY 3.0 (https://html5up.net/editorial, https://html5up.net/license). No template code, fonts, photos, icons or dependencies were copied. The current version is a new Astro implementation; the credit is kept on the About page. Attribution does not imply endorsement.

## Maintenance

Update the public resource guide first, then update the matching entries in `src/data/resources.yaml`. Keep original links and cautionary notes. Entries are validated against the schema in `src/content.config.ts` at build time; page order follows the order in the YAML file. Update `verifiedAt` in `src/data/site.ts` after each verification pass.

The site uses no analytics, cookies, backend or third-party CDN. The only client-side storage is the theme preference in `localStorage`.
