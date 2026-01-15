{{/*
Common deployment template for portfolio applications
Usage:
  {{- include "portfolio-common.deployment" (dict "component" "api" "context" $) }}
  {{- include "portfolio-common.deployment" (dict "component" "client" "context" $) }}
*/}}
{{- define "portfolio-common.deployment" -}}
{{- $component := .component }}
{{- $ := .context }}
{{- $componentConfig := index $.Values.image $component }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "portfolio-common.fullname" $ }}-{{ $component }}
  labels:
    app: {{ include "portfolio-common.name" $ }}-{{ $component }}
    component: {{ $component }}
    {{- include "portfolio-common.labels" $ | nindent 4 }}
spec:
  replicas: {{ $.Values.replicaCount | default 2 }}
  selector:
    matchLabels:
      app: {{ include "portfolio-common.name" $ }}-{{ $component }}
      component: {{ $component }}
      {{- include "portfolio-common.selectorLabels" $ | nindent 6 }}
  template:
    metadata:
      annotations:
        {{- include "portfolio-common.annotations" $ | nindent 8 }}
      labels:
        app: {{ include "portfolio-common.name" $ }}-{{ $component }}
        component: {{ $component }}
        portfolio: "true"
        {{- include "portfolio-common.selectorLabels" $ | nindent 8 }}
    spec:
      {{- include "portfolio-common.imagePullSecrets" $ | nindent 6 }}
      serviceAccountName: {{ include "portfolio-common.serviceAccountName" $ }}
      {{- include "portfolio-common.podSecurityContext" $ | nindent 6 }}
      containers:
      - name: {{ $component }}
        {{- if index $.Values (printf "securityContext%s" (title $component)) }}
        securityContext:
          {{- toYaml (index $.Values (printf "securityContext%s" (title $component))) | nindent 10 }}
        {{- else if $.Values.securityContext }}
        securityContext:
          {{- toYaml $.Values.securityContext | nindent 10 }}
        {{- end }}
        image: "{{ $componentConfig.repository }}:{{ $componentConfig.tag | default $.Chart.AppVersion }}"
        imagePullPolicy: {{ $componentConfig.pullPolicy | default "IfNotPresent" }}
        ports:
        - name: http
          containerPort: {{ index $.Values.service $component "targetPort" }}
          protocol: TCP
        {{- $componentEnv := index $.Values.env $component }}
        {{- if $componentEnv }}
        env:
        {{- include "portfolio-common.env" $componentEnv | nindent 8 }}
        {{- end }}
        {{- $livenessProbe := index $.Values (printf "livenessProbe%s" (title $component)) | default $.Values.livenessProbe }}
        {{- if $livenessProbe }}
        livenessProbe:
          {{- toYaml $livenessProbe | nindent 10 }}
        {{- end }}
        {{- $readinessProbe := index $.Values (printf "readinessProbe%s" (title $component)) | default $.Values.readinessProbe }}
        {{- if $readinessProbe }}
        readinessProbe:
          {{- toYaml $readinessProbe | nindent 10 }}
        {{- end }}
        {{- $componentResources := index $.Values.resources $component }}
        {{- if $componentResources }}
        resources:
          {{- toYaml $componentResources | nindent 10 }}
        {{- end }}
      {{- include "portfolio-common.nodeSelector" $ | nindent 6 }}
      {{- include "portfolio-common.affinity" $ | nindent 6 }}
      {{- include "portfolio-common.tolerations" $ | nindent 6 }}
{{- end }}
