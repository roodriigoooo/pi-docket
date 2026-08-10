# README demo: two takes, ~20 seconds each

Recording scripts for the clips in [the README's **Watch it** section](../README.md). They use the
same throwaway project as the [full manual demo](./manual-demo-messaging.md) — no second fixture,
no mocks, no helper script standing in for a worker.

Two stories, one fixture:

- **Take A — steer → decide → the consequence propagates.** Spawning is already in the older
  clips, so this one opens on the part that has no equivalent elsewhere.
- **Take B — a collision settles without either worker redoing anything.** The reconcile lane.

If a beat cannot be read in four seconds, it is not in the clip.

### Take A

| beat | on screen | the claim |
|---|---|---|
| 1 | `/docket tell w2 …` → `queued` → `delivered` → `read` | you steer a worker mid-flight, and Docket reports only what it observed |
| 2 | `f8` → the verdict card, diff stat, `contested w2: limit.ts` | you decide from evidence, and a collision is visible before it is a problem |
| 3 | `o` → both workers' hunks, attributed by task | you can read both sides without leaving the decision |
| 4 | Promote → the confirmation naming the consequence → the dock | the tool says what it is about to do, then tells the worker it affects — and nobody else |

### Take B

| beat | on screen | the claim |
|---|---|---|
| 1 | the verdict card, `contested w2: limit.ts · o to see both diffs` | the collision is graded and openable, not a label |
| 2 | `o` → both hunks → the settle picker with `Combine with w2 · …` | the question is what the file should be, not which worker wins |
| 3 | the editor, markers reading `<<<<<<< w2 · add a per-tenant rate limit` | git does the mechanical part; you write the residue, in your own editor |
| 4 | the reconciled diff → confirm → the dock, two rows settled, no `base moved` | both workers' work landed, and neither was told to start again |

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

Then get them into position. **Take A and take B want w2 in different states**, so record A
first, restart the fixture, and record B.

For **take A**:

- **w1** (scout) — let it finish. It exists so the last frame can show a worker that says
  *nothing*: it never touched the promoted file.
- **w2** (rate limit) — **leave it running.** Beat 1 needs a worker genuinely mid-turn, because
  that is the one whose message visibly advances to `read`, and beat 4 needs a live worker whose
  evidence names the promoted file.
- **w3** (context argument) — let it finish and report ready. It is the card you open and the
  change you promote.

For **take B**, let **both** w2 and w3 finish and report ready. A reconciliation needs both sides
frozen: a worker still mid-task has no change set to merge, and Docket will correctly offer only
the older exits. w1 can be left out entirely.

**Check your framing.** Around 110 columns, so the dock keeps its detail column. Narrower and the
overlap cell drops out of the row on purpose — correct behaviour, wasted frame.

---

## Take A

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
task**. One screen, no scrolling past it. `Esc` closes the diff and the settle picker opens behind
it; `Send nothing` is already selected, so `Enter` returns you to the card without sending a byte.

### 4 · Promote, and watch it propagate (0:15–0:22)

Select **Promote**. Because w2 is still running it has frozen nothing, so there is no side to merge
with and the picker is the older two-way one:

```text
contested w2: limit.ts · how should this settle?
  See both diffs
  Promote this one only · leaves the others on the old version
  Cancel
```

The body behind it is the frame:

```text
contested: src/api/limit.ts
  this worker · lines 1-6
  w2 · add a per-tenant rate limit · lines 1-6
promoting this leaves w2 building on the old version
```

Hold long enough to read the last line, take **Promote this one only**, then `Esc` back to the
prompt and land on the dock:

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

## Take B

Restart the fixture and let **both** w2 and w3 finish. Open `f8`, move to **w3**, press `Enter`.

### 1 · The collision, graded (0:00–0:04)

The card opens on the deliverable version, the diff stat, and the warning line:

```text
  contested w2: limit.ts · o to see both diffs
```

### 2 · Both sides, then the real question (0:04–0:09)

```text
o
```

Both workers' hunks for the contested file only, attributed by task. `Esc`, and the picker behind
it is the beat:

```text
src/api/limit.ts · how should this settle?
▸ Send nothing
  Combine with w2 · add a per-tenant rate limit · 1 conflict to resolve in 1 file
  Ask w2 · add a per-tenant rate limit to yield
  Hand w2 · add a per-tenant rate limit both diffs to reconcile
```

**Hold on the second row for a full beat.** It is the whole claim in one line: Docket already
merged both change sets and is telling you exactly how much of the file is actually contested,
before you commit to anything. The safe answer is still the one under the cursor.

Take **Combine**.

### 3 · Write the residue (0:09–0:16)

The contested file opens in your editor:

```text
<<<<<<< w3 · give authenticate() an AuthContext
export function limitFor(token: string, context: AuthContext): number {
	const authenticated = authenticate(token, context);
||||||| base · what both started from
export function limitFor(token: string): number {
	const context = authenticate(token);
=======
export function limitFor(token: string): number {
	const context = authenticate(token);
	const tenantLimit = tenantLimits.get(context.tenantId) ?? DEFAULT_TENANT_LIMIT;
>>>>>>> w2 · add a per-tenant rate limit
```

No new pane, no bespoke merge UI — git's own markers, relabelled so every side names a worker
**and its task**, with the base both started from between them. Delete the markers, keep w3's
signature and w2's body, save.

Everything outside the conflict merged on its own and is not on screen. That is the point.

### 4 · Both land (0:16–0:22)

Docket shows the reconciled diff — always, because these bytes were assembled by a program — then
asks once:

```text
Promote the reconciled change set?

w3 · give authenticate() an AuthContext
w2 · add a per-tenant rate limit

git merged what it could · 1 file left contested
  src/api/limit.ts · 1 region

Both workers' changes land together, and both are told their work is already in.
```

Confirm, `Esc` to the prompt, and land on the dock:

```text
docket · main ±1
    2 settled · f8
```

Three facts in the last frame:

- **Both rows settled.** w3's deliverable was accepted and w2's was reconciled into it. Neither is
  still asking for a decision, because neither has one left.
- **Nothing says `base moved`.** A promotion that contains a worker's work does not invalidate it,
  and the journal entry credits both by name.
- **Nobody redid anything.** The alternative — promote one, tell the other to start again — is the
  thing this beat exists to be the opposite of.

Cut here.

---

## Editing

- **Cut the thinking, keep the states.** Take A's `queued → delivered → read` runs at real speed;
  it is a claim about honesty and speeding it up undercuts it. Everything else can lose its dead
  air.
- **Cut the typing in take B's editor, keep the markers.** The merge markers on screen are the
  claim; watching someone delete four lines is not. Hold the labelled markers, then jump to the
  saved file.
- **No zooms, no highlights, no captions.** The surfaces are the explanation. A README clip that
  needs annotation is showing the wrong thing.
- **Keep the theme you actually use.**

`.github/media/` holds a `.gif` and an `.mp4` per clip. Match that: screen-record at ~110×32, trim
the waiting, export the mp4, derive the GIF from it — the GIF is what the README embeds and the
mp4 is what survives re-encoding.

```bash
for clip in docket-messaging docket-reconcile; do
  ffmpeg -i ".github/media/$clip.mp4" \
    -vf "fps=12,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" \
    -loop 0 ".github/media/$clip.gif"
done
```

The existing GIFs are 10–12 MB; keep these at or below that. 12 fps at 1100px is enough for
terminal text and is most of what keeps the file small.

Then add them to the README's **Watch it** section:

```markdown
### Steer a worker, then let a promotion tell the others

![Steer a worker and propagate a promotion](.github/media/docket-messaging.gif)

Shows:

- Steer a running worker; the message reports `queued`, then `delivered`, then `read`, on its own.
- Decide from the verdict card, and read both workers' hunks where they contest a file.
- Promote, and watch the worker it affects learn its base moved without anyone telling it.

### Settle a collision without either worker redoing anything

![Reconcile two workers' changes into one promotion](.github/media/docket-reconcile.gif)

Shows:

- Two workers contest the same lines; Docket grades it and opens both sides.
- Combine merges the two change sets over the base they share and hands back only what is contested.
- Resolve it in your own editor, and both workers' work lands in one promotion.
```

## Teardown

```bash
tmux kill-session -t docket-workers 2>/dev/null || true
cd "$(git rev-parse --show-toplevel)"
rm -rf .docket-demo/messaging/orchard .docket-demo/messaging/pi-agent
unset PI_CODING_AGENT_DIR
```
