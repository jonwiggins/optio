# Optional Zarf package

Build the image tags in `zarf.yaml` and `values/optio.yaml`, then create this
package with Zarf. The default package includes API, web, base agent, DinD,
PostgreSQL, Redis and utility images. The `presets` flavor adds language agent
images. The metrics-server component is optional.

See [Air-gapped installations](../../docs/air-gapped.md#zarf-package) for build,
transfer and deployment commands. `example-values.yaml` is a generic starting
point: its `chart` object is merged over `values/optio.yaml`. All variables,
defaults and sensitive fields are declared in `zarf.yaml`. Sign-in providers,
model endpoints, registry trust and ingress remain deployment choices. The
package turns the agent NetworkPolicy on; list the internal services agents
need in `AGENT_EGRESS_CIDRS` and `AGENT_EGRESS_NAMESPACES` (see
[Agent network policy](../../docs/air-gapped.md#agent-network-policy)).

Update the package metadata version and all Optio image tags together for each
new package. Preserve the encryption key and database password on upgrades;
back up the database and encryption key before deploying.
