# Kinsburg automation plan (v1, $0/month)

Research date: **2026-11-11**. Every claim links to its source. Freshness labels:
- **[docs, dated]**: official page that shows a "last updated" date (the date is given).
- **[docs, undated]**: official page with no date. Meta's Instagram docs mostly have none, but their examples use API **v27.0**, so they are current.
- **[secondary]**: blog, vendor or forum source. Treat with caution.
- **UNCERTAIN**: the sources disagree, or we have to test it ourselves.

---

## TL;DR (read this first)

1. **No official way to list followers exists.** The Instagram API only returns `followers_count` ([IG User reference](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user.md), [docs, undated]). "Every follower gets a house" can't be automated legally. Change the mechanic to **"comment MOVE IN (or DM us) to get a house"**. The API does see those.
2. **The big blocker is App Review plus Business Verification.** To receive comment webhooks and send DMs or private replies to *random members of the public*, Meta requires **Advanced Access**. That needs **App Review** and **Business Verification**. Without them, the app only works with people who have a role on the app (testers).
3. **What works today with no review:** posting a daily Reel to our own account (Standard Access is enough). Very likely also *polling* comments on our own posts to read who wrote "MOVE IN" (needs a quick test).
4. **Infra at $0 is easy:** Cloudflare Workers + D1 for the webhook and database, Workers Static Assets for the site, and GitHub Actions (public repo = free minutes) for the daily reel render.
5. **Payments:** Stripe Payment Link with a custom "Instagram handle" field, plus a `checkout.session.completed` webhook into the same Worker. Fees are 2.9% + 30¢ (US). Ko-fi is the zero-code fallback.

---

## 1. Joining by comment ("MOVE IN") or DM

### 1.1 Which API to use

Meta now has **three** setups ([Overview](https://developers.facebook.com/documentation/instagram-platform/overview.md), [docs, undated]):

| Setup | Needs a Facebook Page? | Host | Notes |
|---|---|---|---|
| **Instagram API with Instagram Login** | No | `graph.instagram.com` | Simplest. Permissions are named `instagram_business_*`. **No Audio API** (see §2). |
| Instagram API with Facebook Login | Yes, the IG account must be linked to a Page | `graph.facebook.com` | Old path. Has the Audio API and hashtag search. |
| Instagram API with **Unified Login** | No | `graph.facebook.com` | Meta now calls this "the recommended setup for new integrations". It uses a Business Integration System User token and **requires a business portfolio** ([Unified Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login.md), [docs, undated]). It's aimed at tools that serve *client* businesses. |

**Recommendation:** use **Instagram Login** for v1. It needs no Facebook Page and is fewest moving parts. Re-evaluate only if we need the Audio API.

**Account type:** @kinsburgtown must be an Instagram **professional account** (Business *or* Creator both work) ([Overview](https://developers.facebook.com/documentation/instagram-platform/overview.md)). It must also be **public**, because private accounts receive no comment webhooks ([Webhooks setup](https://developers.facebook.com/documentation/instagram-platform/webhooks/setup.md), [docs, undated]).

### 1.2 Permissions (Instagram Login)

- `instagram_business_basic`: always required.
- `instagram_business_manage_comments`: read comments, reply to comments, `comments` webhook, private replies ([Comment moderation](https://developers.facebook.com/documentation/instagram-platform/comment-moderation.md); [Private replies](https://developers.facebook.com/docs/instagram-platform/private-replies)).
- `instagram_business_manage_messages`: DMs and the `messages` webhook ([Webhook fields matrix](https://developers.facebook.com/documentation/instagram-platform/webhooks/fields)).
- `instagram_business_content_publish`: posting Reels.

### 1.3 Webhooks

- **Fields:** `comments` (includes @mentions on Instagram Login), `messages`, `message_reactions`, `messaging_postbacks`, and others ([fields matrix](https://developers.facebook.com/documentation/instagram-platform/webhooks/fields)).
- **Can we get the commenter's username? Yes.** The `comments` payload contains `from.id` (Instagram-scoped ID), **`from.username`**, `media.id`, `media_product_type` and `text` ([Webhook examples](https://developers.facebook.com/documentation/instagram-platform/webhooks/examples), [docs, undated]).
- **DM payloads** give only `sender.id` (an IGSID), not a username ([examples](https://developers.facebook.com/documentation/instagram-platform/webhooks/examples)). To show a name we must look the user up. Plan on the IGSID as the resident key, plus the username where we have it.
- **Mechanics:** We need an HTTPS endpoint. Meta first sends a verification request (`hub.mode=subscribe`, `hub.verify_token`, and `hub.challenge` that we echo back). Every event is signed in the `X-Hub-Signature-256` header (HMAC-SHA256 using the App Secret). Failed deliveries are retried for up to **36 hours**, so the code must handle duplicates ([Webhooks setup](https://developers.facebook.com/documentation/instagram-platform/webhooks/setup.md)).
- **The app must be published/Live** to receive notifications ([setup](https://developers.facebook.com/documentation/instagram-platform/webhooks/setup.md)).

### 1.4 Private replies (an auto-DM to someone who commented)

From [Private replies](https://developers.facebook.com/docs/instagram-platform/private-replies) ([docs, undated]):
- `POST /<IG_ID>/messages` with `recipient: { comment_id }` and the message text.
- **Must be sent within 7 days** of the comment.
- **Only ONE message per commenter.** We can send follow-ups only if they reply, and only within 24 hours of their reply.
- Works on comments on posts, reels, stories, Live (only during the broadcast) and ads.
- **Rate limit: 750 private replies per hour per account** for post and reel comments ([Overview](https://developers.facebook.com/documentation/instagram-platform/overview.md)).

**Public comment replies:** `POST /<COMMENT_ID>/replies` with `message` ([Comment moderation](https://developers.facebook.com/documentation/instagram-platform/comment-moderation.md)). No per-reply limit is documented. They count against the general limit below.

### 1.5 Rate limits

([Overview](https://developers.facebook.com/documentation/instagram-platform/overview.md))
- General (non-messaging) calls: **4800 × the account's impressions** per rolling 24 hours. A small new account has fewer impressions, so a lower limit. This is a reason to prefer webhooks over polling.
- Send API: 100 calls/sec for text. Conversations API: 2 calls/sec.
- The often-quoted "200 automated DMs per hour" is **not in Meta's docs**. It appears to be a pacing limit that tools like ManyChat chose themselves ([Blotato](https://www.blotato.com/blog/instagram-dm-limits), [secondary]).

### 1.6 Standard Access vs Advanced Access: the real blocker

| | Standard Access (default, no review) | Advanced Access (App Review + Business Verification) |
|---|---|---|
| Who it serves | Accounts we own/manage, plus people with a role on the app | Anyone |
| Publish Reels to @kinsburgtown | **Yes**. Publishing lists "Advanced or Standard access" ([Content publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing.md)) | Yes |
| `comments` webhook for comments by the public | **Officially no.** "Advanced Access is required for `comments` and `live_comments` notifications" ([setup](https://developers.facebook.com/documentation/instagram-platform/webhooks/setup.md)). The older guide says the app "must have successfully completed App Review" for these fields ([older webhook guide](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-instagram)) | Yes |
| `messages` webhook / DMs with the public | **No.** "Webhooks will only be sent if the person using your app has a role on the app". Data from people without a role requires App Review approval ([Messenger-platform IG webhooks](https://developers.facebook.com/docs/messenger-platform/instagram/features/webhook/)) | Yes |
| Private replies to the public | **Assume no** (same role restriction as messaging; UNCERTAIN, test it) | Yes |
| *Polling* `GET /<media_id>/comments?fields=id,text,timestamp,username,from` on our own posts | **Likely yes** (UNCERTAIN). `username` on comments on our own media only needs `instagram_business_manage_comments` ([IG Comment reference](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment.md)). Meta also says Standard Access is fine "if you own or manage the accounts" ([Comment moderation](https://developers.facebook.com/documentation/instagram-platform/comment-moderation.md)). **Do a 10-minute test first:** a friend with no app role comments, then we poll | Yes |

**Note the conflicting docs.** Meta's [App Review page](https://developers.facebook.com/documentation/instagram-platform/app-review.md) says: "If your app is only for a business you own or manage, App Review is not required." The webhook pages, however, gate *comment webhooks* and *messages from non-role users* behind review. Our reading: we can *act on our own account* without review, but we can't *receive or send other people's data* in real time without it. Plan for review.

### 1.7 App Review and Business Verification for a solo individual

- **What review needs** ([App Review](https://developers.facebook.com/documentation/instagram-platform/app-review.md), [docs, undated]):
  - a screencast per permission
  - step-by-step test instructions and credentials
  - a use-case description
  - a visible login button
  - a 1024×1024 icon, a privacy-policy URL, a category and a business email
  - at least one successful API call per permission
  - a web app reviewers can test from outside
- **Business Verification is mandatory for Advanced Access** ([Overview](https://developers.facebook.com/documentation/instagram-platform/overview.md); [Business Verification doc](https://developers.facebook.com/docs/development/release/business-verification), required since Feb 1 2023).
  - It verifies a **business** in Meta Business Manager. Accepted documents vary by country.
  - A *registered* sole proprietorship can submit a government registration document. Self-filed or unofficial documents, and documents whose name doesn't match, are commonly rejected ([360dialog](https://docs.360dialog.com/resources/meta-business-verification), [Wati](https://support.wati.io/en/articles/11463209-why-can-t-my-business-be-verified-by-meta), [secondary]).
  - A forum report describes an **unregistered individual being rejected** ([Meta dev community](https://developers.secure.facebook.com/community/threads/838344991494404), [secondary]).
  - **In practice: register a sole proprietorship / DBA (local cost, often small but not $0) before applying. UNCERTAIN by country.**
- **Easier route (Facebook Login only):** apps that reviewers can't test (no UI) may request **only** `instagram_basic` + `instagram_manage_comments` ([Overview](https://developers.facebook.com/documentation/instagram-platform/overview.md)). That covers the comments webhook but **not DMs**. The catch is that it requires the Facebook Login setup, with a linked Facebook Page. This is a reasonable fallback if a review for messaging fails.
- **How long it takes [secondary, anecdotal]:**
  - About 1–3 days before 2025.
  - **9–19 days by mid-2026**, and Meta warns of up to ~20 days ([bundle.social, Aug 2026](https://bundle.social/blog/meta-app-review-20-days)).
  - Forum threads show 13+ days pending ([thread](https://developers.facebook.com/community/threads/3459359287566790/)).
  - Rejections for unclear screencasts are common. **Budget 3–6 weeks total, including Business Verification and one resubmission.**

### 1.8 Listing followers: confirmed impossible officially

- The IG User object has `followers_count` and **no followers edge** ([IG User reference](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user.md)). Business Discovery only gives counts for other accounts.
- **Scraping risks:**
  - Instagram's terms bar collecting data "in unauthorized ways" or by automated means without permission ([Instagram Help: scraping](https://help.instagram.com/740480200552298)).
  - A follower list is only visible **while logged in**. The *Meta v. Bright Data* ruling (Jan 2024; Meta then dropped the case) protected only **logged-out** scraping of public data ([TechCrunch](https://techcrunch.com/2024/01/24/court-rules-in-favor-of-a-web-scraper-bright-data-which-meta-had-used-and-then-sued), [MediaPost](https://www.mediapost.com/publications/article/393996/meta-abandons-lawsuit-against-bright-data-over-scr.html)). So logged-in follower scraping **breaches the terms**.
  - The realistic outcome is action blocks or a disabled @kinsburgtown, the very account the project depends on. **Don't do it.**

### 1.9 A policy risk to design around (UNCERTAIN, judgment call)

- Meta's Developer Policies (updated **Feb 3 2026**) say: "Don't participate in any program that promotes or facilitates the purchase, sale, or exchange of" likes, **followers** or **comments** ([Developer Policies](https://developers.facebook.com/devpolicy/), [docs, dated]).
- A free house in a game isn't a sale. But "**follow** us to get a house" could be read as a follower-incentive scheme. Safer framing: **"Want a house in Kinsburg? Comment MOVE IN or DM us."** Following is never a condition.
- Reviewers will also read the use-case text, so describe the app as "comment- and DM-based sign-up for an interactive town map".

---

## 2. Auto-posting a daily Reel

Source: [Content publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing.md) and [IG User /media reference](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media.md) ([docs, undated, v27.0 examples]).

**Flow:**
1. `POST /<IG_ID>/media` with `media_type=REELS` and `video_url=<public URL>`.
2. Poll `status_code` about once a minute, for up to 5 minutes.
3. `POST /<IG_ID>/media_publish` with `creation_id`.

The container expires after 24 hours. Meta *fetches* the video, so the URL must be publicly reachable when we call. Resumable upload of local files is only available on Facebook Login.

**Video specs (Reels):**

| | |
|---|---|
| Container | MP4/MOV, moov atom at the front (`ffmpeg -movflags +faststart`), no edit lists |
| Video | H.264 or HEVC, progressive, closed GOP, 4:2:0 |
| Frame rate | 23–60 fps |
| Width | ≤1920 px |
| Aspect ratio | 0.01:1–10:1, **9:16 recommended** (use 1080×1920) |
| Duration | **3 s – 15 min** |
| File size | **≤300 MB** |
| Video bitrate | ≤25 Mbps VBR |
| Audio | AAC, ≤48 kHz, mono/stereo, 128 kbps |

**Caption:** ≤2200 characters, **≤30 hashtags**, ≤20 @tags.

**Extras supported:**
- `cover_url` (custom cover image) or `thumb_offset` (pick a frame in ms)
- `share_to_feed`
- **`collaborators` (up to 3 usernames)**
- `user_tags`, `location_id`, `audio_name` (renames our original audio once)
- `is_ai_generated` (added June 22 2026)
- **Trial Reels** via `trial_params` (Dec 2025) ([changelog](https://developers.facebook.com/documentation/instagram-platform/changelog.md))

**Publishing limit:** The [content_publishing_limit reference](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit.md) says **50 per 24 h**, while one section of the publishing guide says 100. **UNCERTAIN, but irrelevant** for one reel a day. We can check live usage with `GET /<IG_ID>/content_publishing_limit`.

**Trending audio:** Possible since **June 1 2026** through the new [Instagram Audio API](https://developers.facebook.com/documentation/instagram-platform/content-publishing/audio-api). `GET /ig_audio` returns trending sounds when no query is given, and we attach one with `audio_configuration.audio_id`. Two caveats:
- **Not available on Instagram Login**, only Facebook Login or Unified Login.
- It only offers audio "authorized for third party use", which can differ from what the app shows.

For v1, bake royalty-free music into the MP4 ourselves, or switch to Facebook Login later.

**Reach penalty for API-published Reels:** **No evidence of one; the evidence is anecdotal.**
- Adam Mosseri reportedly said scheduled posts "will not affect your reach one way or the other" (Mar 2025 and Mar 2026 Q&As, reported secondhand by [Kontentino](https://www.kontentino.com/blog/does-scheduling-instagram-posts-hurt-reach/)).
- Small vendor tests found no penalty ([Hootsuite](https://blog.hootsuite.com/experiment-third-party-scheduling-instagram/), [Agorapulse](https://agorapulse.com/social-media-lab/instagram-3rd-party-tools)). All of these come from scheduler vendors.
- The documented risk is **watermarks** from other apps ([RouteNote](https://routenote.com/blog/does-instagram-penalise-tiktok-or-capcut-content/)), so don't watermark.
- Also avoid the "comment a word" engagement-bait pattern in the reel itself (see §4.3).

**Stories via API in 2026: supported.**
- `media_type=STORIES`. Images are JPEG ≤8 MB. Video is 3–60 s and ≤100 MB, 9:16 ([media reference](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media.md)).
- **No stickers** (no link, poll or location stickers).
- A daily "new residents" story is feasible.

---

## 3. $0 infrastructure

### 3.1 Free tiers (checked 2026-11-11)

| Service | Free limits | Gotchas | Source |
|---|---|---|---|
| **Cloudflare Workers** | 100k requests/day, **10 ms CPU** per request, 5 cron triggers, 50 subrequests | 10 ms is CPU time, not wall time, so waiting on fetch is free. Signature checks and DB writes fit easily | [Limits](https://developers.cloudflare.com/workers/platform/limits/), [docs, updated Oct 29 2026] |
| **Workers Static Assets** (host the Vite site) | Static requests are **free and unlimited** | Avoid `run_worker_first`, which counts against the limit | [Billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/), [docs, Nov 3 2026] |
| **Cloudflare D1** (SQLite) | 5M rows read/day, 100k rows written/day, 5 GB | Exceeding a limit errors until 00:00 UTC | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [docs, Oct 30 2026] |
| Cloudflare KV | 100k reads/day, **only 1k writes/day** | Too few writes for an event log. Use D1 | [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/), [docs, Oct 30 2026] |
| Cloudflare R2 | 10 GB, 1M writes/10M reads per month, free egress | **`r2.dev` URLs are rate-limited, "development purposes" only**. Use a custom domain or serve through the Worker | [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/), [docs, Sep–Oct 2026] |
| Cloudflare Pages | 500 builds/month | Cloudflare now steers new static sites to Workers Static Assets | [Pages limits](https://developers.cloudflare.com/pages/platform/limits/), [docs, Sep 5 2026] |
| Supabase Free | 2 projects, 500 MB DB, 5 GB egress | **Pauses after ~1 week of inactivity**. Restore window is 90 days (or 1 year; sources differ) | [Billing](https://supabase.com/docs/guides/platform/billing-on-supabase), [Pausing](https://supabase.com/docs/guides/platform/free-project-pausing) |
| Vercel Hobby | 1M function invocations, 4 h active CPU | **Hobby is "non-commercial personal use only"**, and taking payments counts as commercial. **Don't use it for Kinsburg** | [Fair use](https://vercel.com/docs/limits/fair-use-guidelines), [docs, Sep 14 2026] |
| GitHub Pages | 1 GB, 100 GB/mo | Not for "your online business" or mainly commercial sites. Fine for a fan city, risky once we sell perks | [Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) |
| **GitHub Actions** | **Public repo: standard runners free.** Private repo: $12/mo of credit (~2,000 Linux minutes) | Cron is ≥5 min apart, often **delayed** near the top of the hour. **Auto-disabled after 60 days of no repo activity** (public repos) | [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [Triggers](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) |

Netlify wasn't evaluated in depth. Cloudflare covers everything Netlify would.

**Pick: Cloudflare for everything live (site, webhook Worker, D1, cron), plus GitHub Actions for heavy jobs (reel rendering).** It's one dashboard, nothing pauses, and payments are allowed.

### 3.2 How the static site gets updated residents

**Option A (recommended): live JSON from the Worker.**
- The site fetches `/api/residents.json`, served by the Worker from D1 with `Cache-Control: max-age=60`.
- New residents appear within about a minute, with no rebuild.
- The browser's cache and Cloudflare's cache absorb load, so it stays far below 100k requests/day.
- The layout engine (`scripts/lib/city-layout.mjs`) is deterministic. Either the browser runs it on the resident list, or the Worker stores each resident's assigned plot when they join, so houses never move.

**Option B (fallback): nightly rebuild.**
- A GitHub Action exports D1 to `public/residents.json`, commits it and redeploys.
- Simpler, but residents appear the next day. The daily commit also keeps the 60-day auto-disable from triggering.

### 3.3 Recording the daily reel for free

**Plan:** a GitHub Actions cron (e.g. `17 13 * * *`; avoid minute 0):
1. Install Playwright Chromium and ffmpeg.
2. Open the live city at 1080×1920 with a `?reel=1` mode (camera fly-over, today's new residents highlighted).
3. Capture frames.
4. Use ffmpeg to add the caption overlay and music, and encode H.264/AAC with `+faststart`.
5. Upload the MP4 where Meta can fetch it (R2 behind our domain, or a Worker route).
6. Call the publishing API.

**Feasibility:**
- The city uses **Canvas 2D** (`getContext('2d')` in `src/`), not WebGL. CPU-only runners handle 2D canvas fine. The WebGL slowness people report on runners comes from software GPU emulation (SwiftShader) ([write-up](https://backiee.wasmer.app/https_davesnider_com/posts/gputests), [secondary]).
- **Don't rely on real-time screen recording.** Frame rate on a CPU runner is unpredictable. Use **deterministic frame stepping**: the page exposes `window.renderFrame(t)`, Playwright screenshots each frame, and ffmpeg stitches them at 30 fps. Output is smooth no matter how slow the runner is.
- Rough budget [estimate, not measured]: 20 s × 30 fps = 600 frames at ~0.1–0.3 s each, so ~1–3 min, plus ~1 min of encoding. That's under 10 minutes per run. Free on a public repo, and ~300 min/month on a private one, well inside 2,000.
- Playwright's built-in `recordVideo` also works headless if we accept less smoothness ([Playwright screencast](https://testdino.com/blog/playwright-screencast), [secondary]).

---

## 4. Payments for cosmetic perks

### 4.1 Stripe Payment Links (recommended)

- **Custom fields** ([Customize Payment Links](https://docs.stripe.com/payment-links/customize), [docs, undated, current]):
  - Types: Text (≤255 characters), Numbers or Dropdown.
  - They can be marked required, and they're included in the **`checkout.session.completed`** webhook. Add a required Text field "Your Instagram @handle".
  - We can also put `client_reference_id`/UTM parameters in the link URL, e.g. a per-resident link from the city UI.
- **Fulfillment** ([After payment](https://docs.stripe.com/payment-links/post-payment)):
  - Listen to `checkout.session.completed`. Also listen to async events only if we enable bank debits.
  - We can redirect back to the city with `{CHECKOUT_SESSION_ID}` in the URL.
  - The Worker verifies the Stripe signature, matches the handle to a resident in D1 and flips the perk on.
- **Fees (US):** **2.9% + 30¢**, +1.5% for international cards, +1% for currency conversion. No monthly fee ([Stripe US pricing](https://stripe.com/us/pricing), from the search snippet, plus secondary confirmations). On a $3 perk you lose about 39¢ (13%). **Price perks at $5 or more, or offer bundles.**
- **Individuals:** Stripe accounts can be opened as an individual / sole proprietor using a personal SSN/tax ID and a bank account. Standard payouts go to the bank on a rolling schedule. Instant payouts cost extra: 1% or 1.5% (sources conflict, UNCERTAIN). *[general Stripe onboarding knowledge; check during signup]*
- **Sales tax / VAT:** With plain Stripe, *we* are the seller and owe any digital-goods tax. **Stripe Managed Payments** makes Stripe the merchant of record for digital goods, including video-game items, and works with Payment Links ([Managed Payments](https://docs.stripe.com/payments/managed-payments), [eligibility](https://docs.stripe.com/payments/managed-payments/eligibility)). It costs about **+3.5%** on top ([pricingsaas diff, Feb 2026](https://pricingsaas.com/companies/stripe/diffs/2026W08), [secondary]) and requires an eligibility review. Consider it once revenue matters.

### 4.2 Alternatives

| Option | Fees | Automation | Effort for owner |
|---|---|---|---|
| **Ko-fi** (what @meadowvalecity uses) | 0% on one-time tips. **5% on shop items** on the free tier (Gold at $12/mo removes it). Plus PayPal/Stripe processing ([Ko-fi fees](https://help.ko-fi.com/hc/en-us/articles/360002506494-Does-Ko-fi-take-a-fee)) | Webhook sends form-encoded `data` JSON with `verification_token`, `type` (Donation / Shop Order…), `message` and `from_name` ([spec](https://apis.io/apis/ko-fi/ko-fi-webhook/), [secondary]). The handle has to come from the message field, so it's messier | Lowest. Fans already know Ko-fi |
| Lemon Squeezy | ~5% + 50¢, merchant of record ([secondary](https://devtoollab.com/blog/best-merchant-of-record-platforms)) | Good webhooks | Owned by Stripe since 2024 and being folded into Managed Payments. **Not a good place to start new in 2026** |
| Gumroad | ~10% + 50¢ (+ processing) ([secondary](https://dodopayments.com/blogs/gumroad-fees-explained)) | "Ping" webhook | Easy, but the most expensive |

**Least effort for an individual:** Ko-fi shop (no code). **Best for automation:** Stripe Payment Links. Its custom handle field makes fulfillment exact. **v1 pick: Stripe.**

### 4.3 Instagram rules: selling perks and "comment to win"

- **Engagement bait:** Meta demotes posts that "explicitly request engagement (such as votes, shares, comments, tags, likes…)" ([Meta Transparency](https://transparency.meta.com/features/approach-to-ranking/content-distribution-guidelines/engagement-bait/), Facebook guideline). Instagram's Recommendations Guidelines list engagement bait as **not eligible for recommendation** ([Instagram Help](https://help.instagram.com/313829416281232)).
  - In 2024 Instagram named "asking people to comment with a specific word, number, or emoji" as an example.
  - It then clarified that keyword-to-DM tools (ManyChat-style) used to genuinely connect or deliver something are *not* the target. The target is hacking reach ([Social Media Today, Jun 2024](https://www.socialmediatoday.com/news/instagram-clarifies-advice-single-word-ctas-longer-reels/718151/), [secondary]).
  - **The risk is losing Explore/Reels reach, not a ban. UNCERTAIN where the line sits.**
- **Safer CTAs:**
  - Do: "Want a house? Comment **MOVE IN** and we'll build it tonight." This is a genuine request with a real deliverable.
  - Better for reach: put the CTA in the **caption or a pinned comment**, not as giant on-video text.
  - Rotate the wording, and mix in Reels with no CTA at all (pure city footage).
  - Avoid: "Comment, like AND share to win", "tag 3 friends", "follow to get a house", or any giveaway that needs engagement to enter.
- **Selling cosmetic perks:** No Instagram rule bans promoting your own digital goods.
  - Keep it clearly opt-in. No gambling or loot boxes: Meta's Developer Policies require written permission for real-money games of chance ([Developer Policies](https://developers.facebook.com/devpolicy/), Feb 3 2026).
  - Don't sell **followers, likes or comments**, even indirectly ("pay to be featured *and* get a shoutout follow").
  - If we ever run a giveaway, the **Instagram Promotion Guidelines** apply: official rules, a release of Instagram, no inaccurate tagging. Linked from the [Developer Policies](https://developers.facebook.com/devpolicy/); the help page wouldn't render for us, so check it before running one.
- **Messaging policy:** Bots must honor opt-outs immediately and must not spam. Message tags can't carry promotions ([Developer Policies §5](https://developers.facebook.com/devpolicy/)). **Never** send sales pitches through private replies. Keep the private reply to "Your house is ready at <link>".

---

## 5. Recommended v1 architecture and build order

```
Instagram ──comments/DM webhooks──▶ Cloudflare Worker ──▶ D1 (residents, events, perks)
Stripe ────checkout.session.completed──▶ same Worker
Browser ◀── static site (Workers Static Assets) + /api/residents.json (Worker, cached 60 s)
GitHub Actions (daily cron) ──▶ Playwright frames + ffmpeg ──▶ MP4 on our domain ──▶ IG Content Publishing API
```

### Phase 0: owner, by hand (about 1–2 hours, mostly once)
1. **Switch @kinsburgtown to a Professional account** (Creator is fine) and make sure it's **public**. In Instagram settings, allow access to messages for connected tools. *(The setting name may differ; it's a commonly reported prerequisite, UNCERTAIN.)*
2. **Create accounts:** Cloudflare (free), GitHub (public repo for the city), Meta developer account (developers.facebook.com, with 2FA on), Stripe.
3. **Create a Meta app** (Business type) → add the "Instagram API with Instagram Login" product → add @kinsburgtown. The AI writes exact click-by-click steps.
4. **Connect Stripe:** identity and bank verification, create products/prices, create a Payment Link with a required "Instagram @handle" field, then paste the webhook signing secret into Cloudflare secrets.
5. **Start Business Verification early.** It's the long pole, and may require registering a sole proprietorship/DBA first (local fees; UNCERTAIN by country).

### Phase 1: works now with Standard Access (AI builds, fully automated)
6. Move the site to **Cloudflare Workers Static Assets**. Add a **D1** `residents` table, and serve `/api/residents.json` from D1, assigning a plot when someone joins.
7. **Daily Reel pipeline:** add the `?reel=1` deterministic render mode, then GitHub Actions → Playwright → ffmpeg → publish via API. The caption template includes "Comment MOVE IN for a house" and today's new residents (as @tags ≤20, or plain names).
8. **Comment polling job:** Worker cron every 10–15 min reads comments on our latest N posts (`fields=id,text,timestamp,username,from`) and adds anyone who wrote "MOVE IN" (case/emoji-tolerant) to D1. *First run the 10-minute test from §1.6.* If it works, the core loop is automated **before** App Review.
9. Optional: a **public comment reply** ("🏠 Built! Find it at kinsburg.xyz/@handle") on our own posts. Test under Standard Access, and keep replies varied and rate-limited to avoid spam flags.
10. **Stripe webhook** → Worker → mark the perk in D1 → the city shows it within about 60 s.

### Phase 2: needs Advanced Access (App Review + Business Verification)
11. Build a tiny "Connect Instagram" page plus privacy policy and terms pages (reviewers need a testable web flow). Record screencasts and submit `instagram_business_manage_comments` + `instagram_business_manage_messages`. **Expect 2–3 weeks, plus possible resubmission.**
12. After approval:
    - Switch from polling to the **`comments` webhook** (real time).
    - Add a **private reply** ("Your house is ready 🏡 <link>"), one per commenter, within 7 days.
    - Add a **DM join** ("MOVE IN" in DMs → `messages` webhook → reply).
13. If review for messaging fails: fall back to Facebook Login with a linked Page and request only `instagram_basic` + `instagram_manage_comments`, which Meta allows for apps with no UI ([Overview](https://developers.facebook.com/documentation/instagram-platform/overview.md)). That still gives real-time comment webhooks.

### What stays manual (a few minutes a week)
- Reviewing the moderation queue (spam/abusive handles; the AI adds a block list).
- Approving reel caption templates now and then, and replying to genuine DMs.
- Renewing anything that expires. **Instagram Login tokens are long-lived (~60 days) and must be refreshed.** The AI should automate the refresh and email the owner if it fails *[general Meta token knowledge; verify in the get-started docs]*.
- Making a small commit monthly if we use the nightly-rebuild option (prevents GitHub cron auto-disable).

### Open questions to test (cheap, do first)
- [ ] Can Standard Access poll `username` on comments by a non-role user? (§1.6)
- [ ] Can Standard Access send a public comment reply or a private reply to a non-role user?
- [ ] Is Business Verification possible in the owner's country without a registered business?
- [ ] How long does a 20 s 1080×1920 frame-stepped render take on `ubuntu-latest`?
