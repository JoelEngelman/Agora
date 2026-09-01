# Agora

**Write. Discuss. Create.**

Agora is a modern publishing and community platform designed around real writing, real discussion, following people, and giving every member a customizable corner of the internet.

## Product principles

- No infinite-scroll feed.
- Followers and following still exist.
- No fake/demo users, posts, comments, followers, or communities.
- Long-form articles are first-class content.
- Discussions and communities are first-class content.
- Users can build a personal Agora homepage with a visual component editor.
- Public personal sites use the pattern `agora.pages.dev/username/`.
- The database is Cloudflare D1.
- The application is deployed as a Cloudflare Worker with static assets.

## Current foundation

- Account signup/login/logout with secure session cookies.
- PBKDF2 password hashing using the Web Crypto API.
- D1 schema for users, sessions, posts, tags, follows, likes, bookmarks, comments, communities, discussions, replies, notifications, and website pages.
- Article publishing and search.
- Likes, bookmarks, comments, follows, and notifications.
- Public user profiles.
- Personal website JSON storage and a visual builder foundation.
- Responsive modern UI.

## Cloudflare deployment

Workers Builds can deploy this repository directly from GitHub. The repository contains `wrangler.jsonc`, which binds the existing `agora-db` D1 database as `DB` and serves the `public/` directory as Worker assets.

The package deploy script applies D1 migrations remotely and then deploys the Worker:

```text
npm run deploy
```

For Cloudflare Workers Builds, use:

- Build command: leave blank
- Deploy command: `npm run deploy`
- Root directory: `/`
- Production branch: `main`

No local Node.js, npm, Wrangler, or other developer software is required for the GitHub → Cloudflare deployment workflow.
