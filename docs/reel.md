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

## The three launch Reels

The scripted launch Reels from [launch-content.md](launch-content.md) §3 are cut from the city by one command. It renders "Yours is still dark", "Comment two words" and "The city picks your job" to `out/launch/`, each with a cover image and caption file:

```bash
npm run reel:launch
```

How they're made:
- **Narration** in the same voice as From Day 30 (Kokoro "am_fenrir" at 0.86). It's made on this computer by `scripts/reel/voice.py`, using the model from the From Day 30 project, so it has no cost.
- **Timing:** every camera move and caption is timed from the narration.
- **Camera:** one continuous camera per scene (hold, smooth glide, hold), with close-ups on houses. Soft dissolves are used only where the time of day jumps.
- **Text:** one style throughout, the same as From Day 30. Short captions in a fixed spot follow the voice, with the last word in gold. A small info bar sits at the top, and the address plate, comment bubble and card share one centre column.

Run it again with `-- --url https://kinsburg.com` once real people live there, so the houses, names and numbers are real. There's a quiet music bed under the voice; you can add your own sound in the Instagram app.

## Hero shout-outs

The recorder also reads the city's town data (`<site>/api/city/town.json` for a live site, `/town.json` for a local build). Incidents that residents resolved in the last 26 hours get one or two short lines in the caption, naming the responders as plain names (no @-tags), for example "Last night the.early.gecko and nimble.waffle put out a kitchen fire 🚒." Then comes "Firefighters, police, doctors: comment RESPOND when the city needs you." and, if an open incident still needs people, one "Right now: …" line. The MOVE IN line stays last. On the plain "Day N" post the camera also flies to the latest rescued house. If the town data is missing or old-format, nothing is added and the recording carries on. Use `--no-heroes` to leave it all out. The wording lives in `scripts/reel/series.mjs` (`heroLines`, `openCall`).

## Run it from GitHub by hand

Actions tab → **Daily reel** → **Run workflow**. "Record only" is ticked by default. Every run keeps the MP4 as a downloadable artifact for 14 days, so you can watch it before turning posting on.

## Costs and limits

- **GitHub:** free on a public repository. A run takes about 5 minutes.
- **Hosting:** Cloudflare KV, free. Each file is capped at 25 MB, so the encoder limits the bitrate to 8 Mbps; a 20 s reel is about 20 MB.
- **GitHub pauses scheduled jobs after 60 days without a commit** in a public repository. Any commit resets it. GitHub emails a warning first.
- **Instagram:** Meta allows at least 50 API posts a day (its own pages disagree on 50 or 100); we use one.
