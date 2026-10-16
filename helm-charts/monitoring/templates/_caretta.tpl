{{/*
monitoring.carettaSide builds the nested label_replace() chain that renames one
side (client|server) of caretta_links_observed from .Values.caretta.naming.

  {{ include "monitoring.carettaSide" (dict "side" "client" "expr" "caretta_links_observed" "naming" .Values.caretta.naming) }}

Steps, innermost first:
  1. copy the raw name into <side>_addr so the original address survives
  2. address/rDNS name -> host name   (regex anchored by label_replace; dots escaped)
  3. per group: host name -> <side>_namespace, <side>_kind, and a stable
     <side>_id "<group>:<host>" so every address of a host is ONE graph node
Regex arguments use PromQL raw strings (backticks) so "\." needs no escaping.
*/}}
{{- define "monitoring.carettaSide" -}}
{{- $side := .side -}}
{{- $expr := .expr -}}
{{- $n := .naming -}}
{{- $expr = printf "label_replace(%s, \"%s_addr\", \"$1\", \"%s_name\", \"(.*)\")" $expr $side $side -}}
{{- range $addr, $host := $n.addresses -}}
{{- $expr = printf "label_replace(%s, \"%s_name\", \"%s\", \"%s_name\", `%s`)" $expr $side $host $side (replace "." "\\." $addr) -}}
{{- end -}}
{{- range $group, $g := $n.groups -}}
{{- $re := join "|" $g.hosts -}}
{{- $expr = printf "label_replace(%s, \"%s_namespace\", \"%s\", \"%s_name\", `%s`)" $expr $side $group $side $re -}}
{{- $expr = printf "label_replace(%s, \"%s_kind\", \"%s\", \"%s_name\", `%s`)" $expr $side $g.kind $side $re -}}
{{- $expr = printf "label_replace(%s, \"%s_id\", \"%s:$1\", \"%s_name\", `(%s)`)" $expr $side $group $side $re -}}
{{- end -}}
{{- $expr -}}
{{- end -}}

{{/*
monitoring.carettaPorts adds server_service from server_port: the port number
by default, a friendly name for every entry in .Values.caretta.naming.ports.
*/}}
{{- define "monitoring.carettaPorts" -}}
{{- $expr := .expr -}}
{{- $expr = printf "label_replace(%s, \"server_service\", \"$1\", \"server_port\", \"(.*)\")" $expr -}}
{{- range $port, $svc := .naming.ports -}}
{{- $expr = printf "label_replace(%s, \"server_service\", \"%s\", \"server_port\", \"%s\")" $expr $svc $port -}}
{{- end -}}
{{- $expr -}}
{{- end -}}
