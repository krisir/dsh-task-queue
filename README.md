# dsh-plugin-task-queue

A DeepSeek Harness plugin that adds a **time-gated task queue**. Stack up task
cards during the day; when the window opens — say `18:00` to `07:00` — the queue
claims them one by one, hands each to a session, and lets the agent work
unattended.

The queue is a full page that sits beside the built-in **对话** and **轨迹** views,
and it is **a workspace's page**: a task created while you are in a workspace
belongs to that workspace, runs there, and is invisible from every other one.

```
   对话   轨迹   任务
   ───────────────────
   任务队列  我的项目   时段外            队列 │ 归档 ① │ 设置
   当前时段外，2 个任务在排队 · 将于 18:00 开始（3 小时后）

   新建任务
   标题  [ 清理日志                                      ]
   内容  [ 把 src 下的 console.log 都删掉…               ]
                                    Ctrl/⌘+Enter 加入队列

   #1  清理日志                                [排队中]
       把 src 下的 console.log 都删掉
       10/8 16:20                    [▶ 执行] ⬆ ⬇ ✎ ⊘ 🗑

   #2  跑测试                                    [失败]
       model exploded
       10/8 15:02 · 第 1 次 · 会话 3f9a1c2b  [▶ 执行] ↻ 🗑
```

## Install

```sh
node build.mjs      # regenerate client.js from src/
node install.mjs    # symlink into the profile + one patch row
```

`install.mjs` does exactly two reversible things: it symlinks this directory to
`<profile>/node_modules/dsh-plugin-task-queue` (what DSH's package resolution
looks for), and appends one `insert` row to `<profile>/cordis.patch.yml` between
markers it owns. It defaults to `$DSH_PROFILE` (here, `desktop`).

```sh
node install.mjs status             # what is installed where
node install.mjs uninstall          # unlink + remove the row
```

> ### What needs a restart, and what does not
>
> This profile's HMR is configured with `root: []`, so **nothing watches this
> package** by default. That leaves two caches with two different behaviours:
>
> - The **host half** (`index.js`, `host/*.js`) is a Node ES module cached by URL:
>   re-importing it returns the old code, so a host change needs a **DSH restart**.
> - The **browser bundle** (`client.js`) is re-read from disk by the client module
>   system, which tracks the artifact by its file metadata (mtime, ctime, size).
>   A rebuild is picked up without a restart — but the **browser** only fetches the
>   new bytes on the next page load, so **reload the page**.
>
> Short version: `host/` change → restart DSH. `src/` change → `node build.mjs` +
> reload the page. If a reload ever shows stale UI, restarting DSH is the
> reliable fallback.

## Use

| Where | What |
|---|---|
| The **任务** tab, beside 对话 and 轨迹 | Opens the queue for the workspace you are in |
| **队列** / **归档** / **设置** | The task list, what you filed away, and the queue settings |
| **`归档已完成 (N)`** | Files every finished task away in one click |
| **`清空归档`** | Empties the archive — arms first, then deletes |
| `#1` `#2` … | The task's place in the execution order |
| The instruction box + `加入队列` | Adds a task to the back of this workspace's queue |
| `Ctrl`/`⌘` + `Enter` | Adds without reaching for the button |
| **`▶ 执行`** on a card | Runs that task **now**, ignoring the window |
| `⬆` `⬇` | Moves a waiting task one place in the line |
| `✎` | Edits the title and the instruction in place |
| `↻` | Puts a finished, failed, or cancelled task back at the front — without running it |
| `⊘` | Cancels a waiting task without deleting it |
| `🗑` | Deletes it |

**执行** is deliberately the only labelled action on a card. Running a task by
hand is what you reach for when something is sitting there and you want it now,
and an icon in a row of five other icons is a thing you have to learn.

### Archiving

The archive is a **filing** decision, not a lifecycle one, which is why it is a
separate tab rather than another status. `归档已完成` files away every `done` task
at once; a failure or a cancellation stays in the queue list, because those are
still decisions you have to make — retry or delete — and hiding them would take
that decision away without asking. An archived task holds no place in the line and
is never claimed.

It is reversible: each archived card has **移回队列**. The one irreversible action
is `清空归档`, so it arms on the first click and deletes on the second, and says
what it is about to do in between. "One click" a few pixels from the search field
is not a good enough reason to lose the history.

Both faces put their one bulk control **above** their list — `归档已完成` over the
queue, `清空归档` over the archive. Each acts on everything below it, and a control
that moves between two faces is a control you have to re-find; below the last card
either one would be something you scroll past every task to reach, which is
backwards on a page read top-down. An empty list shows no bulk control at all:
there is nothing to act on, and the face already says it is empty.

### Why the page reads the host every five seconds

The queue runs on the Host, in another process. The page is a mirror of it, so it
re-reads the snapshot on a slow poll — that is what makes a task claimed at 18:00
appear without anyone reloading. While a task is running the snapshot keeps
changing, and the poll keeps picking those changes up; that is the page working,
not the page resetting.

Nothing you are typing is allowed to be a casualty of that read. No editable
value lives in component state: the composer's text, the settings form's
uncommitted values, and the inline task edit are all kept in the plugin's own
store, which the poll does not touch and a remount cannot discard. The settings
form is seeded from the host on the first edit and owns the form from then on, so
a poll landing mid-edit cannot pull a field back to the value the Host still has.
The inline edit is deliberately *not* re-seeded while it is open, for the same
reason — re-seeding on a changed snapshot is exactly how a half-typed edit gets
overwritten.

### The interval between tasks

`执行间隔` paces a batch: after one task finishes, the next one waits that many
minutes. `0` means "start the next one as soon as a slot is free". The wait is
measured from a per-workspace anchor written in the same commit as the finish, so
deleting a finished task cannot silently cut a pause short, and the status line
counts the wait down — a queue that has gone quiet should say why.

The interval is **per workspace**: the value lives in the workspace's own
settings, so one workspace can pace a batch out while another runs straight
through, and setting it in one page leaves every other queue alone. It is the
setting most likely to differ between two projects — one repo may be
rate-limited, another may be a scratch space you want worked through quickly —
which is why it is the one worth setting by hand per workspace.

It is a gap **between two tasks**, not a delay before the queue may act. A task
with nothing finished ahead of it in the list opens the run and starts at once,
even when the anchor is still inside the interval — which is the normal case when
one batch has just been archived and the next task arrives. Plainly: the first
task of a batch never waits.

The interval never applies to a task already running. The **执行** button ignores
it, exactly as it ignores the window.

### One task at a time

`同时执行数` is not a setting: a workspace runs **one task at a time**, always.
Tasks in a workspace share a session by default, so two at once is not
parallelism — it is the second task queueing behind the first while both count as
running, which makes the panel lie about what is happening.

### What is per workspace

**The execution interval is the per-workspace setting.** It is the one that
legitimately differs between two projects, so it is the one you set on the page
for the workspace you are looking at — one repo may be rate-limited, another may
be a scratch space you want worked through quickly.

The other settings — the hours, the zone, the approval bypass, the target mode,
the timeout, the compaction switch — are meant to be the **same everywhere**, and
they are configured once in the plugin's `config:` block rather than re-entered per
repository. A workspace the queue has never seen reads that configuration as it
stands, so a fresh workspace starts from the shared answer instead of from
defaults.

Mechanically every setting is stored under its workspace in the durable document,
and every mutating route names the *session* it came from, which the Host resolves
to a workspace. That is what keeps the interval honest: editing it in one page
cannot reach another queue. The same storage is what lets any of the shared values
differ for one workspace if you change it there — the composition config is the
source a workspace starts from, not a lock on it.

### Compacting a shared session

`任务执行前压缩会话` is for the single-session modes. A batch of tasks sharing one
conversation accumulates every earlier task's turns, tool output included, and the
context grows until the model is working against a history it mostly does not
need. With the switch on, the session is compacted **before** each task, so every
task starts from a summary.

It is deliberately `compactNow` rather than `compactIfNeeded`: the point is to
keep each task starting clean, not to wait until the context is already the
problem. It costs a model call and discards detail, so it is off by default, it
never applies to a fresh session per task (there is nothing behind it), and it is
best-effort — if no compaction service is mounted or the model call fails, the
task still runs. Losing the optimization is not a reason to lose the night's work.

### Workspaces own their queues

The page is mounted for a session, the Host resolves that session to a workspace,
and everything on screen belongs to that workspace: its tasks, its hours, its
concurrency limit. Nothing asks you which workspace you meant, because the answer
is wherever you opened it.

That is enforced on the Host, not just in the UI. Every request names the
**session** it came from — never a workspace id, which a client could get wrong —
and a task mutation whose id belongs to a different workspace answers `404`, so a
stale page can never edit another queue. A session attached to no workspace has
no queue, and the page says so rather than filing tasks somewhere invisible.

### There is no task title

A task is its instruction and nothing else. The card headings itself from the
instruction's first line — which is what a title field would have held anyway —
so nothing asks you to name what you have already written, and there is no second
field to keep in step.

### Execution windows

A workspace can have **as many windows as you like**, and the queue runs whenever
any one of them is open — an overnight block plus a lunchtime slot, say.
`18:00 → 07:00` means "from six in the evening until seven the next morning": a
start later than the end is understood as wrapping midnight, not as an empty
interval. `18:00 → 18:00` reads as all day, and **no windows at all** means
nothing is scheduled.

Times are read in an **explicit IANA zone** rather than the machine's, so a laptop
that travels does not silently move the window: the user set a wall clock on
purpose.

Outside every window the queue does nothing at all. Tasks can be created, edited,
reordered, and deleted, and none of it runs.

## How a task runs

1. **Claim.** The task is marked `running` and written to disk *before* the
   prompt is admitted, so a crash in between re-queues the task rather than
   losing it.
2. **Session.** Per the `任务执行位置` setting: a fresh session per task (the
   default), one shared runner, or one pinned session — the runner is per
   workspace, so two workspaces never share a conversation. New sessions are
   attached to the task's workspace, which is what puts them in the sidebar where
   you can read the results in the morning.
3. **Relaxed permissions.** See below.
4. **Prompt.** The task text is framed with a note that nobody is present and the
   agent should not stop to ask.
5. **Completion.** The queue watches `agent/status` for the transition
   `running → idle` and records the last assistant message as the result. A task
   that never settles is cancelled and failed after `单任务超时`.

## Skipping every authorization

This is worth being precise about, because the obvious setting does the opposite
of what it looks like. The Host has exactly two approval policies: `ask` and
`never`. **`never` does not mean "allow everything" — it means "reject everything
that needs approval"**, and it returns that verdict before any answerer runs, so
nothing can override it. A task left under `never` would fail at the exact moment
it needed to act.

So `自动跳过所有授权` is three deliberate layers, all scoped to sessions **this
plugin drives**:

| Layer | What it does |
|---|---|
| `sandbox/mode = danger-full-access` on the task's session | The filesystem and shell tools never need an escalation, so nothing asks in the first place. This is the layer that decides whether the work can happen. |
| A `tools/pre-execute` listener returning `{ kind: 'allow' }` | The real bypass: it short-circuits the tool pipeline before an `ask` can become an approval request, regardless of the session's policy. |
| An `approval/request` listener returning `'allowed-once'` | Covers a tool that asks the approval service directly instead of expressing its need as a pre-execute decision. |

Both listeners are registered **first** (`prepend: true`), ahead of the Web GUI's
own answerer, so a managed session can never end up waiting on a prompt nobody is
awake to answer. Both check the managed-session set first, so a session you are
typing into — including the one running this conversation — keeps its normal
permissions.

The switch is per workspace, so it is tracked per session: a workspace with the
switch off never has its sessions managed at all. Turning it off stops the grants
immediately; the `sandbox/mode` event already written to a task session's log is
durable, so a session that ran unattended stays unconfined. That is intentional —
it is a record of how the session actually ran — but it is the reason the switch
is worth leaving on only when you mean it.

## Configuration

The `config:` block in the inserted row is a **seed**, applied to a workspace the
first time it is seen. After that the durable document is the truth, so a
composition config cannot undo hours the user set in the page.

```yaml
- insert:
    - id: task-queue
      name: 'dsh-plugin-task-queue'
      config:
        enabled: true
        windows:
          - { start: '18:00', end: '07:00' }
          - { start: '12:00', end: '13:00' }
        timeZone: 'Asia/Shanghai'
        autoApprove: true
        targetMode: shared       # shared (recommended) | fresh
        taskTimeoutMinutes: 360  # 1..1440
        cooldownMinutes: 0       # 0..1440, wait between tasks (per workspace)
        compactBeforeTask: false # compact a shared session before each task
        file: ''                 # empty = <DSH_HOME>/task-queue/queue.json
```

An invalid value in the *page* is dropped rather than repaired against the
defaults, so one mistyped field never resets the fields around it. A window
*list* is the one place where partial application is right: an entry that cannot
be parsed is dropped and the rest are kept, because a list is a set of
independent intervals. Sending an empty list is therefore a real instruction.

## Architecture

```
index.js              re-exports name/inject/Config/apply
host/
  window.js           pure window arithmetic: isOpen, nextBoundary, zone reads
  state.js            the durable v2 document, repair, and the v1 migration
  queue.js            queue verbs, all scoped by workspace, plus archiving
  scheduler.js        the claim loop: one pass, workspace by workspace
  dispatch.js         session resolution, prompt delivery, completion tracking
  privilege.js        the three-layer unattended-execution bypass
  http.js             the control routes the page calls
  plugin.js           wiring, session→workspace resolution, lifecycle
src/                  the browser half, concatenated into client.js in order
test/                 window, store, queue, scheduler, privilege, dispatch,
                      http, wiring, client
```

### The document

```jsonc
{
  "version": 2,
  "workspaces": { "<workspaceId>": { "settings": { "windows": [ … ], … } } },
  "tasks": [
    { "id": "…", "workspaceId": "<workspaceId>", "status": "queued", "archivedAt": 0 }
  ]
}
```

Tasks carry their workspace rather than being nested under it. Nesting reads more
naturally but makes every repair path recursive; a flat list keeps normalization
in one place, and filtering by workspace is a scan of a list that never exceeds a
few hundred entries.

`lastFinishedAt` sits beside the settings rather than inside them because it is
observed state, not configuration: it is what the execution interval measures
from, and only the dispatcher writes it.

A document written before tasks carried a workspace is **migrated, not
discarded**: its hours become the seed every workspace starts from *and* are
written onto the workspace the old settings named, and its tasks are kept under
an *unassigned* bucket where they still run. The page reports them and offers to
adopt them into the workspace you are looking at — guessing which workspace they
belonged to would have been worse than saying plainly that they belong to none.

### Why the halves talk over HTTP

A third-party browser half **cannot** call its own host half through the
generated Remote protocol: the client side of that protocol has no source-mode
fallback, so it needs a build-time generated artifact this plugin does not have.
A plain route on `ctx.webServer` is the supported alternative, and every
mutating request is gated twice — loopback-only peer, and a JSON content type —
so a visited web page cannot drive the queue and a non-loopback peer cannot
reach it on the default `127.0.0.1` bind.

### Where the page is mounted

The page registers one entry in `conversation.view`, the session-scoped list the
shell renders one-at-a-time. That list already holds `chat` (order 0) and
`trajectory` (order 10); this plugin takes `task-queue` at order 20, so it sits
third and **never shadows a built-in view**. Reusing a shipped id would have put
the queue *in that cell*, replacing 对话 or 轨迹.

The entry is session-scoped, so its `inject` receives the session id — which is
what makes the id travel with every request, and what lets the Host do the
workspace resolution the page is not trusted to do itself.

### A setting that silently reverts

If you save the settings and a control springs back, the running Host did not
accept that field — most often because it is an older build that does not know the
key yet. The form now diffs the reply against what it sent and names what was
refused, instead of leaving you to guess:

> 宿主未接受：compactBeforeTask

That turned a bug report ("I click save and it does not save") into a diagnosis:
the page was correct, the Host was a build behind, and a restart fixed it.

It then immediately caught the same mistake in reverse — the Host had stopped
having a concurrency setting and this side kept sending it, so every save
complained about a field that no longer existed. Two answers came out of that:
the stale key was removed, and `test/client.test.mjs` now checks the payload
against the Host's own defaults, so the two halves cannot disagree without a test
failing. The reporting was working; what was missing was a check on the pair.

### Adopting a session, and the directory conflict

`sessionController.create({ sessionId })` reads as an idempotent "adopt this
session", and it is not one. With no workspace named, the controller derives the
working directory from its own process default — the profile directory — and then
refuses to adopt a session whose recorded directory differs:

```
session "session-…" belongs to "/Users/me/project", not "/Users/me/.dsh/profiles/desktop"
```

That is a directory conflict reported for a call that had no business creating
anything, and the message points at the wrong thing entirely. This plugin
therefore **never re-creates a session it already has an id for**: it returns the
id and lets `resolveAgent` resume it under the session's own persisted directory,
where there is nothing to conflict with. A session is created once, with the
workspace named.

The same trap is why a pinned session is checked against the task's workspace
before it is used: a session belongs to a workspace, so running this queue's
tasks in another one would break the single promise the queue makes. The refusal
names both workspaces instead of reporting a directory.

### Plugin services, and a trap worth knowing

Cordis **throws** on a property read for a service a plugin did not declare:

```
cannot get property "workspaceRegistry" without inject
```

So `try { ctx.someService } catch {}` is not a safe optional read — it looks like
a working fallback while silently disabling that path forever. This plugin
declares what it needs (`sessionController`, `webServer`, `agents`, `sessions`)
and picks up optional services (`approval`, `workspaceRegistry`) through
`ctx.inject([...], scoped => …)`, which yields the service when it mounts,
withdraws it when it unmounts, and treats absence as a normal state.

`test/wiring.test.mjs` boots a real Cordis context and mounts the plugin into it
for exactly this reason — it is the test that pins the contract.

## The browser bundle

`client.js` is generated by `build.mjs` from the numbered sources in `src/`. The
bundle format is one self-contained script registering one lazy factory:

```js
window.__ModuleLoader__.load({ id, factory(require) { … } })
```

`require()` inside that factory resolves only against the platform seed table —
never a relative path — so the sources are concatenated into a single factory
body and share one function scope. The files are numbered because `function`
declarations hoist but `const` initialisers run in filename order. `build.mjs`
also fails the build if the bundle ever requires anything but `react`, and if a
stylesheet template literal contains a stray backtick.

Only `react` is taken from the seed table. The DSH client packages are
deliberately not imported: a plain-JavaScript plugin has no type check against
them, they change without notice, and a throwing component blanks the slot it was
registered into. Styling is one owned `<style>` element, entirely in
`--dsw-alias-*` theme tokens, so the page follows light and dark mode without a
single literal colour.

The page root is a flex column that fills `conversation.view`'s box, and the
**body** is what scrolls: the shell sizes that container with `overflow: hidden`,
so a scroller anywhere else would be clipped instead of scrolling.

### Why a page, and not a floating panel

The first version of this plugin floated a draggable panel over the shell. Its
header dragged, which meant the header captured the pointer on `pointerdown` —
and pointer capture retargets the subsequent `click`, so **every button inside
that header was dead**, including the settings toggle. A control that is
clickable in the markup and inert in the browser is the worst kind of bug.

A full page has no gesture to own, so its controls simply work. A regression test
asserts the page installs no pointer-capturing gesture at all.

## Develop

```sh
node build.mjs      # regenerate client.js
node --test test/   # 182 tests, no dependencies to install
```

The suite covers the window arithmetic (the midnight wrap, the exclusive end
minute, and several windows in one workspace), the durable store's repair and
migration paths, every queue verb and its workspace scoping, the scheduler's
per-workspace time gating, the privilege bypass's scoping, the dispatch
lifecycle, the HTTP routes' security gates and cross-workspace isolation, the
real-Cordis wiring, and the browser half rendered from the real generated bundle
against a stub React — including a regression test that typing into the composer
leaves the queue on screen, and one that a composed task is posted and the form
clears.

`test/wiring.test.mjs` needs an installed DSH profile to borrow
`@deepseek-ai/cordis` from and skips cleanly when there is none.

## Limits

- **One task at a time per workspace**, by design rather than by setting.
- **Completion is inferred from agent status**, not from a stop reason. A turn
  that ends with a question still counts as done; a task that ends in failure is
  recorded with whatever `agent/error` reported.
- **The window is minute-granular.** Sub-minute precision is not meaningful for a
  "work on it overnight" window, and the scheduler re-reads the clock on every
  pass rather than trusting a long timer.
- **The queue file is not transactional with the session log.** A crash between
  the prompt admission and the status write can leave a task recorded as running
  and re-queued on restart, so a task can run twice. Task instructions should
  therefore be idempotent where practical.
- **The Host must be running.** This schedules work inside a live DSH process; it
  does not wake a sleeping machine.
- **The page needs a session open, and that session needs a workspace.** It lives
  in the conversation view list, so it is reachable whenever 对话 and 轨迹 are. A
  session attached to no workspace has no queue.
- **A task cannot be moved between workspaces.** Adopting unassigned tasks is the
  one exception, and it exists only for a queue written before this rule did.

## License

[MIT](LICENSE).
