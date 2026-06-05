# Prebuilt backup image: InfluxDB v2 CLI + AWS CLI baked in.
#
# The influxdb:2.7-alpine base already ships the `influx` CLI. We add `aws-cli`
# at BUILD time so the daily CronJob never installs dependencies at runtime —
# eliminating the `apk add` hang that previously produced multi-week zombie pods
# when the Alpine CDN was unreachable.
#
# Built and pushed manually (matching docker/mongodb-backup):
#   docker build -t maxjeffwell/influxdb-backup:2.7 -t maxjeffwell/influxdb-backup:latest docker/influxdb-backup
#   docker push maxjeffwell/influxdb-backup:2.7 && docker push maxjeffwell/influxdb-backup:latest
FROM influxdb:2.7-alpine

RUN apk add --no-cache aws-cli && \
    influx version && \
    aws --version
