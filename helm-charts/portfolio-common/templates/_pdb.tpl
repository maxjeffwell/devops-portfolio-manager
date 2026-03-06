{{/*
Common PodDisruptionBudget template
Usage:
  {{- include "portfolio-common.pdb" (dict "component" "server" "context" $) }}
*/}}
{{- define "portfolio-common.pdb" -}}
{{- $component := .component }}
{{- $ := .context }}
{{- if $.Values.pdb }}
{{- if $.Values.pdb.enabled }}
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ include "portfolio-common.fullname" $ }}-{{ $component }}
  labels:
    app: {{ include "portfolio-common.name" $ }}-{{ $component }}
    component: {{ $component }}
    {{- include "portfolio-common.labels" $ | nindent 4 }}
spec:
  {{- if $.Values.pdb.minAvailable }}
  minAvailable: {{ $.Values.pdb.minAvailable }}
  {{- else }}
  maxUnavailable: {{ $.Values.pdb.maxUnavailable | default 1 }}
  {{- end }}
  selector:
    matchLabels:
      app: {{ include "portfolio-common.name" $ }}-{{ $component }}
{{- end }}
{{- end }}
{{- end }}
