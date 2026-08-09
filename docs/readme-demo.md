# README demo: one take, 25–30 seconds

A recording script for the clip that sits in [the README's **Watch it** section](../README.md).
It uses the same throwaway project as the [full manual demo](./manual-demo-messaging.md) — no
second fixture, no mocks, no helper script standing in for a worker.

One story, not a feature tour: **delegate → steer → decide → the consequence propagates.** That
arc is Docket. Everything else is detail a README should not spend a viewer's thirty seconds on.

## What the clip has to say

| beat | on screen | the claim |
|---|---|---|
| 1 | `/docket spawn --as scout …` and a row joins the dock | you start workers; they are visible and labelled by task |
| 2 | `/docket tell w2 …` → `queued` → `delivered` → `read` | you can steer one mid-flight, and Docket reports only what it observed |
| 3 | `f8` → the verdict card, diff stat, `contested w2` | you decide from evidence, not from a claim |
| 4 | `o` → both workers' hunks, attributed | two workers on one file is visible before it is a problem |
| 5 | Promote → the confirmation naming the consequence | the tool says what it is about to do |
| 6 | the dock: `base moved` on one worker, nothing on another, `2 settled · f8` | the consequence propagates by itself, and only to whom it concerns |

If a beat cannot be read in four seconds, it is not in the clip.

---

## Before you hit record

Real workers take real minutes. Everything up to the last two beats is warm-up: get the fleet
into position off camera, then record one continuous take of the part worth watching.

### Set up (once)

```bash
cd "$(git rev-parse --show-toplevel)"
bash .docket-demo/messaging/setup.sh
export PI_CODING_AGENT_DIR="$PWD/.docket-demo/messaging/pi-agent"
cd .docket-demo/messaging/orchard
```

### Warm up (off camera)

Open `pi` and start three workers **in this order**, because the take names them by label.

```text
/docket spawn --as scout summarise what src/session/store.ts does
```

```text
/docket spawn --as patcher add a per-tenant rate limit to src/api/limit.ts, right at the top of limitFor
```

```text
/docket spawn --as patcher give authenticate() in src/auth/middleware.ts a context argument, and update the top of limitFor in src/api/limit.ts to pass it
```

Then get them into position:

- **w1** (scout) — let it finish, then `f8` → `Enter` → **Dismiss**. It exists so beat 6 has
  something already folded.
- **w2** (rate limit) — **leave it running.** Beat 2 needs a worker that is genuinely mid-turn,
  because a message to a live worker is the one that visibly advances to `read`, and beat 6 needs
  a live worker whose evidence names the promoted file.
- **w3** (context argument) — let it finish and report ready. It is the card you open in beat 3
  and the change you promote in beat 5.

Beat 1 spawns **w4** on camera.

**Check your framing before recording.** The terminal wants to be wide enough that the dock keeps
its detail column — around 110 columns. Narrower and the overlap warning drops out of the row on
purpose, which is correct behaviour and a wasted frame.

---

## The take

Type at a normal speed. Do not narrate; the clip has no audio and the words on screen are the
script.

### 1 · Delegate (0:00–0:04)

```text
/docket spawn --as scout map every call site of loadSession and saveSession in src/session/store.ts
```

Hold on the dock as w4's row appears beside the others. What should be legible: every row carries
**task text**, not just `w4`.

### 2 · Steer (0:04–0:10)

```text
/docket tell w2 keep the limit in memory for now; no storage layer
```

**Hold on the chip.** This is the beat the clip exists for. It reads `tell w2 · queued`, and then,
with no further input, `delivered`, and then `read` — because the worker's runtime wrote each of
those states as it reached them.

Do not cut between the states. The whole point is that nothing was clicked.

### 3 · Decide (0:10–0:15)

```text
f8
```

Move to **w3** and press `Enter`. The verdict card opens on: the deliverable version, the diff
stat, and the line that matters here —

```text
  contested w2: limit.ts · o to see both diffs
```

### 4 · See both sides (0:15–0:19)

```text
o
```

Both workers' hunks for the contested file only, each section headed by the worker **and its
task**. Scroll one screen, no more. Press `Esc`.

### 5 · Promote, and be told what that does (0:19–0:24)

Select **Promote**. The confirmation is the frame:

```text
contested: src/api/limit.ts
  this worker · lines 3-7
  w2 · add a per-tenant rate limit · lines 3-5
promoting this leaves w2 building on the old version
```

Hold long enough for the last line to be read. Then confirm.

### 6 · The consequence propagates (0:24–0:29)

Press `Esc` back to the prompt and land the clip on the dock. You never asked for this frame; it
is what the promotion did on its own:

```text
docket · main ±1 · 2 running
● w2·patcher  add a per-tenant rate limit to sr…                     3m
    base moved · 1 file it works on landed since it started
● w4·scout    map every call site of loadSession…                   28s
    2 settled · f8
```

Three facts in the last frame, and they are what the whole clip was building to:

- **w2 was told, and nobody told it.** No message sent, no turn spent, no token spent. It derives
  `base moved` from the promotion you just made.
- **w4 says nothing.** It never touched that file, so there is no row change, no sub-line, no
  colour. The dock does not grow because something happened somewhere.
- **The two decided workers folded into one line.** w1, which you dismissed, and w3, which you
  just promoted.

Cut here.

---

## Editing

- **Cut the thinking, keep the states.** Beat 2's `queued → delivered → read` must run at real
  speed; it is a claim about honesty and speeding it up undercuts it. Everything else can lose
  its dead air.
- **No zooms, no highlights, no captions.** The surfaces are already the explanation. A README
  clip that needs annotation is showing the wrong thing.
- **Keep the theme you actually use.** The demo borrows your real theme on purpose.

`.github/media/` holds a `.gif` and an `.mp4` for each existing clip. Match that: screen-record
the terminal at ~110×32, trim the waiting, export the mp4, and derive the GIF from it — the GIF
is what the README embeds and the mp4 is what survives re-encoding.

```bash
ffmpeg -i .github/media/docket-messaging.mp4 \
  -vf "fps=12,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" \
  -loop 0 .github/media/docket-messaging.gif
```

The existing GIFs are 10–12 MB, so keep this one in that range or below; 12 fps and a 1100px
width is enough for terminal text and is most of what keeps the file small.

Then add it to the README's **Watch it** section:

```markdown
### Steer a worker, then let a promotion tell the others

![Steer a worker and propagate a promotion](.github/media/docket-messaging.gif)

Shows:

- Spawn a worker and steer a running one; the message reports `queued`, then `delivered`, then `read`.
- Decide from the verdict card, and see both workers' hunks where they contest a file.
- Promote, and watch the other worker learn its base moved without anyone telling it.
```

## Teardown

```bash
tmux kill-session -t docket-workers 2>/dev/null || true
cd "$(git rev-parse --show-toplevel)"
rm -rf .docket-demo/messaging/orchard .docket-demo/messaging/pi-agent
unset PI_CODING_AGENT_DIR
```
