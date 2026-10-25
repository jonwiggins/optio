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
Whether a sign-in provider is configured by values
(else the setup wizard does it from the browser).
*/}}
{{- define "optio.hasAuthProvider" -}}
{{- or ((.Values.auth.github | default dict).clientId) ((.Values.auth.gitlab | default dict).clientId) ((.Values.auth.google | default dict).clientId) ((.Values.auth.oidc | default dict).issuerUrl) ((.Values.auth.ldap | default dict).url) -}}
{{- end }}

{{/* Feature env, emitted only for explicit restrictions. Shared by API and web. */}}
{{- define "optio.featureSettings" -}}
{{- $features := .Values.features | default dict -}}
{{- range $key, $env := dict "runtimes" "OPTIO_RUNTIMES" "gitPlatforms" "OPTIO_GIT_PLATFORMS" "triggers" "OPTIO_TRIGGERS" "ticketSources" "OPTIO_TICKET_SOURCES" "connectionProviders" "OPTIO_CONNECTION_PROVIDERS" -}}
{{- with index $features $key }}
{{ $env }}: {{ join "," . | quote }}
{{- end -}}
{{- end -}}
{{- if eq (.Values.modelAccess | default "any") "gateway" }}
OPTIO_MODEL_ACCESS: "gateway"
{{- else if ne (.Values.modelAccess | default "any") "any" -}}
{{- fail "modelAccess must be any or gateway" -}}
{{- end -}}
{{- if (.Values.agentPolicy | default dict).builtInRules }}
OPTIO_AGENT_POLICY_DEFAULTS: "true"
{{- end -}}
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

{{/*
The ConfigMap holding your CA bundle: an existing one (caBundle.configMap)
or the one rendered from caBundle.pem. Empty when neither is set.
*/}}
{{- define "optio.caBundleConfigMap" -}}
{{- if .Values.caBundle.configMap -}}
{{- .Values.caBundle.configMap -}}
{{- else if trim (.Values.caBundle.pem | default "") -}}
{{- printf "%s-ca-bundle" .Release.Name -}}
{{- end -}}
{{- end }}
