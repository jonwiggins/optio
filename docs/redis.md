# Redis: standalone and cluster mode

Optio keeps its queues (BullMQ), its pub/sub fan-out (log streams, events,
task messages), the API rate limiter and a handful of short-lived keys (OAuth
state, setup token, agent-model cache, webhook dedupe) in Redis. One module
decides how every client connects: `apps/api/src/services/redis-config.ts`.
Nothing else in the API constructs an `ioredis` client.

## Two modes

| Mode                 | `REDIS_MODE` | Use it for                                                                                                                | Clients                                                                                       |
| -------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Standalone (default) | `standalone` | local installs, the chart's built-in Redis, a provisioned ElastiCache node with cluster mode off, any single Redis server | `ioredis.Redis` per consumer, BullMQ opens its own                                            |
| Cluster              | `cluster`    | **ElastiCache Serverless** (always cluster mode), ElastiCache with cluster mode on, any Redis Cluster                     | `ioredis.Cluster` everywhere; BullMQ shares one instance and duplicates it for blocking reads |

Both modes carry the same TLS and auth settings, and both go through the
same producers, workers, pub/sub and rate limiter: only `redis-config.ts`
knows which one is in effect.

## Configuration

| Variable                           | Meaning                                                                                                                                                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REDIS_URL`                        | Standalone: one `redis://` / `rediss://` URL. Cluster: a comma-separated list of seed nodes (one entry for ElastiCache Serverless). Credentials in the first entry apply to every node.                                                       |
| `REDIS_MODE`                       | `standalone` (default) or `cluster`. A multi-node `REDIS_URL` without `REDIS_MODE=cluster` is refused at boot.                                                                                                                                |
| `REDIS_PASSWORD`, `REDIS_USERNAME` | Injected into `REDIS_URL` when it carries no credentials of its own (ACL / RBAC users need both).                                                                                                                                             |
| `REDIS_CA_CERT_PATH`               | CA bundle for `rediss://`. Not needed for ElastiCache (public CA).                                                                                                                                                                            |
| `REDIS_TLS_MIN_VERSION`            | `TLSv1.3` (default) or `TLSv1.2`.                                                                                                                                                                                                             |
| `REDIS_TLS_REJECT_UNAUTHORIZED`    | `false` skips certificate verification (dev only).                                                                                                                                                                                            |
| `REDIS_CLUSTER_NAT_MAP`            | `inner:port=outer:port,...` for a cluster behind NAT (a Docker port mapping, an SSH tunnel).                                                                                                                                                  |
| `OPTIO_QUEUE_PREFIX`               | BullMQ key prefix. Default `bull` standalone (an upgrade keeps its queued jobs), `{optio}` in cluster mode. **Must contain a `{hash-tag}` in cluster mode.** Give each Optio install sharing a Redis Cluster its own, e.g. `{optio-staging}`. |

Helm: `externalRedis.url`, `externalRedis.mode`, `externalRedis.queuePrefix`
(`helm/optio/values.yaml`). The chart refuses `mode: cluster` with the
built-in Redis and a cluster prefix without a hash tag.

At boot the API logs the mode, the nodes (never the credentials) and what
each node reports about eviction: `Redis connected` (noeviction), a
**warning** for any other policy, or an info line when the server reports
none (ElastiCache Serverless). The server keeps booting if Redis is down:
every client reconnects on its own and queues drain when it returns.

## What cluster mode changes

**Hash slots.** Redis Cluster splits the key space into 16384 slots across
nodes, and a command (or Lua script) may only touch keys of ONE slot —
otherwise `CROSSSLOT Keys in request don't hash to the same slot`. BullMQ's
scripts update several keys of a queue at once (`wait`, `active`, `meta`, the
job hash, `events`, `delayed`, ...), so every queue lives under a prefix with
a hash tag: with `{optio}` the keys are `{optio}:tasks:wait`,
`{optio}:tasks:meta`, ... and all of them hash on the text inside the braces.
`getBullMQOptions()` hands every `Queue` and `Worker` the same
`{ connection, prefix }`, and the boot-time repeat-job cleanup in `index.ts`
uses it too, so producers, workers and maintenance always address the same
keys. The default prefix puts every queue in one slot; a prefix per queue
would spread them, which Optio's queue volume does not need.

**One shared cluster client for BullMQ.** BullMQ builds standalone clients
from options but cannot build a cluster client, so `redis-config.ts` keeps
one `ioredis.Cluster` (connection name `optio-bullmq`) that every queue
reuses and every worker duplicates for its blocking `BZPOPMIN` /
`BRPOPLPUSH` connection. `maxRetriesPerRequest: null` is set on every node
option (BullMQ requires it on blocking connections).

**Ad-hoc keys stay single-key.** OAuth state, setup token, webhook dedupe,
rate-limit counters, the agent-model cache: each is read and written with
single-key commands (`GET`, `SET`, `SETEX`, `DEL key`, `INCR`, `EXPIRE`),
which need no tag. The one pattern-based operation — invalidating the
agent-model cache — goes through `redisScanKeys` (SCAN on each master; never
`KEYS`) and `redisDeleteKeys` (one `DEL` per key in cluster mode).
`ioredis.Cluster` has no `scanStream`, and a multi-key `DEL` across slots is a
CROSSSLOT error, so new code must use those helpers, not `client.keys()` /
`client.del(...many)`. Pipelines on a cluster client must also stay within
one slot.

**Pub/sub.** `PUBLISH` to a Redis Cluster is broadcast to every node, so a
subscriber on any node receives it; ioredis picks a node for `SUBSCRIBE` and
re-subscribes after a reconnect. `PUBLISH`'s reply counts only the
subscribers on the node that took the command, so across a cluster it is 0
for a delivered message more often than not: nothing in Optio reads it, and
the cluster tests and `redis:smoke` judge delivery by the message arriving.
Optio uses plain channels only;
`PSUBSCRIBE` is unavailable on ElastiCache Serverless and is not used.

**TLS and host names.** With `rediss://`, the cluster client keeps the node
names `CLUSTER SLOTS` returns instead of resolving them to IPs first
(`dnsLookup` passthrough), so the certificate's host name matches. This is
the setup ElastiCache documents for ioredis.

**Reconnects.** Every client reconnects with a capped backoff and never gives
up. The integration tier proves it: after `CLIENT KILL` of every connection
on every master, workers resume processing, producers enqueue again and
subscriptions re-arm (`redis-cluster.int.test.ts`); the pipeline e2e does the
same against the real server (`redis-cluster.e2e.test.ts`).

## ElastiCache Serverless

Serverless caches always run in cluster mode behind one endpoint, require
TLS, and support RBAC users or the default user. A working setup:

```
REDIS_MODE=cluster
REDIS_URL=rediss://<user>:<password>@<name>-<id>.serverless.<region>.cache.amazonaws.com:6379
```

(or `REDIS_USERNAME` / `REDIS_PASSWORD` with a credential-free URL, e.g. from
a Kubernetes Secret). In Helm:

```yaml
redis:
  enabled: false
externalRedis:
  mode: cluster
  queuePrefix: "{optio}"
existingSecrets:
  REDIS_URL: { name: optio-runtime, key: redis-url }
```

Everything Optio and BullMQ use is in Serverless's supported set: EVAL /
EVALSHA / SCRIPT LOAD (BullMQ's scripts), the blocking list and sorted-set
reads (`BZPOPMIN`, `BRPOPLPUSH`, `BLMOVE`), streams (`XADD`, `XTRIM`,
`XRANGE` for queue events), `SCAN`, `INFO`, `CLUSTER SLOTS` / `CLUSTER
INFO` / `CLUSTER KEYSLOT`, `PUBLISH` / `SUBSCRIBE`, and the plain key
commands. Of the commands Serverless restricts, Optio relies on none:
`KEYS`, `CONFIG`, `PSUBSCRIBE`, `CLIENT LIST` (which BullMQ's `getWorkers()`
uses; Optio does not call it), `SELECT` (cluster mode has only db 0),
`MONITOR`, `SLOWLOG`, `MEMORY`, `FUNCTION`.

### Eviction and retention

Provisioned Redis should run `maxmemory-policy noeviction` (the chart's
built-in Redis does; BullMQ and Optio warn when a server reports anything
else). Serverless exposes no `maxmemory-policy`: it is fixed at
**volatile-lru**, so when a cache reaches its maximum data storage limit it
evicts keys that have a TTL, least-recently-used first, and once nothing
evictable is left, writes fail with an out-of-memory error.

What that means for queue state:

- **Queue structures carry no TTL** — the wait / active / delayed / prioritized
  sets, the job hashes, `meta`, the schedulers. Serverless never evicts them.
  Under pressure a write fails loudly (the enqueue throws, the run is left
  for the reconciler to retry), it does not vanish.
- **Keys with a TTL** can be evicted: BullMQ job **locks** (30 s TTL, renewed
  while a job runs) and `stalled-check`, OAuth state, the setup token, rate
  limit counters, the agent-model cache. An evicted lock makes the job look
  stalled and BullMQ re-runs it (`maxStalledCount`) — at-least-once, which
  Optio's workers are built for (state transitions are compare-and-swap).
  The rest are caches and short-lived handshakes that rebuild themselves.

So queue state cannot disappear silently, but a full cache turns into
failed enqueues. Keep it from filling:

1. Set the cache's **maximum data storage** (and ECPU) limits explicitly in
   ElastiCache. Optio's working set is small (queue metadata and job
   payloads; logs live in Postgres): a few hundred MB is generous.
2. Alarm in CloudWatch on `BytesUsedForCache` approaching the limit, on
   `Evictions > 0` (a lock or token was evicted: the cache is at its limit),
   and on `ThrottledCmds` / `ElastiCacheProcessingUnits` near the ECPU cap.
3. Watch the API log for `Redis client error` and for BullMQ's
   `IMPORTANT! Eviction policy is ...` warning (provisioned nodes only).

## Testing

| Tier         | What                                                                                                                                                                                                                       | Command                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Unit         | `redis-config.test.ts`: URL / mode / prefix / TLS / NAT parsing, cluster vs standalone client construction, the cross-slot helpers                                                                                         | `pnpm --filter @optio/api test`                                                  |
| Integration  | `redis-cluster.int.test.ts` against a real three-master cluster: one slot per queue, enqueue → execute → complete, retries, delayed, schedulers, cancellation, maintenance, pub/sub, reconnects, scan / delete             | `pnpm --filter @optio/api test:integration`                                      |
| Pipeline e2e | `redis-cluster.e2e.test.ts`: the real API server in cluster mode — Job runs, reconciler retries, a schedule trigger, cancel, log streaming over pub/sub, and `CLIENT KILL` of every connection mid-run                     | `pnpm --filter @optio/api test:e2e`                                              |
| Smoke        | `scripts/redis-smoke.ts` against the Redis you are about to deploy on: topology, eviction report, a throwaway queue through every BullMQ feature Optio uses, pub/sub, scan / delete, and probes of the restricted commands | `REDIS_MODE=cluster REDIS_URL=rediss://... pnpm --filter @optio/api redis:smoke` |

`scripts/test-infra.sh start` runs the test cluster as one container
(`optio-test-redis-cluster`, three masters announcing `127.0.0.1` on ports
63791–63793) next to the standalone test Redis. A cluster has only db 0, so
cluster-mode tests isolate by key prefix (`{optio-it-<pid>-<rand>}`) rather
than by logical database and remove their keys when done. When the cluster
is unreachable (`OPTIO_TEST_NO_DOCKER` without one), those tests skip
themselves.

Before switching a deployment to Serverless, run the smoke test from a
machine inside the cache's VPC (or over an SSH tunnel with
`REDIS_CLUSTER_NAT_MAP`), then deploy and check the boot log for
`Redis connected` with `"mode":"cluster"`.

## Troubleshooting

- **`CROSSSLOT Keys in request don't hash to the same slot`** — a multi-key
  command across slots. For BullMQ: `OPTIO_QUEUE_PREFIX` lacks a hash tag
  (the API refuses to boot in that case) or a queue was created without
  `getBullMQOptions()`. For other code: use `redisScanKeys` /
  `redisDeleteKeys`, or tag related keys with the same `{...}`.
- **`ERR SELECT is not allowed in cluster mode`** — a `REDIS_URL` with a `/N`
  database path; cluster mode has only db 0.
- **`Failed to refresh slots cache` / certificate host name mismatch** — the
  seed host is unreachable from the pod (security group, VPC), or TLS was
  turned off (`redis://`) against a TLS-only endpoint. Serverless always needs
  `rediss://`.
- **`MOVED`** errors in the log — a standalone client (`REDIS_MODE` unset)
  talking to a cluster. Set `REDIS_MODE=cluster`.
- **`NOAUTH` / `WRONGPASS`** — the user needs both a name and a password on
  ElastiCache RBAC (`REDIS_USERNAME` + `REDIS_PASSWORD`, or both in the URL).
