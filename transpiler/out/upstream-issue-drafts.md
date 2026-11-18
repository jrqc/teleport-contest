# Upstream issue drafts (decision D6)

For the owner to post on github.com/davidbau/teleport-contest. Not posted by Claude. Checked
against the existing issues on 2026-11-18 (#5–#23): none covers these. The last one is a
comment on #23, where the maintainer asked to hear about differences caused by the new
patch 006.

Every claim below was reproduced on macOS 15.8.1 (24H32), Apple clang 17.0.0, with the
contest repo at upstream `main` (6ee30e6). Our workaround for all of them is
`tools/recorder-env/` in our fork, which re-records all 44 public sessions byte-identical.

---

## Issue 1: Recorder build installs no `sysconf`, so the game refuses to start

**Title:** `build-recorder.sh` installs no sysconf; recorder exits with "Unable to open SYSCF_FILE."

`nethack-c/build-recorder.sh` builds with the minimal hints, which compile in `SYSCF` but do
not install a `sysconf` file into the install directory. Running any session with the
resulting binary (e.g. `node scripts/verify-rerecord.mjs`) prints

```
Unable to open SYSCF_FILE.
```

and the game exits before the first screen, so every session records 0 steps.

Installing the upstream `sys/unix/sysconf` fixes it, with three edits for the recording
machine: `WIZARDS=*` (the wizard-mode sessions need it), and removing the `GDBPATH`,
`GREPPATH` and `PANICTRACE_*` lines. With those lines present, the paths they name do not
exist on macOS and the resulting error text appears on screen 0, which then no longer
matches the recordings.

A related trap when installing elsewhere: `nh_getenv()` ignores environment values longer than
`BUFSZ/2` = 128 characters (`src/options.c`), so a `NETHACKDIR` under a deep path is silently
ignored and the game falls back to the compiled-in directory.

Suggestion: install the edited sysconf in `build-recorder.sh` (or document the exact sysconf
used for the official recordings).

---

## Issue 2: Patch 001's fixed datetime depends on the recording machine's real DST state

**Title:** `NETHACK_FIXED_DATETIME` result depends on whether the recording machine is in daylight time

`time_from_yyyymmddhhmmss()` (added by patch 001, `src/calendar.c`) builds the pinned time
like this:

```c
(void) time((TIME_type) &now);
lt = localtime((LOCALTIME_type) &now);
if (lt) {
    t = *lt;                         /* copies the REAL clock's tm_isdst */
    t.tm_year = atoi(y) - 1900;
    ...
    t.tm_sec = atoi(s);
    timeresult = mktime(&t);
}
```

Every field is overwritten except `tm_isdst`, which comes from the real current time. With
`TZ=America/New_York`, `mktime()` then interprets the pinned wall-clock time as daylight or
standard time depending on **when the recording is made**. The public sessions were recorded
during US daylight time (`tm_isdst = 1`), so e.g. a pinned `...120000` on a winter date comes
out as 11:00 local. Recording the same session in November gives 12:00 instead, and the game
diverges wherever it looks at the hour: seed0009 shows "It was nighttime." in a fresh
recording but not in the official one, and seed0002, seed0012 and seed0030 diverge too.

So the public sessions can only be reproduced today by faking the real clock (we interpose
`time()` with a DYLD library that returns 2026-05-02 12:00 UTC). A JS port has to hard-code
"behave like `mktime` with `tm_isdst = 1`".

Suggestion: document this as part of the recording environment (`docs/recording-environment.md`),
since the held-out sessions presumably have the same property. Changing the patch now would
change the meaning of existing recordings.

---

## Issue 3: `record-session.mjs` drops the last step at random and leaves lock files

**Title:** `scripts/record-session.mjs`: last step dropped at random; killed segments leave lock files

Two problems, both seen while re-recording the public sessions:

1. **Last step dropped.** On `close`, the script calls `resolveDone(...)` immediately, while the
   final input marker may still be in the parser's asynchronous queue. Depending on timing the
   last step is missing (seen on seed0009, seed0030; e.g. `seg 0 steps len 73 vs 72`). Waiting for
   the marker chain before resolving fixes it.
2. **Stale locks between segments.** When a segment ends while the game waits for a key,
   `finish()` kills it with SIGTERM. The game leaves its lock and level files
   (`501wizard.0`, `alock.N`, ...) behind, and the next segment of the same session starts with
   "There is already a game in progress under your name. Destroy old game?" (seed5002,
   seed5006: `seg 1 steps len 286 vs 1`). Deleting the `*.N` lock/level files after a kill
   (keeping saves, bones and the record file) fixes it.

With both fixes, all 44 public sessions re-record byte-identical, repeatably.

---

## Comment on #23: the new patch 006 changes a public session

> I have not re-verified every effect of the 006 changes against a fresh set of recordings, so
> tell us if you see a difference.

We see one. With patch 006 from 6ee30e6, `seed0013-friday13-save-then-fullmoon-restore`
no longer re-records identically: segment 0, step 48 (the `y` confirming the save) has cursor
`[0, 0, 1]` instead of the recorded `[0, 1, 1]` (every other cell of that step matches). This
is the new `nomux_reset_raw_mode()` call in `tty_exit_nhwindows`. With patch
006 from 52960eb, all 44 public sessions re-record byte-identical (with the fixes from our
other reports).

So the public sessions were recorded with the older patch. Were the held-out sessions recorded
with the old or the new one? A port can only match one of them on the final cursor after save
or quit.
