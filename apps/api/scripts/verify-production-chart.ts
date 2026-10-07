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

// PUBLIC_API_URL is the browser-reachable API origin. The web gets it from
// web.publicApiUrl, or derives http://localhost:<nodePort> on a NodePort
// install; the API (config Secret) gets it only when set explicitly, so a
// NodePort install with a real publicUrl never registers localhost OAuth
// callbacks.
function containers(rendered: any[]) {
  const spec = rendered.find((d) => d.kind === "Deployment" && d.metadata.name === "optio-api").spec
    .template.spec;
  return {
    api: spec.containers.find((c: any) => c.name === "api"),
    web: spec.containers.find((c: any) => c.name === "web"),
  };
}
function configSecret(rendered: any[]): Record<string, string> {
  return rendered.find((d) => d.kind === "Secret" && d.metadata.name === "optio-config").stringData;
}
const envOf = (c: any, name: string) => c.env?.find((e: any) => e.name === name)?.value;
assert.equal(envOf(web, "PUBLIC_API_URL"), undefined);
assert.ok(!("PUBLIC_API_URL" in configSecret(docs)), "no PUBLIC_API_URL behind one ingress");
const split = render(["--set", "web.publicApiUrl=https://api.example.com"]);
assert.equal(envOf(containers(split).web, "PUBLIC_API_URL"), "https://api.example.com");
assert.equal(configSecret(split).PUBLIC_API_URL, "https://api.example.com");
assert.equal(envOf(containers(split).api, "PUBLIC_API_URL"), undefined);
const nodePort = render([
  "--set",
  "api.service.type=NodePort",
  "--set",
  "api.service.nodePort=30400",
]);
assert.equal(envOf(containers(nodePort).web, "PUBLIC_API_URL"), "http://localhost:30400");
assert.ok(!("PUBLIC_API_URL" in configSecret(nodePort)), "NodePort fallback is the web's alone");
for (const dead of ["OPTIO_AGENT_PVC_STORAGE_CLASS", "OPTIO_AGENT_PVC_SIZE"]) {
  assert.ok(!(dead in configSecret(docs)), `${dead} is read by nothing`);
}
assert.equal(envOf(api, "OPTIO_HOME_PVC_STORAGE_CLASS"), "");

console.log(
  "Production chart: Secret references, combined single replica, isolated service account, public API origin and invalid configurations verified.",
);
