# The daily Reel

Every day at 13:17 UTC a GitHub Action records a 20-second video of the live city and posts it to @kinsburgtown. Nobody has to be awake for it.

## What happens

1. **Record.** Headless Chrome opens the live city in reel mode (`?reel=1`). The page draws one exact frame at a time, so a slow computer makes the same video as a fast one. The default shot opens on the whole town at golden hour, glides down to the newest residents' houses (ringed in gold) as the lights switch on, and ends on the lit-up town at night.
2. **Finish.** ffmpeg adds the title ("Lights on, night 12") and the resident count, plus a quiet generated ambient track. It then saves an Instagram-ready MP4 (1080×1920, H.264/AAC), a cover image and the caption.
3. **Host.** The video is uploaded to the Worker, which serves it at `kinsburg.com/media/reel-DATE.mp4` for 7 days. Instagram downloads it from there.
4. **Post.** The Instagram API creates the Reel, waits until Instagram has processed it, then publishes it.

The caption names a few of the day's newest residents (as plain names, no tag spam) and ends with the MOVE IN line. The wording comes from `scripts/reel/series.mjs`.

## Run it yourself

```bash
npx vite build
```

```bash
node scripts/reel/record.mjs --duration 8
```

The video, cover, caption and a report land in `out/`. Useful options:

- `--hour 21.5`: a fixed time of day. `--hour 17-21.7` makes a time-lapse.
- `--focus name1,name2`: fly to these residents.
- `--url https://kinsburg.com`: record the live site instead of your local build.
- `--music file.mp3`: use your own track. Use royalty-free music only. Instagram's trending sounds can't be added through the API.

Check what would be posted, without posting anything:

```bash
node scripts/reel/publish.mjs
```

It only posts when you add `--publish`.

## Run it from GitHub by hand

Actions tab → **Daily reel** → **Run workflow**. "Record only" is ticked by default. Every run keeps the MP4 as a downloadable artifact for 14 days, so you can watch it before turning posting on.

## Costs and limits

- **GitHub:** free on a public repository. A run takes about 5 minutes.
- **Hosting:** Cloudflare KV, free. Each file is capped at 25 MB, so the encoder limits the bitrate to 8 Mbps; a 20 s reel is about 20 MB.
- **GitHub pauses scheduled jobs after 60 days without a commit** in a public repository. Any commit resets it. GitHub emails a warning first.
- **Instagram:** Meta allows at least 50 API posts a day (its own pages disagree on 50 or 100); we use one.
