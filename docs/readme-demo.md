# README demo: one take, ~20 seconds

A recording script for the clip in [the README's **Watch it** section](../README.md). It uses the
same throwaway project as the [full manual demo](./manual-demo-messaging.md) — no second fixture,
no mocks, no helper script standing in for a worker.

One story: **steer → decide → the consequence propagates.** Spawning is already in the older
clips, so this one opens on the part that has no equivalent elsewhere and spends every second on
it.

| beat | on screen | the claim |
|---|---|---|
| 1 | `/docket tell w2 …` → `queued` → `delivered` → `read` | you steer a worker mid-flight, and Docket reports only what it observed |
| 2 | `f8` → the verdict card, diff stat, `contested w2: limit.ts` | you decide from evidence, and a collision is visible before it is a problem |
| 3 | `o` → both workers' hunks, attributed by task | you can read both sides without leaving the decision |
| 4 | Promote → the confirmation naming the consequence → the dock | the tool says what it is about to do, then tells the worker it affects — and nobody else |

If a beat cannot be read in four seconds, it is not in the clip.

---

## Before you hit record

Real workers take real minutes. Get the fleet into position off camera, then record one
continuous take.

### Set up (once)

```bash
cd "$(git rev-parse --show-toplevel)"
bash .docket-demo/messaging/setup.sh
export PI_CODING_AGENT_DIR="$PWD/.docket-demo/messaging/pi-agent"
cd .docket-demo/messaging/orchard
```

### Warm up (off camera)

Open `pi` and start three workers **in this order** — the take names them by label.

```text
/docket spawn --as scout map every call site of loadSession and saveSession in src/session/store.ts
```

```text
/docket spawn --as patcher add a per-tenant rate limit to src/api/limit.ts, right at the top of limitFor
```

```text
/docket spawn --as patcher give authenticate() in src/auth/middleware.ts a context argument, and update the top of limitFor in src/api/limit.ts to pass it
```

Then get them into position:

- **w1** (scout) — let it finish. It exists so the last frame can show a worker that says
  *nothing*: it never touched the promoted file.
- **w2** (rate limit) — **leave it running.** Beat 1 needs a worker genuinely mid-turn, because
  that is the one whose message visibly advances to `read`, and beat 4 needs a live worker whose
  evidence names the promoted file.
- **w3** (context argument) — let it finish and report ready. It is the card you open and the
  change you promote.

**Check your framing.** Around 110 columns, so the dock keeps its detail column. Narrower and the
overlap cell drops out of the row on purpose — correct behaviour, wasted frame.

---

## The take

Type at a normal speed. No narration; the clip has no audio and the words on screen are the
script.

### 1 · Steer (0:00–0:06)

```text
/docket tell w2 keep the limit in memory for now; no storage layer
```

**Hold on the chip.** It reads `→ w2 · ✓ queued`, then — with nothing clicked — `✓✓ delivered`,
then `✓✓ read`, because the worker's runtime wrote each state as it reached it.

Do not cut between the states. The whole point is that nothing was pressed.

### 2 · Decide (0:06–0:11)

```text
f8
```

Move to **w3**, press `Enter`. The card opens on the deliverable version, the diff stat, and the
line this beat exists for —

```text
  contested w2: limit.ts · o to see both diffs
```

### 3 · See both sides (0:11–0:15)

```text
o
```

Both workers' hunks for the contested file only, each section headed by the worker **and its
task**. One screen, no scrolling past it. `Esc`.

### 4 · Promote, and watch it propagate (0:15–0:22)

Select **Promote**. The confirmation is the frame:

```text
contested: src/api/limit.ts
  this worker · lines 1-6
  w2 · add a per-tenant rate limit · lines 1-6
promoting this leaves w2 building on the old version
```

Hold long enough to read the last line, confirm, then `Esc` back to the prompt and land on the
dock:

```text
docket · main ±1 · 2 running
● w1·scout    map every call site of loadSession…                   28s
● w2·patcher  add a per-tenant rate limit to sr…                     3m
    base moved · 1 file it works on landed since it started
    1 settled · f8
```

Three facts in the last frame, and they are what the clip was building to:

- **w2 was told, and nobody told it.** No message sent, no turn spent, no token spent. It derives
  `base moved` from the promotion you just made.
- **w1 says nothing.** It never touched that file, so there is no row change, no sub-line, no
  colour. The dock does not grow because something happened somewhere.
- **w3 folded into one line** the moment its decision was recorded.

Cut here.

---

## Editing

- **Cut the thinking, keep the states.** Beat 1's `queued → delivered → read` runs at real speed;
  it is a claim about honesty and speeding it up undercuts it. Everything else can lose its dead
  air.
- **No zooms, no highlights, no captions.** The surfaces are the explanation. A README clip that
  needs annotation is showing the wrong thing.
- **Keep the theme you actually use.**

`.github/media/` holds a `.gif` and an `.mp4` per clip. Match that: screen-record at ~110×32, trim
the waiting, export the mp4, derive the GIF from it — the GIF is what the README embeds and the
mp4 is what survives re-encoding.

```bash
ffmpeg -i .github/media/docket-messaging.mp4 \
  -vf "fps=12,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" \
  -loop 0 .github/media/docket-messaging.gif
```

The existing GIFs are 10–12 MB; keep this one at or below that. 12 fps at 1100px is enough for
terminal text and is most of what keeps the file small.

Then add it to the README's **Watch it** section:

```markdown
### Steer a worker, then let a promotion tell the others

![Steer a worker and propagate a promotion](.github/media/docket-messaging.gif)

Shows:

- Steer a running worker; the message reports `queued`, then `delivered`, then `read`, on its own.
- Decide from the verdict card, and read both workers' hunks where they contest a file.
- Promote, and watch the worker it affects learn its base moved without anyone telling it.
```

## Teardown

```bash
tmux kill-session -t docket-workers 2>/dev/null || true
cd "$(git rev-parse --show-toplevel)"
rm -rf .docket-demo/messaging/orchard .docket-demo/messaging/pi-agent
unset PI_CODING_AGENT_DIR
```
