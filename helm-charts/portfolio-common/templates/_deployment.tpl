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
  {{- /* The HPA-managed component (autoscaling.component, default "server") must not
         carry replicas (the HPA owns it); every other component renders replicaCount.
         Before 2026-10-15 autoscaling.enabled suppressed replicas on ALL components,
         which silently left the clients at 1. */}}
  {{- $hpaComponent := $.Values.autoscaling.component | default "server" }}
  {{- if not (and $.Values.autoscaling.enabled (eq $component $hpaComponent)) }}
  replicas: {{ $.Values.replicaCount | default 2 }}
  {{- end }}
  {{- if $.Values.strategy }}
  strategy:
    {{- toYaml $.Values.strategy | nindent 4 }}
  {{- end }}
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
      {{- if $.Values.priorityClassName }}
      priorityClassName: {{ $.Values.priorityClassName }}
      {{- end }}
      {{- include "portfolio-common.podSecurityContext" $ | nindent 6 }}
      {{- if $.Values.terminationGracePeriodSeconds }}
      terminationGracePeriodSeconds: {{ $.Values.terminationGracePeriodSeconds }}
      {{- end }}
      {{- if $.Values.dnsPolicy }}
      dnsPolicy: {{ $.Values.dnsPolicy }}
      {{- end }}
      {{- if $.Values.dnsConfig }}
      dnsConfig:
        {{- toYaml $.Values.dnsConfig | nindent 8 }}
      {{- end }}
      {{- /* initContainers<Component> (e.g. initContainersBackend) overrides the shared initContainers for that component; an explicitly empty list disables them for it */ -}}
      {{- $initKey := printf "initContainers%s" (title $component) }}
      {{- $init := $.Values.initContainers }}
      {{- if hasKey $.Values $initKey }}{{ $init = index $.Values $initKey }}{{ end }}
      {{- if $init }}
      initContainers:
        {{- toYaml $init | nindent 8 }}
      {{- end }}
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
        {{- $startupProbe := index $.Values (printf "startupProbe%s" (title $component)) | default $.Values.startupProbe }}
        {{- if $startupProbe }}
        startupProbe:
          {{- toYaml $startupProbe | nindent 10 }}
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
        {{- if $.Values.volumeMounts }}
        volumeMounts:
          {{- toYaml $.Values.volumeMounts | nindent 10 }}
        {{- end }}
      {{- if $.Values.volumes }}
      volumes:
        {{- toYaml $.Values.volumes | nindent 8 }}
      {{- end }}
      {{- /* topologySpreadConstraints<Component> (e.g. topologySpreadConstraintsClient) overrides the
             chart-wide block when the key is present, same rule as nodeSelector/affinity/tolerations.
             2026-10-15: clients spread over the node label `site` (edge VPS vs home servers) with
             DoNotSchedule, while servers keep the chart-wide hostname spread. */}}
      {{- $tscKey := printf "topologySpreadConstraints%s" (title $component) }}
      {{- $tsc := ternary (index $.Values $tscKey) $.Values.topologySpreadConstraints (hasKey $.Values $tscKey) }}
      {{- if $tsc }}
      {{- if $tsc.enabled }}
      topologySpreadConstraints:
        - maxSkew: {{ $tsc.maxSkew | default 1 }}
          topologyKey: {{ $tsc.topologyKey | default "kubernetes.io/hostname" }}
          whenUnsatisfiable: {{ $tsc.whenUnsatisfiable | default "ScheduleAnyway" }}
          labelSelector:
            matchLabels:
              app: {{ include "portfolio-common.name" $ }}-{{ $component }}
      {{- end }}
      {{- end }}
      {{- /* Per-component scheduling (e.g. nodeSelectorClient) overrides the chart-wide value when the key is present, even if empty */}}
      {{- range $field := list "nodeSelector" "affinity" "tolerations" }}
      {{- $componentKey := printf "%s%s" $field (title $component) }}
      {{- $value := ternary (index $.Values $componentKey) (index $.Values $field) (hasKey $.Values $componentKey) }}
      {{- with $value }}
      {{ $field }}:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- end }}
{{- end }}
