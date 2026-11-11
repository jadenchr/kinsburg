# Going live: your setup checklist

Everything here needs your own accounts, so only you can do it. It takes about 2 hours in total, spread over a few days because of waiting on Meta. Everything is free except the domain (about $10 a year) and Stripe's fee on each sale.

Do the steps in order. When a step says "send me", paste the value into our chat. **Never paste passwords or API keys into chat**: put secrets in with the commands shown, which ask for them privately.

---

## 0. Fill in the policy pages (5 minutes)

Stripe and Meta both check that you have a privacy policy, terms and a refund policy. They're written: [privacy](../public/privacy/index.html), [terms](../public/terms/index.html) and [refunds](../public/refunds/index.html). Each has highlighted blanks: your full name or business name, your country and a contact email. Send me those three things and I'll fill them in.

They're a sensible starting point, not legal advice. If you start making real money, have a local lawyer look them over.

## 1. Instagram (5 minutes)

1. In the Instagram app: **Settings → Account type and tools → Switch to professional account → Creator**.
2. Make sure the account is **public**.
3. In **Settings → Messages and story replies → Message controls**, allow connected tools to access messages, if that option is shown.

## 2. Start Meta business verification now (it's the slow part)

Automatic replies and joining by DM need Meta's App Review, and that needs **Business Verification**. Meta has rejected individuals who aren't a registered business, so:

- If you already have a registered business (or sole proprietorship), keep its documents ready.
- If not, look up what a sole proprietorship or DBA costs where you live.

Kinsburg works without this: people still move in by commenting MOVE IN, picked up every 15 minutes. Verification only adds instant replies and DM joining. Plan on 3–6 weeks.

## 3. GitHub (15 minutes)

1. Create a free account at github.com.
2. Create a **public** repository called `kinsburg`. It must be public: the daily video recording is free only on public repos.
3. Send me the repository's address, and I'll give you the exact commands to upload this folder.

## 4. Cloudflare (30 minutes)

1. Create a free account at dash.cloudflare.com.
2. **Domain:** in Cloudflare, go to **Domain Registration → Register Domains** and buy `kinsburg.com` (Cloudflare sells at cost). If it's taken, pick another and tell me.
3. In this folder, in Terminal, log in:

   ```bash
   npx wrangler login
   ```

4. Create the database, then paste the `database_id` it prints into `wrangler.jsonc` (or send it to me):

   ```bash
   npx wrangler d1 create kinsburg
   ```

5. Create the video storage, then paste the `id` it prints into `wrangler.jsonc` under `REELS`:

   ```bash
   npx wrangler kv namespace create REELS
   ```

6. Start the real city, empty except @kinsburgtown as resident #1:

   ```bash
   node scripts/seed-d1.mjs real --remote --yes
   ```

7. Make an admin password for yourself (any long random text) and store it. It asks for the value privately:

   ```bash
   npx wrangler secret put ADMIN_TOKEN
   ```

8. Put the site online:

   ```bash
   npx vite build && npx wrangler deploy
   ```

9. In the Cloudflare dashboard: **Workers → kinsburg → Settings → Domains & Routes → Add → Custom domain → kinsburg.com**.

Open kinsburg.com: the city should show @kinsburgtown's house.

## 5. Meta developer app (30 minutes)

1. Go to developers.facebook.com, log in, and turn on two-factor authentication.
2. **My Apps → Create app → Other → Business**, and name it "Kinsburg".
3. Add the product **Instagram → API setup with Instagram login**.
4. Under **Generate access tokens**, add @kinsburgtown, then copy the **access token** and the **Instagram user ID**.
5. Store them (each asks for the value privately):

   ```bash
   npx wrangler secret put IG_ACCESS_TOKEN
   ```

   ```bash
   npx wrangler secret put IG_USER_ID
   ```

6. From **App settings → Basic**, store the **App secret**:

   ```bash
   npx wrangler secret put IG_APP_SECRET
   ```

7. Make up any word as a webhook password and store it:

   ```bash
   npx wrangler secret put IG_VERIFY_TOKEN
   ```

8. **The important test (10 minutes):** ask a friend who has nothing to do with the app to comment **MOVE IN** on one of your posts. Within 15 minutes they should appear in the city. Tell me whether they did; it decides whether the free path works before App Review.

The token lasts about 60 days. The Worker renews it every Monday on its own.

## 6. Stripe (30 minutes)

1. Create an account at stripe.com as an individual or sole proprietor, and finish identity and bank verification.
2. **Product catalogue → Add product**, once per perk. Suggested starting prices: Gold star $5, Golden roof $12, Name on the Founders Monument $25, Name a street $50 (limit 1 per street).
3. For each product, create a **Payment link**. Under **Advanced → Add custom field**, add a required **Text** field labelled `Instagram @handle`. The Worker finds the field by the word "Instagram" in its label.
4. Add one more product: **City poster** (suggested $39). In its Payment Link, turn on **Collect shipping address**.
5. Send me each Payment Link's id (it starts with `plink_`) and which perk it is. I'll put them in `STRIPE_PERKS` and switch the shop on. The command is in [RUNNING.md](RUNNING.md), "Put perks on sale".
6. **Developers → Webhooks → Add endpoint**: URL `https://kinsburg.com/webhooks/stripe`, event `checkout.session.completed`. Copy the **signing secret** and store it:

   ```bash
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   ```

7. Buy the $5 star yourself with your own handle. Your house should get a gold star within a minute. Refund it afterwards in Stripe.

## 7. GitHub secrets for the automations (10 minutes)

In the repository: **Settings → Secrets and variables → Actions**.

- **Variables:**
  - `KINSBURG_URL` = `https://kinsburg.com`
- **Secrets:**
  - `ADMIN_TOKEN`, `IG_ACCESS_TOKEN`, `IG_USER_ID`: the same values as in Cloudflare.
  - `CLOUDFLARE_API_TOKEN`: create it in Cloudflare at **My Profile → API Tokens** with the "Edit Cloudflare Workers" template, then add **D1: Edit**.
  - `CLOUDFLARE_ACCOUNT_ID`: shown on the Cloudflare dashboard's right side.

After that:

- Every change I push deploys itself.
- The daily Reel posts at 13:17 UTC. Run it once by hand first (Actions → Daily reel → Run workflow, "Record only" ticked) and watch the video it saves.

---

## What stays manual (a few minutes a week)

- **Glance at new residents.** Run this, which asks for nothing (replace `YOUR_ADMIN_TOKEN` with your admin password):

  ```bash
  curl -s https://kinsburg.com/admin/stats -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
  ```

- **Block an abusive handle.** Ask me, or use `/admin/block`.
- **Reply to real DMs and comments** yourself. The bot never sends sales messages.
- **Commit something at least every 60 days**, or GitHub pauses the daily Reel. It emails first.
