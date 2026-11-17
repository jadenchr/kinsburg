# Kinsburg Reels

One folder per Reel, grouped by series. Every folder has:

1. **The video:** `kinsburg-<name>.mp4` (1080×1920)
2. **The thumbnail:** `kinsburg-<name>-cover.jpg`, plus a `-grid-preview.jpg` where there is one
3. **The caption:** `kinsburg-<name>.txt`. Copy everything above the line, hashtags included. Below the line: whether it's ready, alt text, and tips.

Hashtag choices and what's working for similar accounts: [RESEARCH.md](RESEARCH.md).

## Posting order

| Order | Reel | Status |
|---|---|---|
| Day 1 | [launch/launch-04-house-number-4-is-empty](launch/launch-04-house-number-4-is-empty) | **Ready.** Post while kinsburg.com still has 3 residents |
| Day 2 | [in-this-town/in-this-town-01-rules-of-kinsburg](in-this-town/in-this-town-01-rules-of-kinsburg) | Add @jadiedevs to the city, then re-render |
| Later | [launch/launch-01-yours-is-still-dark](launch/launch-01-yours-is-still-dark) | Re-render from the live city (this cut shows the demo city) |
| Later | [launch/launch-02-comment-two-words](launch/launch-02-comment-two-words) | Re-render from the live city |
| Later | [launch/launch-03-the-city-picks-your-job](launch/launch-03-the-city-picks-your-job) | Re-render once there are enough residents for four jobs |

Re-render from the live city with:

```bash
npm run reel:launch -- --url https://kinsburg.com
```

The new videos land in `out/launch/`. Copy them over the old ones in these folders.

The daily Reel isn't kept here. GitHub records and posts it every day, and you can download each one for 14 days from Actions → Daily reel.

Videos aren't saved in git (they're large); the covers and captions are.
