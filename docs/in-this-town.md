# "In this town" with Jadie

A Reel series in the style of the "In this town" Roblox stories, set in Kinsburg. Jadie, the lead of jadiedevs, walks around the real city and tells you its rules in his own voice. Each video lasts about 12 seconds and ends on MOVE IN.

## The series

| Series | Rules | Status |
|---|---|---|
| **True facts** | Only things that really happen in Kinsburg | First, 3 a week |
| Facts + lore | Real rules plus one made-up joke rule | Later |
| Absurd lore | Strange made-up rules, with a real mechanic as the twist | Later |

Posted by @kinsburgtown for now. jadiedevs comes later, when you decide.

## What's in a video

- **Jadie**: redrawn in Kinsburg's flat style, with his red beanie, blue pizza sweater, dark jeans and orange sneakers. He walks the streets, waves, points, jumps and talks. The drawing code is in `src/reel-jadie.ts`.
- **His voice**: Kokoro `am_fenrir`, raised 5 semitones and played at 1.22×, as in jadiedevs' `pipeline/cast.json`.
- **The trend's look**: a big "IN THIS TOWN…" title on the first line, one word on screen at a time with key words in gold, yellow signs in the world ("RESIDENT #4 / FOREVER."), and a quick cut for each rule.
- **Real data only**: his house, his resident number, the job the city gave him, the next empty plot and the resident count all come from the live city when the video is made.

## Real people in videos: CAST ME

- Real residents appear by name only if they commented **CAST ME** on one of our posts. It works alongside MOVE IN, so "MOVE IN CAST ME" does both.
- Only the person who wrote the comment is added. Nobody can sign up somebody else.
- To take it back, people DM @kinsburgtown and you remove them. The command is in [RUNNING.md](RUNNING.md). An old CAST ME comment never adds them back; only a new one does.
- Episode 1 names nobody else; only @jadiedevs is on the list.

## Going live (in this order)

1. **Post Reel 1 first.** It says there are 3 residents, and step 3 makes it 4.
2. **Push the code** (commit and push). GitHub runs the tests, adds the CAST ME tables to the database and deploys. After that, CAST ME comments count, and the live site can draw Jadie.
3. **Move Jadie in** as a real resident. Use your admin password from `~/.kinsburg-admin-token`:

   ```bash
   curl -s -X POST https://kinsburg.com/admin/join -H "Authorization: Bearer $(cat ~/.kinsburg-admin-token)" -H "content-type: application/json" -d '{"handle":"jadiedevs"}'
   ```

   ```bash
   curl -s -X POST https://kinsburg.com/admin/cast -H "Authorization: Bearer $(cat ~/.kinsburg-admin-token)" -H "content-type: application/json" -d '{"handle":"jadiedevs"}'
   ```

4. **Render episode 1 from the live city**, so its numbers are true on the day you post:

   ```bash
   npm run reel:launch -- --only T1 --url https://kinsburg.com
   ```

   It saves `out/launch/town-facts-01.mp4`, a cover (`.jpg`) and a caption (`.txt`). The cover is designed so the profile grid's 3:4 crop keeps everything important.

If someone else moves in before Jadie, he simply becomes the next number, and his house, his number and "house #N is still empty" all update themselves when you render.
