{{/*
Common HPA (Horizontal Pod Autoscaler) template
Usage:
  {{- include "portfolio-common.hpa" (dict "component" "api" "context" $) }}
*/}}
{{- define "portfolio-common.hpa" -}}
{{- $component := .component }}
{{- $ := .context }}
{{- if $.Values.autoscaling.enabled }}
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ include "portfolio-common.fullname" $ }}-{{ $component }}
  labels:
    app: {{ include "portfolio-common.name" $ }}-{{ $component }}
    component: {{ $component }}
    {{- include "portfolio-common.labels" $ | nindent 4 }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ include "portfolio-common.fullname" $ }}-{{ $component }}
  minReplicas: {{ $.Values.autoscaling.minReplicas | default 1 }}
  maxReplicas: {{ $.Values.autoscaling.maxReplicas | default 10 }}
  metrics:
    {{- if $.Values.autoscaling.targetCPUUtilizationPercentage }}
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ $.Values.autoscaling.targetCPUUtilizationPercentage }}
    {{- end }}
    {{- if $.Values.autoscaling.targetMemoryUtilizationPercentage }}
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: {{ $.Values.autoscaling.targetMemoryUtilizationPercentage }}
    {{- end }}
{{- end }}
{{- end }}
