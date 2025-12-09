{{/*
Common secret template
Usage:
  {{- include "portfolio-common.secret" . }}
*/}}
{{- define "portfolio-common.secret" -}}
{{- if and .Values.secret .Values.secret.create (not (and .Values.externalSecrets .Values.externalSecrets.enabled)) }}
apiVersion: v1
kind: Secret
metadata:
  name: {{ include "portfolio-common.fullname" . }}-secret
  labels:
    {{- include "portfolio-common.labels" . | nindent 4 }}
type: Opaque
data:
  {{- toYaml .Values.secret.data | nindent 2 }}
{{- end }}
{{- end }}
