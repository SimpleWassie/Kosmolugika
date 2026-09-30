# Kosmolugika

**A quiet universe for building your next story.** Kosmolugika is a single-user, touch-friendly pre-production workspace for story ideas, scenes, characters, places and props.

## V0.1

The app includes Galaxy, List, Board, Breakdown and Open tasks views; item memos; links; categories; task checklists; references; search and filters; trash; and JSON/Markdown export. Browser storage works offline. When served through Cloudflare Pages with the D1 `DB` binding, the app syncs to the Pages Functions API.

The galaxy map currently uses an on-demand Canvas renderer. Three.js is installed as a dependency for the later instanced WebGL rendering milestone.

## Local development

Requires Node.js and pnpm or npm. Run `npm install` and `npm run dev`, or `npm run build` to create `dist/`. The build verification workflow checks the production bundle when changes land on `main`.

## Cloudflare Pages + D1

1. Create the Pages project from this GitHub repository with build command `npm run build` and output directory `dist`.
2. Bind the D1 database as `DB` and apply `migrations/0001_init.sql` to the remote database.
3. Place Cloudflare Access in front of the Pages hostname before using personal story data.

`wrangler.toml` is the Pages project configuration; set its `database_id` to the D1 database UUID. More setup notes are in this README and `wrangler.toml`.

## Scope

No in-app accounts, collaboration, uploads, status lifecycle, comments, Fountain export, or shooting/post-production features. Cloudflare Access is the intended sign-in gate.

