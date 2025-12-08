{{/*
Common service account template
Usage:
  {{- include "portfolio-common.serviceAccount" . }}
*/}}
{{- define "portfolio-common.serviceAccount" -}}
{{- if .Values.serviceAccount.create -}}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ include "portfolio-common.serviceAccountName" . }}
  labels:
    {{- include "portfolio-common.labels" . | nindent 4 }}
  {{- with .Values.serviceAccount.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
{{- end }}
{{- end }}
