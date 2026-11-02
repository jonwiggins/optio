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
networkPolicy.internalEgress, checked and flattened for network-policy.yaml
and NOTES.txt (docs/air-gapped.md#agent-network-policy). Every list also takes
comma-separated strings, which is how the Zarf package and a single form field
pass several values. Returns YAML: cidrs (strings), namespaces
({namespace, podLabels}) and ports (ints; empty means every port).
*/}}
{{- define "optio.internalEgress" -}}
{{- $ie := .Values.networkPolicy.internalEgress | default dict -}}
{{- $v4 := "^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])/([1-9]|[12][0-9]|3[0-2])$" -}}
{{- $v6 := "^[0-9a-fA-F:.]*:[0-9a-fA-F:.]*/([1-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$" -}}
{{- $cidrs := list -}}
{{- range ($ie.cidrs | default list) -}}
  {{- range (splitList "," (toString .)) -}}
    {{- $c := trim . -}}
    {{- if $c -}}
      {{- if not (or (regexMatch $v4 $c) (regexMatch $v6 $c)) -}}
        {{- fail (printf "networkPolicy.internalEgress.cidrs: %q isn't a CIDR (address/prefix, e.g. 10.20.0.15/32). NetworkPolicy matches addresses, not host names, and a /0 would allow every address" $c) -}}
      {{- end -}}
      {{- $cidrs = append $cidrs $c -}}
    {{- end -}}
  {{- end -}}
{{- end -}}
{{- $namespaces := list -}}
{{- range ($ie.namespaces | default list) -}}
  {{- $entries := list -}}
  {{- if kindIs "map" . -}}
    {{- range $k, $_ := . -}}
      {{- if not (has $k (list "namespace" "podLabels")) -}}
        {{- fail (printf "networkPolicy.internalEgress.namespaces: unknown key %q (use namespace and podLabels)" $k) -}}
      {{- end -}}
    {{- end -}}
    {{- if and .podLabels (not (kindIs "map" .podLabels)) -}}
      {{- fail "networkPolicy.internalEgress.namespaces: podLabels must be a map" -}}
    {{- end -}}
    {{- $entries = list (dict "namespace" (toString (.namespace | default "")) "podLabels" (.podLabels | default dict)) -}}
  {{- else -}}
    {{- range (splitList "," (toString .)) -}}
      {{- if trim . -}}{{- $entries = append $entries (dict "namespace" (trim .) "podLabels" dict) -}}{{- end -}}
    {{- end -}}
  {{- end -}}
  {{- range $entries -}}
    {{- if not (regexMatch "^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$" .namespace) -}}
      {{- fail (printf "networkPolicy.internalEgress.namespaces: %q isn't a namespace name" .namespace) -}}
    {{- end -}}
    {{- if eq .namespace $.Values.namespace -}}
      {{- fail (printf "networkPolicy.internalEgress.namespaces: %q is Optio's own namespace, where PostgreSQL and Redis run; agents reach the Optio API without it" .namespace) -}}
    {{- end -}}
    {{- $namespaces = append $namespaces . -}}
  {{- end -}}
{{- end -}}
{{- $ports := list -}}
{{- range ($ie.ports | default list) -}}
  {{- range (splitList "," (toString .)) -}}
    {{- $p := trim . -}}
    {{- if $p -}}
      {{- if or (not (regexMatch "^[0-9]+$" $p)) (lt (atoi $p) 1) (gt (atoi $p) 65535) -}}
        {{- fail (printf "networkPolicy.internalEgress.ports: %q isn't a port (1-65535)" $p) -}}
      {{- end -}}
      {{- $ports = append $ports (atoi $p) -}}
    {{- end -}}
  {{- end -}}
{{- end -}}
{{- toYaml (dict "cidrs" $cidrs "namespaces" $namespaces "ports" (uniq $ports)) -}}
{{- end }}

{{/* A label map as "k=v,k=v" (NOTES.txt). */}}
{{- define "optio.labelList" -}}
{{- $out := list -}}
{{- range $k, $v := . }}{{ $out = append $out (printf "%s=%v" $k $v) }}{{ end -}}
{{- join "," $out -}}
{{- end }}
