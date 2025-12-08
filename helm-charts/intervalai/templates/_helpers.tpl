{{/*
Chart-specific helper overrides that delegate to portfolio-common
*/}}

{{- define "intervalai.name" -}}
{{- include "portfolio-common.name" . }}
{{- end }}

{{- define "intervalai.fullname" -}}
{{- include "portfolio-common.fullname" . }}
{{- end }}

{{- define "intervalai.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "intervalai.labels" -}}
{{- include "portfolio-common.labels" . }}
{{- end }}

{{- define "intervalai.selectorLabels" -}}
{{- include "portfolio-common.selectorLabels" . }}
{{- end }}

{{- define "intervalai.serviceAccountName" -}}
{{- include "portfolio-common.serviceAccountName" . }}
{{- end }}
