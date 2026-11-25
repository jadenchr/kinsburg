# Kinsburg Reels

One folder per Reel, grouped by series. Every folder has:

1. **The video:** `kinsburg-<name>.mp4` (1080×1920)
2. **The thumbnail:** `kinsburg-<name>-cover.jpg`, plus a `-grid-preview.jpg` where there is one
3. **The caption:** `kinsburg-<name>.txt`. Copy everything above the line, hashtags included. Below the line: whether it's ready, alt text, and tips.

Hashtag choices and what's working for similar accounts: [RESEARCH.md](RESEARCH.md).

**Every video loops.** Its last half-second dissolves back into its own first frame, so when Instagram replays it there's no jump (the 6 7 Reel was built as an exact loop instead). New Reels, daily episodes and the daily GitHub Reel loop automatically. To loop any other video: `node scripts/reel/loop.mjs path/to/video.mp4` (it skips videos that already loop). If you add a sound in Instagram, pick one that doesn't fade out at the end.

## Every day: tour or episode

The two daily Reels take turns, by city day (the day number on kinsburg.com):

| City day | Reel | Folder |
|---|---|---|
| Even (16, 18, 20…) | Money episode | `episodes/episode-NN/` |
| Odd (15, 17, 19…) | City tour | `tour/city-tour/` (replaced each time) |

Make either one after 12:07 UTC, when the day's build run has happened. The episode command refuses on a tour day, so you can't mix them up.

## City tour

`tour/city-tour/` is a ~40-second tour of the live city, made like the Keystone City Reel that reached 176K views. Jadie narrates every part, and the same words appear as big on-screen text:

1. The hook: "Every follower who comments MOVE IN gets a house in this city."
2. The resident counter ticking up.
3. Three streets with every resident's "#12 @handle" tag, ending on the newest street with its OPEN lots.
4. How many free villas and skyscrapers are left.
5. The resident card that's coming.
6. What comments built.
7. A thank-you over every home.
8. An end card saying "Follow + comment MOVE IN".

It's voice only, with no music. Each shot lasts about as long as Jadie's line, so the pauses stay short. The numbers, street names and builds in his lines come from the live city on every render. So does the caption, so post it as it is. (The script can also make its own music track and cut on its bars: set `MUSIC = true` in `reelTour`.)

```bash
npm run reel:launch -- --only TR --url https://kinsburg.com
```

The tour shows every resident's handle, like the episodes' comment wall. If someone asks to be left out, tell me and I'll add a skip list.

## Daily episodes

`episodes/episode-NN/` holds one "Kinsburg · Episode N" per day, made from that day's 12:00 UTC build run: residents yesterday → today, the city's money (move-ins and new followers at $1,500 each), the comment wall with real handles, what got built with its price, what's left and what's next. Jadie narrates. The caption is written from the same data, so it's always right for that day; post it as it is.

Make an episode (on an even city day, after 12:07 UTC):

```bash
npm run reel:launch -- --only E --url https://kinsburg.com
```

## Posting order

| Order | Reel | Status |
|---|---|---|
| Day 1 | [launch/launch-04-house-number-4-is-empty](launch/launch-04-house-number-4-is-empty) | **Posted.** The city went from 3 to 28 residents |
| **Now** | [tour/city-tour](tour/city-tour) | **Ready, pin it.** The Keystone-style tour, from the live city |
| **Next** | [in-this-town/in-this-town-03-the-update](in-this-town/in-this-town-03-the-update) | **Ready.** Pets, jobs, RESPOND and coins, besties, secret spots. No exact numbers, so it doesn't go stale |
| Day 2 | [in-this-town/in-this-town-01-rules-of-kinsburg](in-this-town/in-this-town-01-rules-of-kinsburg) | **Ready.** Re-rendered from the live city with @jadiedevs as resident #4 |
| Day 3 | [live/live-01-lets-build-this-city](live/live-01-lets-build-this-city) | **Ready.** Jadie's voice, hover cards for @itsjadenchristy, @metabro.pov and @jadiedevs |
| Skip | [in-this-town/in-this-town-02-six-seven](in-this-town/in-this-town-02-six-seven) | Past its moment: "6 7" only worked at exactly 67 residents |
| Later | [launch/launch-01-yours-is-still-dark](launch/launch-01-yours-is-still-dark) | Re-render from the live city (this cut shows the demo city) |
| Later | [launch/launch-02-comment-two-words](launch/launch-02-comment-two-words) | Re-render from the live city |
| Later | [launch/launch-03-the-city-picks-your-job](launch/launch-03-the-city-picks-your-job) | Re-render once there are enough residents for four jobs |

The two Ready Reels have the live numbers filmed in (28 residents, house #29). If more people move in before you post, re-render that one first.

## Re-render from the live city

```bash
npm run reel:launch -- --only T1 --url https://kinsburg.com
```

Use `--only D` for launch-04, `T1` for in-this-town-01, `T2` for in-this-town-02 (only at 67 residents), `T3` for in-this-town-03, `L1` for live-01, `A`/`B`/`C` for launch-01 to 03; leave `--only` out to re-render launch-01 to 03.

The new video, cover and grid preview go straight into the Reel's folder here, replacing the old ones. A caption you've already written is kept; the script prints the new caption so you can update its numbers.

The daily Reel isn't kept here. GitHub records and posts it every day, and you can download each one for 14 days from Actions → Daily reel.

Videos aren't saved in git (they're large); the covers and captions are.
