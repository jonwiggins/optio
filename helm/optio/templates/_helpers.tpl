{{/*
Common labels
*/}}
{{- define "optio.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{/*
Database URL
*/}}
{{- define "optio.databaseUrl" -}}
{{- if .Values.postgresql.enabled -}}
{{- $base := printf "postgres://%s:%s@%s-postgres:5432/%s" .Values.postgresql.auth.username .Values.postgresql.auth.password .Release.Name .Values.postgresql.auth.database -}}
{{- if .Values.postgresql.tls.enabled -}}
{{- printf "%s?sslmode=verify-full&sslrootcert=/etc/optio/pg-ca.crt" $base -}}
{{- else -}}
{{- $base -}}
{{- end -}}
{{- else -}}
{{- required "externalDatabase.url is required when postgresql.enabled=false" .Values.externalDatabase.url -}}
{{- end -}}
{{- end }}

{{/*
Redis URL
Scheme: rediss:// when TLS is enabled, redis:// otherwise.
Auth: embeds password when redis.auth.enabled (password resolved at runtime via env).
*/}}
{{- define "optio.redisUrl" -}}
{{- if .Values.redis.enabled -}}
  {{- $scheme := ternary "rediss" "redis" .Values.redis.tls.enabled -}}
  {{- $scheme -}}://{{ .Release.Name }}-redis:6379
{{- else -}}
{{- required "externalRedis.url is required when redis.enabled=false" .Values.externalRedis.url -}}
{{- end -}}
{{- end }}

{{/*
Validate required values for production deployments.
Called from secrets.yaml to fail early on misconfiguration.
*/}}
{{- define "optio.validateRequired" -}}
{{- $redisMode := .Values.externalRedis.mode | default "standalone" -}}
{{- if and (ne $redisMode "standalone") (ne $redisMode "cluster") -}}
  {{- fail (printf "externalRedis.mode must be \"standalone\" or \"cluster\" (got %q)" $redisMode) -}}
{{- end -}}
{{- if and .Values.redis.enabled (eq $redisMode "cluster") -}}
  {{- fail "externalRedis.mode=cluster needs redis.enabled=false: the chart's built-in Redis is a single server." -}}
{{- end -}}
{{- if and (eq $redisMode "cluster") .Values.externalRedis.queuePrefix (not (regexMatch "\\{[^{}]+\\}" .Values.externalRedis.queuePrefix)) -}}
  {{- fail (printf "externalRedis.queuePrefix must contain a {hash-tag} in cluster mode (got %q)" .Values.externalRedis.queuePrefix) -}}
{{- end -}}
{{- if not .Values.auth.disabled -}}
  {{- if not .Values.publicUrl -}}
    {{- fail "publicUrl is required when auth is enabled. Set to the externally-reachable URL (e.g. https://optio.example.com)." -}}
  {{- end -}}
  {{- /* No OAuth provider is required at install: with none configured, the
         setup wizard's Sign-in step (unlocked by the setup token) configures
         the first one from the browser. */ -}}
{{- end -}}
{{- end }}

{{/*
Whether any OAuth provider is configured by values (else the wizard does it).
*/}}
{{- define "optio.hasAuthProvider" -}}
{{- or .Values.auth.github.clientId (or .Values.auth.google.clientId (or .Values.auth.gitlab.clientId .Values.auth.oidc.issuerUrl)) -}}
{{- end }}

{{/*
Validate that encryption.key is not a known-weak placeholder value.
Called from secrets.yaml to prevent deploying with insecure defaults.
*/}}
{{- define "optio.validateEncryptionKey" -}}
{{- $lower := .Values.encryption.key | lower -}}
{{- $weak := list "change-me-in-production" "changeme" "test" "secret" "password" "default" -}}
{{- if and (not (hasKey (.Values.existingSecrets | default dict) "OPTIO_ENCRYPTION_KEY")) (has $lower $weak) -}}
  {{- fail (printf "encryption.key is set to a known-weak value (%q). Generate a strong key with: openssl rand -hex 32" .Values.encryption.key) -}}
{{- end -}}
{{- end }}

{{/*
Validate that ingress and gatewayAPI are not both enabled.
Called from gateway.yaml / ingress.yaml guards.
*/}}
{{- define "optio.validateNetworking" -}}
{{- if and .Values.ingress.enabled .Values.gatewayAPI.enabled -}}
  {{- fail "ingress.enabled and gatewayAPI.enabled are mutually exclusive. Disable one before enabling the other." -}}
{{- end -}}
{{- end }}


{{/* Independent deployment allowlists, shared by the API and web. */}}
{{- define "optio.featureSettings" -}}
{{- $features := .Values.features | default dict -}}
{{- range $key, $env := dict "runtimes" "OPTIO_RUNTIMES" "gitPlatforms" "OPTIO_GIT_PLATFORMS" "triggers" "OPTIO_TRIGGERS" "ticketSources" "OPTIO_TICKET_SOURCES" "connectionProviders" "OPTIO_CONNECTION_PROVIDERS" -}}
{{- with index $features $key }}
{{ $env }}: {{ join "," . | quote }}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
Validate the agent policy's chart values (docs/agent-policy.md): the agent
RuntimeClass name, and every networkPolicy.agentEgress entry. NetworkPolicy
takes addresses, namespaces and pod labels, not host names; an entry with no
destination, or a /0, would allow everything, so both are refused.
Called from secrets.yaml and network-policy.yaml.
*/}}
{{- define "optio.validateAgentPolicy" -}}
{{- $rc := .Values.agent.runtimeClassName | default "" -}}
{{- if and $rc (or (gt (len $rc) 253) (not (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$" $rc))) -}}
  {{- fail (printf "agent.runtimeClassName %q isn't a RuntimeClass name (lowercase letters, digits, \"-\" and \".\")" $rc) -}}
{{- end -}}
{{- $allow := .Values.networkPolicy.agentEgress | default list -}}
{{- if and $allow (not .Values.networkPolicy.enabled) -}}
  {{- fail "networkPolicy.agentEgress needs networkPolicy.enabled: true (the allowlist is a NetworkPolicy)" -}}
{{- end -}}
{{- $v4 := "^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])/([1-9]|[12][0-9]|3[0-2])$" -}}
{{- $v6 := "^[0-9a-fA-F:.]*:[0-9a-fA-F:.]*/([1-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$" -}}
{{- range $i, $e := $allow -}}
  {{- $at := printf "networkPolicy.agentEgress[%d]" $i -}}
  {{- if not (kindIs "map" $e) -}}{{- fail (printf "%s isn't a map" $at) -}}{{- end -}}
  {{- range $k, $_ := $e -}}
    {{- if not (has $k (list "name" "cidr" "cidrs" "except" "namespace" "podLabels" "ports")) -}}
      {{- fail (printf "%s has %q: NetworkPolicy takes addresses and pods, not host names (use cidr, cidrs, namespace, podLabels, except, ports)" $at $k) -}}
    {{- end -}}
  {{- end -}}
  {{- $cidrs := concat (ternary (list $e.cidr) list (not (empty $e.cidr))) ($e.cidrs | default list) -}}
  {{- if not (or $cidrs $e.namespace) -}}
    {{- fail (printf "%s needs cidr, cidrs or namespace: an entry with none would allow every destination" $at) -}}
  {{- end -}}
  {{- range concat $cidrs ($e.except | default list) -}}
    {{- if not (or (regexMatch $v4 (toString .)) (regexMatch $v6 (toString .))) -}}
      {{- fail (printf "%s: %q isn't a CIDR (address/prefix, e.g. 10.20.0.15/32; a /0 would allow every address)" $at (toString .)) -}}
    {{- end -}}
  {{- end -}}
  {{- if and $e.except (not $cidrs) -}}
    {{- fail (printf "%s: except needs cidr or cidrs next to it" $at) -}}
  {{- end -}}
  {{- if and $e.namespace (not (regexMatch "^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$" (toString $e.namespace))) -}}
    {{- fail (printf "%s: namespace %q isn't a namespace name" $at (toString $e.namespace)) -}}
  {{- end -}}
  {{- if and $e.podLabels (not (kindIs "map" $e.podLabels)) -}}
    {{- fail (printf "%s: podLabels must be a map" $at) -}}
  {{- end -}}
  {{- range ($e.ports | default (list 443)) -}}
    {{- if or (not (regexMatch "^[0-9]+$" (toString .))) (lt (int .) 1) (gt (int .) 65535) -}}
      {{- fail (printf "%s: port %v isn't a port (1-65535)" $at .) -}}
    {{- end -}}
  {{- end -}}
{{- end -}}
{{- end }}
