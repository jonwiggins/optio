# Jenkins

Optio works with Jenkins in one direction today: **a Jenkins build starts Optio work.** A failed
build on `main` can start a Repo Task that finds the cause and opens a fix; a nightly job can wake a
persistent agent with its results; any build can start a Job or a Local automation on your machine.

## Jenkins as a trigger

`jenkins` is an event trigger like `datadog` or `alertmanager`. Jenkins doesn't sign its webhooks, so
each Jenkins trigger has **its own URL and shared secret**:

- URL: `POST {PUBLIC_URL}/api/hooks/jenkins/<trigger id>`
- Secret: minted when the trigger is created and shown once (the work's page can regenerate it).
  The delivery carries it as `X-Optio-Secret: <secret>`, `Authorization: Bearer <secret>`, or the
  password of HTTP basic auth (any user).

Keep the secret in Jenkins as a **Secret text** credential, never in a Jenkinsfile.

### Filters

| Config key | Meaning                                                                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `events`   | Which results fire it: `started`, `succeeded`, `failed`, `unstable`, `aborted`, `not_built`. Empty = any **finished** build (a start never fires a trigger that didn't ask). |
| `jobs`     | Job full names (`platform/api/main`) or short names, case-insensitive. `*` matches anything: `platform/api/*` is every branch of a multibranch job.                          |
| `branches` | Branches built (`main`, `release/*`), without `origin/` or `refs/heads/`. A build that names no branch doesn't pass a branch filter.                                         |

Job names are Jenkins' own (`JOB_NAME`): in a multibranch pipeline the branch `feature/login` is the
job `platform/api/feature%2Flogin`. Filter on `branches` when you mean a branch.

### Sending builds from Jenkins

**Notification plugin.** Add an endpoint with format **JSON**, protocol **HTTP**, event **Job
Completed** (or **All Events** to also get starts), and the trigger's URL. The plugin can't add
custom headers; put the secret in the URL as basic auth
(`https://optio:<secret>@optio.example.com/api/hooks/jenkins/<id>`) and store that URL as a
**Secret text** credential (the endpoint's URL source). Check that your plugin version sends URL
credentials as basic auth (a 401 from Optio means it doesn't) — otherwise use the pipeline step
below. The plugin may report a finished build twice (COMPLETED, then FINALIZED); Optio starts
**one** run per job, build number and result either way.

**Jenkinsfile `post` step** (no plugin needed besides Credentials Binding):

```groovy
post {
  always {
    script {
      writeFile file: '.optio-body', text: groovy.json.JsonOutput.toJson([
        job: env.JOB_NAME, number: env.BUILD_NUMBER as Integer,
        result: currentBuild.currentResult, url: env.BUILD_URL,
        branch: env.BRANCH_NAME ?: env.GIT_BRANCH, commit: env.GIT_COMMIT,
        repo: env.GIT_URL, changeId: env.CHANGE_ID,
      ])
    }
    withCredentials([string(credentialsId: 'optio-trigger-secret', variable: 'OPTIO_SECRET')]) {
      sh '''
        umask 077
        printf 'X-Optio-Secret: %s\\n' "$OPTIO_SECRET" > .optio-header
        curl -fsS -X POST -H @.optio-header -H 'Content-Type: application/json' \
          --data @.optio-body "$OPTIO_TRIGGER_URL" || true
        rm -f .optio-header .optio-body
      '''
    }
  }
}
```

`OPTIO_TRIGGER_URL` is the trigger's URL (a job or folder environment variable). If the Groovy
sandbox stops on `JsonOutput.toJson`, approve it once under Manage Jenkins → In-process Script
Approval. The header is
written to a file so the secret never appears in the process list or the build log, and `|| true`
keeps a down Optio from failing the build. To send the end of the log too, add
`log: currentBuild.rawBuild.getLog(200)` to the map (needs script approval).

Both shapes are accepted: the plugin's `{ name, url, build: { number, phase, status, full_url, scm:
{ url, branch, commit }, parameters, log } }` and the flat `{ job, number, result, url, branch,
commit, repo, changeId, log? }` above.

### Prompt params

| Param        | Value                                                             |
| ------------ | ----------------------------------------------------------------- |
| `event`      | `started` / `succeeded` / `failed` / `unstable` / …               |
| `job`        | Full job name (`platform/api/main`)                               |
| `jobName`    | Last segment (`main`)                                             |
| `number`     | Build number                                                      |
| `url`        | The build's page                                                  |
| `status`     | Jenkins' raw result (`FAILURE`)                                   |
| `branch`     | Branch built                                                      |
| `commit`     | Commit built                                                      |
| `repoUrl`    | The SCM URL                                                       |
| `changeId`   | A multibranch change request (PR / MR number), when sent          |
| `durationMs` | Build duration, when sent                                         |
| `parameters` | The build's parameters, as JSON                                   |
| `log`        | The end of the build log (≤ 8 000 chars, secrets masked), if sent |
| `payload`    | The whole delivery as JSON (≤ 20 000 chars)                       |

Example prompt for a Repo Task on `failed`:

```text
Jenkins build {{job}} #{{number}} failed on {{branch}} ({{commit}}): {{url}}.
Find the cause and open a fix.

{{log}}
```

A Local automation with no pinned directory picks the checkout of the build's `repoUrl` on that
machine.

### Config as code

```yaml
apiVersion: optio/v1
kind: Work
metadata:
  name: fix-red-main
spec:
  when:
    jenkins:
      events: [failed]
      jobs: ["platform/api/*"]
      branches: [main]
  where:
    repo: https://github.com/acme/api
    branch: main
  who:
    runtime: claude-code
  what:
    prompt: "Jenkins {{job}} #{{number}} failed on {{commit}}: {{url}}. Find the cause and open a fix."
  then: until-merged
```

The secret lives only on the trigger row: after the first apply, copy it from the work's page.
