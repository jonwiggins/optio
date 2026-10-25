{{- /*
monitoring for Rancher (docs/observability.md "Monitoring"). The
API serves Prometheus metrics on metrics.port (OPTIO_METRICS_PORT) behind its
own Service; ServiceMonitor, PrometheusRule and the Grafana dashboard
ConfigMap follow it. None of it is on the ingress.
*/ -}}

{{/* The metrics Service's name: also the `job` label Prometheus gives the API's series. */}}
{{- define "optio.metrics.serviceName" -}}
{{ .Release.Name }}-api-metrics
{{- end }}

{{/* The labels the ServiceMonitor finds the metrics Service by. */}}
{{- define "optio.metrics.selectorLabels" -}}
app: optio-api
app.kubernetes.io/component: metrics
{{- end }}

{{/* The `helm test` pod that reads the endpoint: the one pod of the namespace the metrics NetworkPolicy lets in. */}}
{{- define "optio.metrics.testLabels" -}}
app.kubernetes.io/component: metrics-test
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* The `job` label of the API's series: the ServiceMonitor's (the Service's name), or metrics.prometheusRule.job. */}}
{{- define "optio.metrics.job" -}}
{{ .Values.metrics.prometheusRule.job | default (include "optio.metrics.serviceName" .) }}
{{- end }}

{{/* Fail a render that turns on what scrapes the endpoint without the endpoint. */}}
{{- define "optio.metrics.requireEndpoint" -}}
{{- if not .Values.metrics.enabled }}
{{- fail (printf "%s needs metrics.enabled=true: the API serves nothing to scrape without it" .what) }}
{{- end }}
{{- end }}
