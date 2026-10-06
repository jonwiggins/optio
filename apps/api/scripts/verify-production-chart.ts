/** Run with: pnpm --filter @optio/api exec tsx scripts/verify-production-chart.ts */
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";
const chart = fileURLToPath(new URL("../../../helm/optio", import.meta.url));
const values = `${chart}/values.production.yaml`;
function render(args: string[] = []) {
  return parseAllDocuments(
    execFileSync("helm", ["template", "optio", chart, "-f", values, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ).map((d) => d.toJSON());
}
const docs = render([
  "--set",
  "existingSecrets.OIDC_CLIENT_SECRET.name=sign-in",
  "--set",
  "existingSecrets.OIDC_CLIENT_SECRET.key=client-secret",
]);
const deployment = docs.find((d) => d.kind === "Deployment" && d.metadata.name === "optio-api");
assert.equal(deployment.spec.replicas, 1);
assert.equal(deployment.spec.strategy.type, "Recreate");
const api = deployment.spec.template.spec.containers.find((c: any) => c.name === "api");
const web = deployment.spec.template.spec.containers.find((c: any) => c.name === "web");
assert.ok(api && web, "API and web must share the deployment");
for (const key of ["DATABASE_URL", "REDIS_URL", "OPTIO_ENCRYPTION_KEY", "OIDC_CLIENT_SECRET"]) {
  assert.ok(api.env.find((e: any) => e.name === key)?.valueFrom.secretKeyRef);
  assert.ok(!web.env?.find((e: any) => e.name === key));
  for (const secret of docs.filter((d) => d.kind === "Secret"))
    assert.ok(!(key in (secret.stringData ?? {})), `${key} leaked into chart-owned secret`);
}
const agent = docs.find((d) => d.kind === "ServiceAccount" && d.metadata.name === "optio-agent");
assert.equal(agent.automountServiceAccountToken, false);
assert.ok(
  !docs
    .filter((d) => ["RoleBinding", "ClusterRoleBinding"].includes(d.kind))
    .some((d) => d.subjects?.some((s: any) => s.name === "optio-agent")),
);
for (const arg of [
  "api.replicas=2",
  "api.autoscaling.enabled=true",
  "existingSecrets.DATABASE_URL.key=",
]) {
  assert.throws(() => render(["--set", arg]));
}
console.log(
  "Production chart: Secret references, combined single replica, isolated service account and invalid configurations verified.",
);
