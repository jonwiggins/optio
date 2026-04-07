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
*/}}
{{- define "optio.redisUrl" -}}
{{- if .Values.redis.enabled -}}
redis://{{ .Release.Name }}-redis:6379
{{- else -}}
{{- required "externalRedis.url is required when redis.enabled=false" .Values.externalRedis.url -}}
{{- end -}}
{{- end }}

{{/*
Validate required values for production deployments.
Called from secrets.yaml to fail early on misconfiguration.
*/}}
{{- define "optio.validateRequired" -}}
{{- if not .Values.auth.disabled -}}
  {{- if not .Values.publicUrl -}}
    {{- fail "publicUrl is required when auth is enabled. Set to the externally-reachable URL (e.g. https://optio.example.com)." -}}
  {{- else -}}
    {{- $hasProvider := or .Values.auth.github.clientId (or .Values.auth.google.clientId .Values.auth.gitlab.clientId) -}}
    {{- if not $hasProvider -}}
      {{- fail "At least one OAuth provider must be configured when auth is enabled. Set auth.github.clientId, auth.google.clientId, or auth.gitlab.clientId (with corresponding clientSecret)." -}}
    {{- end -}}
  {{- end -}}
{{- end -}}
{{- end }}

{{/*
Validate that encryption.key is not a known-weak placeholder value.
Called from secrets.yaml to prevent deploying with insecure defaults.
*/}}
{{- define "optio.validateEncryptionKey" -}}
{{- $lower := .Values.encryption.key | lower -}}
{{- $weak := list "change-me-in-production" "changeme" "test" "secret" "password" "default" -}}
{{- if has $lower $weak -}}
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
