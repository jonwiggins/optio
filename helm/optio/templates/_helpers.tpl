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
postgres://{{ .Values.postgresql.auth.username }}:{{ .Values.postgresql.auth.password }}@{{ .Release.Name }}-postgres:5432/{{ .Values.postgresql.auth.database }}
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
  {{- if and (not .Values.publicUrl.api) (not .Values.publicUrl.web) -}}
    {{- fail "publicUrl.api and publicUrl.web are required when auth is enabled. Set these to the externally-reachable URLs of your API and web services." -}}
  {{- else if not .Values.publicUrl.api -}}
    {{- fail "publicUrl.api is required when auth is enabled. Set to the externally-reachable URL of the API (e.g. https://optio.example.com)." -}}
  {{- else if not .Values.publicUrl.web -}}
    {{- fail "publicUrl.web is required when auth is enabled. Set to the externally-reachable URL of the web UI (e.g. https://optio.example.com)." -}}
  {{- else -}}
    {{- $hasProvider := or .Values.auth.github.clientId (or .Values.auth.google.clientId .Values.auth.gitlab.clientId) -}}
    {{- if not $hasProvider -}}
      {{- fail "At least one OAuth provider must be configured when auth is enabled. Set auth.github.clientId, auth.google.clientId, or auth.gitlab.clientId (with corresponding clientSecret)." -}}
    {{- end -}}
  {{- end -}}
{{- end -}}
{{- end }}
