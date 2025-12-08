{{/*
Common service template for portfolio applications
Usage:
  {{- include "portfolio-common.service" (dict "component" "api" "context" $) }}
  {{- include "portfolio-common.service" (dict "component" "client" "context" $) }}
*/}}
{{- define "portfolio-common.service" -}}
{{- $component := .component }}
{{- $ := .context }}
{{- $serviceConfig := index $.Values.service $component }}
apiVersion: v1
kind: Service
metadata:
  name: {{ include "portfolio-common.fullname" $ }}-{{ $component }}
  labels:
    app: {{ include "portfolio-common.name" $ }}-{{ $component }}
    component: {{ $component }}
    {{- include "portfolio-common.labels" $ | nindent 4 }}
spec:
  type: {{ $serviceConfig.type | default "ClusterIP" }}
  ports:
    - port: {{ $serviceConfig.port }}
      targetPort: http
      protocol: TCP
      name: http
      {{- if and (eq ($serviceConfig.type | default "ClusterIP") "NodePort") $serviceConfig.nodePort }}
      nodePort: {{ $serviceConfig.nodePort }}
      {{- end }}
  selector:
    app: {{ include "portfolio-common.name" $ }}-{{ $component }}
    component: {{ $component }}
    {{- include "portfolio-common.selectorLabels" $ | nindent 4 }}
{{- end }}
