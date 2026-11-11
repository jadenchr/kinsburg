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

## After Meta approves the app

In `wrangler.jsonc`, set these to `"true"`. Then I'll deploy, or you commit and push.

- `IG_DM_ENABLED`: lets people send MOVE IN or MOVE OUT as a message, and records the **Follower** badge.
- `IG_PRIVATE_REPLY_ENABLED`: sends one private "your house is ready" reply to each new resident who comments.

Following is never required for a house. Followers get a badge, and everyone else sees a friendly "Follow @kinsburgtown to watch your house grow".

## How houses grow

Every comment a resident leaves on our posts counts. At 3 comments the house gets a second storey, at 10 a third, and at 30 a fourth. Only the number of comments is stored, never what they say.
