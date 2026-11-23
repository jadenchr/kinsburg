# Running the town

Everyday jobs, each one command. Replace `YOUR_ADMIN_TOKEN` with the admin password you stored in Cloudflare. Or just tell me what you want and I'll run it.

## See what's happening

```bash
curl -s https://kinsburg.com/admin/stats -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

This shows the resident count, recent events, payments, and **posters waiting to be printed**.

## Put perks on sale

After creating the Stripe Payment Links (see SETUP step 6), paste their URLs and prices in one go. The shop in the town hall and the "Give this house a gold star" button on cards appear on their own.

```bash
curl -s -X POST https://kinsburg.com/admin/town -H "Authorization: Bearer YOUR_ADMIN_TOKEN" -H "content-type: application/json" -d '{"perkLinks":{"star":{"url":"https://buy.stripe.com/...","price":"$5"},"goldRoof":{"url":"https://buy.stripe.com/...","price":"$12"},"monument":{"url":"https://buy.stripe.com/...","price":"$25"},"street":{"url":"https://buy.stripe.com/...","price":"$50"},"poster":{"url":"https://buy.stripe.com/...","price":"$39"}}}'
```

Only `buy.stripe.com` links are accepted.

## Run a vote

1. **Post the vote on Instagram** ("Who should be mayor? Comment A or B"), then copy the post's ID from its link.
2. **Open it in the city.** For a decision, use `"kind":"decision"` and no `handle`s.

   ```bash
   curl -s -X POST https://kinsburg.com/admin/poll -H "Authorization: Bearer YOUR_ADMIN_TOKEN" -H "content-type: application/json" -d '{"id":"mayor-1","kind":"election","question":"Who should be mayor?","mediaId":"POST_ID","closesISO":"2026-11-20T18:00:00Z","options":[{"key":"A","label":"@first_candidate","handle":"first_candidate"},{"key":"B","label":"@second_candidate","handle":"second_candidate"}]}'
   ```

3. **Votes count by themselves.** Every 15 minutes, residents' comments like "A", "vote B" or "@second_candidate" are counted, one per resident; the first one counts. Results show live in the town hall.
4. **The vote closes by itself** at `closesISO`. An election makes the winner mayor. A tie goes to the option listed first.

Rules that keep it fair, and keep Instagram happy:
- Only residents vote, once each.
- Likes don't count.
- Never sell votes. Perks are just for looks.

## Sell a billboard

A sponsor's line appears on the town square and in every daily Reel, for up to 90 days:

```bash
curl -s -X POST https://kinsburg.com/admin/sponsor -H "Authorization: Bearer YOUR_ADMIN_TOKEN" -H "content-type: application/json" -d '{"name":"Bean There","message":"Fresh coffee on Kinsfolk Avenue","url":"https://example.com","days":14}'
```

Keep the message under 40 characters so it fits on two lines. To end one early, post `{"id":1}` to `/admin/sponsor/end`.

## Print a poster

When stats show a poster order:

1. Make the print file (3600×4800 px, 12×16 in at 300 dpi). It's saved in `out/`:

   ```bash
   node scripts/poster.mjs --handle their_handle --url https://kinsburg.com
   ```

2. Upload it to a print-on-demand service (Printful, Gelato or Prodigi) with the shipping address from Stripe. Pay for the print from the sale.
3. Mark the order done:

   ```bash
   curl -s -X POST https://kinsburg.com/admin/order/done -H "Authorization: Bearer YOUR_ADMIN_TOKEN" -H "content-type: application/json" -d '{"id":1}'
   ```

In the poster's Stripe Payment Link, turn on **Collect shipping address**.

## Remove someone

If they ask (or are abusive), their name goes and the lot stays empty, so nobody's address changes:

```bash
curl -s -X POST https://kinsburg.com/admin/block -H "Authorization: Bearer YOUR_ADMIN_TOKEN" -H "content-type: application/json" -d '{"handle":"their_handle","evict":true}'
```

After Meta approves the app, people can do this themselves by messaging **MOVE OUT**.

## Who may appear in videos (CAST ME)

People give permission by commenting **CAST ME** on any post (it works next to MOVE IN, too). See who has:

```bash
curl -s https://kinsburg.com/admin/cast -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

If someone DMs to take it back, remove them. An old CAST ME comment won't add them again; only a new one will:

```bash
curl -s -X POST https://kinsburg.com/admin/cast -H "Authorization: Bearer YOUR_ADMIN_TOKEN" -H "content-type: application/json" -d '{"handle":"their_handle","remove":true}'
```

More in [in-this-town.md](in-this-town.md).

## After Meta approves the app

In `wrangler.jsonc`, set these to `"true"`. Then I'll deploy, or you commit and push.

- `IG_DM_ENABLED`: lets people send MOVE IN or MOVE OUT as a message, and records the **Follower** badge.
- `IG_PRIVATE_REPLY_ENABLED`: sends one private "your house is ready" reply to each new resident who comments.

Following is never required for a house. Followers get a badge, and everyone else sees a friendly "Follow @kinsburgtown to watch your house grow".

## Jobs and pets

Residents run these themselves by commenting on any @kinsburgtown post:

- `JOB DOCTOR`, `JOB POLICE`, `JOB FIREFIGHTER`, `JOB TEACHER`, `JOB VET`, or any job on the list. The first choice is always allowed; after that, one change a week. Someone who isn't a resident yet moves in with that job.
- `PET DOG`, `PET CAT`, `PET BUNNY`: free. `NO PET` removes it.
- `PET FOX`, `PET OWL`, `PET GOLDEN`: only after buying that pet. Until then the comment is ignored.
- One comment can do everything: `MOVE IN JOB DOCTOR PET DOG`.

Tapping the hospital, school, vet, KPD or KFD on the map lists who works there.

**Sell rare pets.** Make a Stripe Payment Link per rare pet (same custom `Instagram @handle` field as the perks) and map it in `STRIPE_PERKS` in `wrangler.jsonc`, for example `"plink_abc": "pet:fox"`. The buyer moves in if needed, owns the pet for good, and it appears in their yard.

**By hand** (a manual sale, or fixing a mistake):

```bash
curl -s -X POST https://kinsburg.com/admin/pet -H "Authorization: Bearer YOUR_ADMIN_TOKEN" -H "content-type: application/json" -d '{"handle":"someone","pet":"fox","own":true}'
```

```bash
curl -s -X POST https://kinsburg.com/admin/job -H "Authorization: Bearer YOUR_ADMIN_TOKEN" -H "content-type: application/json" -d '{"handle":"someone","job":"Police officer"}'
```

## The city simulation

Every 15 minutes, after checking comments, the city takes a step:

- **Stats** (health, safety, education, happiness, 0 to 100) drift toward what the town's staffing supports. More doctors and nurses means better health, more police and firefighters better safety, more teachers and librarians better education. People who actually respond or work shifts count double. Happiness follows the others, plus pets, minus unrepaired damage.
- **Incidents** start at residents' houses, a couple a day in a small town and more as it grows: kitchen fires, break-ins, fender-benders, flu weeks, lost pets, exam weeks. Low stats invite more of the matching trouble.
- **Residents respond** by commenting `RESPOND` (or "on my way", "on duty") on any post. Only the right jobs count: firefighters for fires, police for break-ins, and so on. When enough have responded, it's resolved: each responder earns 10 town coins, the stat goes up, and they count toward "of the week" titles.
- **If nobody comes in time**, it fails and the stat drops. A failed fire leaves damage (scaffolding on the house) until a carpenter responds; that pays 15 coins.
- **RESPOND with nothing to answer** is a paid shift: 2 coins, once a day.
- **Town coins** are pretend money: never sold, never cashed out. 150 coins buys a rare pet (`PET FOX`, `PET OWL`, `PET GOLDEN`).

See it all in the Town hall panel ("City status") and on the map. The rules (chances, rewards, deadlines) are in `shared/sim.mjs`.

**Admin tools:**

```bash
curl -s https://kinsburg.com/admin/sim -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

Start a specific incident (for a Reel, or to wake the town up). `target` and `hours` are optional:

```bash
curl -s -X POST https://kinsburg.com/admin/sim/start -H "Authorization: Bearer YOUR_ADMIN_TOKEN" -H "content-type: application/json" -d '{"kind":"fire","target":"someone","hours":4}'
```

Give coins (a giveaway prize), or take them back with a negative number:

```bash
curl -s -X POST https://kinsburg.com/admin/coins -H "Authorization: Bearer YOUR_ADMIN_TOKEN" -H "content-type: application/json" -d '{"handle":"someone","add":50}'
```

To pause incidents starting on their own, set `SIM_RANDOM_INCIDENTS` to `"false"` in `wrangler.jsonc` and deploy.

## Mayor, elections and protests

It all runs itself:

- **Elections.** When there's no mayor (or the two-week term ends), nominations open for 3 days: residents comment `RUN FOR MAYOR` on any post (up to 6). Then everyone votes for 2 days by commenting `VOTE @name` on any post, one vote each. The winner is mayor for 14 days. A lone candidate wins unopposed; with nobody standing, nominations get extended.
- **Approval** is how the city is doing (the four stats) minus the share of active residents protesting.
- **Protests.** Unhappy residents comment `PROTEST` (once per person per term). When at least 5 people, and a quarter of the residents active this week, have protested in 7 days, a **recall election** starts at once; the mayor may run again. Protests only ever come from real comments.
- **The mayor's power.** Once a day the mayor can comment `FUND HEALTH`, `FUND SAFETY`, `FUND EDUCATION` or `FUND PARKS`: 200 coins from the treasury raise that stat by 6.

**Announcements.** When an incident starts or an election moves on, @kinsburgtown comments under its latest post ("🔥 Kitchen fire at @sam's house! Firefighters: comment RESPOND (2 needed)."). They share the welcome replies' pace (and pause with them if Instagram pushes back), one per 15-minute check, and anything older than 12 hours is dropped. Turn them off with `IG_CALLS_ENABLED` = `"false"` in `wrangler.jsonc`.

**Admin tools:**

```bash
curl -s -X POST https://kinsburg.com/admin/election/start -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

Ends the current phase now (nominations to voting, voting to result):

```bash
curl -s -X POST https://kinsburg.com/admin/election/advance -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

Say something under the latest post, and see what was said:

```bash
curl -s -X POST https://kinsburg.com/admin/announce -H "Authorization: Bearer YOUR_ADMIN_TOKEN" -H "content-type: application/json" -d '{"text":"Kinsburg turns 100 residents today 🎉"}'
```

```bash
curl -s https://kinsburg.com/admin/announcements -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

## How houses grow

Every comment a resident leaves on our posts counts. At 3 comments the house gets a second storey, at 10 a third, and at 30 a fourth. Only the number of comments is stored, never what they say.

## Comment replies

**Routine welcome replies are off** (`IG_REPLY_ENABLED` is `false` in wrangler.jsonc): Instagram kept blocking the account for bursts of replies, so new residents are shouted out in the daily Reels instead. Reply by hand to the comments that matter, up to the daily cap (see "Hand-picked replies" below). With replies switched back on, Kinsburg replies to every MOVE IN comment, at a human pace: at most 2 replies per 15-minute check, a few seconds apart, and at most 80 a day. Instagram blocks accounts that post bursts of similar comments, so this pace is deliberate. Comments that miss out (over the limit, or while paused) wait in a queue and get their reply on a later check.

If Instagram blocks commenting anyway, Kinsburg stops trying: replies pause for 6 hours, then 12, 24 and up to 48 if it happens again, and continue on their own afterwards. Retrying into a block only makes it longer.

See what's waiting, without posting anything:

```bash
curl -s -X POST https://kinsburg.com/admin/replies -H "Authorization: Bearer YOUR_ADMIN_TOKEN" -H "content-type: application/json" -d '{"dryRun":true}'
```

It lists the queued MOVE IN replies, other comments nobody has answered (those never get an automatic reply, so answer them yourself), and `pace`: replies sent today and whether replies are paused.

Run a comment check now instead of waiting up to 15 minutes:

```bash
curl -s -X POST https://kinsburg.com/admin/check-comments -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**The alarm:** the **Health check** workflow on GitHub runs every 6 hours. It fails, and GitHub emails you, when Instagram is disconnected, keeps blocking replies for 24 hours or more, or more than 40 replies are waiting.

### Hand-picked replies

The dry run above lists unanswered comments with their `id`. Reply to one (it counts toward the daily cap and waits out any Instagram block):

```bash
curl -s -X POST https://kinsburg.com/admin/reply -H "Authorization: Bearer YOUR_ADMIN_TOKEN" -H "content-type: application/json" -d '{"commentId":"17900000000000000","message":"Yes! Comment MOVE IN and you are in 🏡"}'
```

## Build what you ask

Comments that ask for something the city can build ("build a pool", "can we get a ferris wheel", "Eiffel Tower!") become requests for one of 22 kinds (shared/builds.mjs). Every day after 12:00 UTC the 3 kinds whose requests have the most Instagram likes in total get built; requests older than 7 days drop out. The browser puts build #N on build site #N, so nothing ever moves. The 19:17 UTC "Built today" Reel flies to each one and names who asked first.

```bash
# list builds and open requests
curl -s -X POST https://kinsburg.com/admin/builds -H "Authorization: Bearer YOUR_ADMIN_TOKEN" -H "content-type: application/json" -d '{}'
# build today's favourites now instead of waiting for 12:00 UTC
curl -s -X POST https://kinsburg.com/admin/builds -H "Authorization: Bearer YOUR_ADMIN_TOKEN" -H "content-type: application/json" -d '{"run":true}'
# hide a build (its site stays reserved, nothing moves)
curl -s -X POST https://kinsburg.com/admin/builds -H "Authorization: Bearer YOUR_ADMIN_TOKEN" -H "content-type: application/json" -d '{"remove":12}'
```

The caption invites ideas in the comments but never asks for likes: Instagram demotes "like to vote" posts.

## Bestie neighbours

"MOVE IN @friend" moves the commenter in and holds the next plot for the friend for 7 days (the map shows "Saved for a bestie", without the name). When the friend comments MOVE IN themselves, they move in next door and both houses show each other as besties. A friend is never added without asking. If nobody claims a hold, the lot stays empty: addresses never move. Two people who already live here become besties with "MOVE IN @friend" too, without a hold.

## Promos and sponsors email

hello@kinsburg.com forwards to info.jadenn@gmail.com through Cloudflare Email Routing (free). It's in the bio and on the site.
