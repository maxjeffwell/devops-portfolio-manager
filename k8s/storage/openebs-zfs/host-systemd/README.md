# Host-side systemd units for openebs-zfs replication

These run on **debian-marmoset** to handle ZFS replication outside K8s.

## Deployment

```bash
# On debian-marmoset:
sudo apt install -y sanoid          # provides syncoid binary
sudo cp zfs-replicate-asustor-to-synology.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zfs-replicate-asustor-to-synology.timer
sudo systemctl list-timers zfs-replicate-asustor-to-synology.timer
```

## What runs when

| Time (local) | What | Owner |
|---|---|---|
| 03:00 | K8s `asustor-zfs-snapshot` CronJob — creates VolumeSnapshot CRs for all `asustor-zfs` PVCs | K8s (CronJob) |
| 03:15 (+/- 2 min) | `zfs-replicate-asustor-to-synology.timer` — `syncoid asustor-zfs → synology-zfs/asustor-zfs` | systemd |
| 03:30 (+/- 2 min) | `zfs-archive-to-garage.timer` — `zfs send | zstd | aws s3 cp -` to bucket `zfs-archive` | systemd |

## Two-script deployment

**Replication tier** (asustor-zfs → synology-zfs):

```bash
sudo apt install -y sanoid
sudo cp zfs-replicate-asustor-to-synology.{service,timer} /etc/systemd/system/
```

**Off-box archive tier** (asustor-zfs → Garage S3):

```bash
# Tooling
sudo apt install -y awscli zstd

# Credentials file (mode 600, root-owned)
sudo install -d -m 700 /etc/zfs-archive
sudo tee /etc/zfs-archive/credentials >/dev/null <<EOF
AWS_ACCESS_KEY_ID=<paste_GK...>
AWS_SECRET_ACCESS_KEY=<paste_secret>
EOF
sudo chmod 600 /etc/zfs-archive/credentials

# Script
sudo install -m 755 zfs-archive-to-garage.sh /usr/local/bin/

# Systemd units
sudo cp zfs-archive-to-garage.{service,timer} /etc/systemd/system/

# Activate everything
sudo systemctl daemon-reload
sudo systemctl enable --now zfs-replicate-asustor-to-synology.timer
sudo systemctl enable --now zfs-archive-to-garage.timer
sudo systemctl list-timers --all | grep zfs
```

## Why a 15-minute buffer

VolumeSnapshot CRs are created near-instantly by openebs-zfs CSI (a `zfs snapshot` is microseconds), but the K8s status path (`ReadyToUse=true`) lags by seconds-to-tens-of-seconds while the snapshotter controller reconciles. 15 minutes is overkill but cheap; ensures we never replicate before snapshots are stable.

## Inspecting

```bash
systemctl list-timers
systemctl status zfs-replicate-asustor-to-synology.timer
journalctl -u zfs-replicate-asustor-to-synology.service --since today
```

## Disabling temporarily

```bash
sudo systemctl stop zfs-replicate-asustor-to-synology.timer
sudo systemctl disable zfs-replicate-asustor-to-synology.timer
```
