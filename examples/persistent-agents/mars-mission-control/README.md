# Mars Mission Control — five sols on the surface

A seven-agent flight-control team handling five sols of escalating incidents on
the Martian surface. A `Clock` agent fires on a schedule trigger every N
minutes; on each tick it advances the mission and broadcasts the next sol's
scenario. The other six agents — Director, Trajectory, Comms, Life Support,
Geology, EVA — coordinate a response broadcast by broadcast.

The pattern this demo shows: **scheduled-trigger as a forcing function**.
Real-world agent communities are usually driven by external events
(monitors, schedules, webhooks) more than by a human chatting at them.

## The cast

| Slug           | Role                         | Pod lifecycle | Notes                                    |
| -------------- | ---------------------------- | ------------- | ---------------------------------------- |
| `clock`        | Mission Clock                | on-demand     | Fires on a cron; broadcasts the sol      |
| `director`     | Mission Director             | sticky        | Orchestrator, decision-maker, log-keeper |
| `trajectory`   | Trajectory & Flight Dynamics | sticky        | Orbital mechanics, route safety          |
| `comms`        | Communications               | sticky        | Earth uplink, weather, blackout windows  |
| `life-support` | Life Support & ECLSS         | sticky        | Atmosphere, water, power, food           |
| `geology`      | Geology & Surface Science    | sticky        | Site survey, samples, scientific value   |
| `eva`          | EVA Specialist               | sticky        | Suit ops, traverses, surface equipment   |

## The five sols

| Sol | Title                | What happens                                                       |
| --- | -------------------- | ------------------------------------------------------------------ |
| 1   | Touchdown            | Routine system-check shakeout; gets everyone talking               |
| 2   | Dust storm forecast  | Coordinated mitigation across EVA / Geology / Life Support / Comms |
| 3   | Water recycler fault | Three-way decision: ration / repair / return-to-orbit              |
| 4   | Surface anomaly      | Go / no-go on an extended EVA excursion                            |
| 5   | Departure            | Final prep, ascent burn lock, mission log close-out                |

The script is in [`agents/clock.json`](agents/clock.json) (in the Clock's system
prompt) — that's its "playbook," analogous to the Game Runner's playbook in
the Scion Athenaeum demo.

## Setup

```bash
# default — sols fire every 10 minutes, full demo runs ~50 min
./examples/persistent-agents/mars-mission-control/setup.sh

# faster — sols fire every 3 minutes, full demo ~15 min
SOL_INTERVAL_MINUTES=3 ./examples/persistent-agents/mars-mission-control/setup.sh

# remote / authed
OPTIO_API_URL=https://optio.acme.com OPTIO_API_TOKEN=$(cat ~/.optio-token) \
  ./examples/persistent-agents/mars-mission-control/setup.sh
```

The script:

1. Creates the seven agents (idempotent — re-runs skip existing slugs).
2. Attaches a schedule trigger to the Clock with the cron expression you've
   chosen. The trigger has `target_type='persistent_agent'` and is dispatched
   by the existing `workflow-trigger-worker`.

## Watching it run

1. Open `/agents` — see all seven, with the Director's pending message count
   ticking up as the team responds.
2. Open `/agents/director` — the Mission Log builds up in the chat panel as
   each sol's specialists report in.
3. Open `/agents/clock` — see each cron tick advance the counter, with the
   broadcast in the activity feed.
4. Open `/agents/eva` (or any specialist) — see how each role only chimes in
   when its domain is implicated.

The mission log accumulates in the Director's pod at
`/workspace/mission-log.md`. Since the Director is `sticky`, the file persists
across all five sols (and survives the sticky warm window if sols fire fast
enough).

## What to look for

- **Sol 1**: simple status reports — establishes the comms pattern.
- **Sol 2**: parallel coordination — four specialists work concurrently, the
  Director only synthesizes when reports are in.
- **Sol 3**: a real decision under uncertainty. Watch how the Director weighs
  competing inputs (Life Support says repair-feasible; Trajectory says we
  _can_ return early; Geology might have an ace). The chat in `/agents/director`
  is the most interesting view.
- **Sol 4**: cross-discipline negotiation. EVA proposes, but Comms relay
  coverage and Trajectory route safety can veto.
- **Sol 5**: orderly close. Watch the mission log get its final entry.

## Troubleshooting

- **The Clock didn't fire on time.** The trigger worker polls every 60s
  (`OPTIO_WORKFLOW_TRIGGER_INTERVAL`), so cron precision is ~1 min. If sols
  feel slow to advance, check `/agents/clock` for the most recent
  `persistent_agent:turn_started` event timestamp.
- **A specialist isn't responding.** Check the agent's `consecutive_failures`
  on `/agents` — if it's escalated to `failed`, click resume.
- **Sol 5 ran but Clock keeps waking.** Expected — the cron trigger keeps
  firing. The Clock's prompt no-ops once `counter >= 5`. To stop entirely,
  delete the trigger from `/agents/clock`'s triggers tab (UI), or via the API:
  `DELETE /api/persistent-agents/:id/triggers/:triggerId`.

## Cleanup

```bash
for slug in clock director trajectory comms life-support geology eva; do
  id=$(curl -s "$OPTIO_API_URL/api/persistent-agents" \
        | jq -r ".agents[] | select(.slug==\"$slug\") | .id")
  [ -n "$id" ] && curl -s -X DELETE "$OPTIO_API_URL/api/persistent-agents/$id"
done
```

(Triggers are cascade-deleted with the agent.)
