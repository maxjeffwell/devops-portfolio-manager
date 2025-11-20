#!/bin/bash

# Generate common Helm templates for an application chart
# Usage: ./generate-templates.sh <chart-name> <app-display-name>

CHART_NAME=$1
APP_NAME=$2
TEMPLATE_DIR="helm-charts/${CHART_NAME}/templates"

# Create _helpers.tpl
cat > "${TEMPLATE_DIR}/_helpers.tpl" << 'HELPERS'
{{- define "APP_NAME.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "APP_NAME.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "APP_NAME.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "APP_NAME.labels" -}}
helm.sh/chart: {{ include "APP_NAME.chart" . }}
{{ include "APP_NAME.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "APP_NAME.selectorLabels" -}}
app.kubernetes.io/name: {{ include "APP_NAME.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "APP_NAME.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "APP_NAME.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}
HELPERS

# Replace APP_NAME with actual chart name
sed -i "s/APP_NAME/${CHART_NAME}/g" "${TEMPLATE_DIR}/_helpers.tpl"

echo "✓ Generated templates for ${APP_NAME}"
