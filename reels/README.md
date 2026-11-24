# Kinsburg Reels

One folder per Reel, grouped by series. Every folder has:

1. **The video:** `kinsburg-<name>.mp4` (1080×1920)
2. **The thumbnail:** `kinsburg-<name>-cover.jpg`, plus a `-grid-preview.jpg` where there is one
3. **The caption:** `kinsburg-<name>.txt`. Copy everything above the line, hashtags included. Below the line: whether it's ready, alt text, and tips.

Hashtag choices and what's working for similar accounts: [RESEARCH.md](RESEARCH.md).

## Daily episodes

`episodes/episode-NN/` holds one "Kinsburg · Episode N" per day, made from that day's 12:00 UTC build run: residents yesterday → today, the city's money (move-ins and new followers at $1,500 each), the comment wall with real handles, what got built with its price, what's left and what's next. Jadie narrates. The caption is written from the same data, so it's always right for that day; post it as it is.

Make today's episode (after 12:07 UTC, when the run has happened):

```bash
npm run reel:launch -- --only E --url https://kinsburg.com
```

## Posting order

| Order | Reel | Status |
|---|---|---|
| Day 1 | [launch/launch-04-house-number-4-is-empty](launch/launch-04-house-number-4-is-empty) | **Posted.** The city went from 3 to 28 residents |
| **Now** | [in-this-town/in-this-town-02-six-seven](in-this-town/in-this-town-02-six-seven) | **Ready, post first.** "6 7" only works while there are exactly 67 residents. Loops seamlessly |
| **Next** | [in-this-town/in-this-town-03-the-update](in-this-town/in-this-town-03-the-update) | **Ready.** Pets, jobs, RESPOND and coins, besties, secret spots. No exact numbers, so it doesn't go stale |
| Day 2 | [in-this-town/in-this-town-01-rules-of-kinsburg](in-this-town/in-this-town-01-rules-of-kinsburg) | **Ready.** Re-rendered from the live city with @jadiedevs as resident #4 |
| Day 3 | [live/live-01-lets-build-this-city](live/live-01-lets-build-this-city) | **Ready.** Jadie's voice, hover cards for @itsjadenchristy, @metabro.pov and @jadiedevs |
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
