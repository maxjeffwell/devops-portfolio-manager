# Headscale Cold Standby on m920s — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A second native headscale on m920s, kept in sync with dm every minute and inert until one command promotes it; a second command hands control back.

**Architecture:** Shell scripts + systemd units deployed by hand to four hosts (dm, m920s, the two routers, the VPS), all driven from m920s over single-purpose, command-restricted SSH keys. State moves one way (dm → m920s staging dir) via SQLite's online backup. Promote/demote flip four pointers in order: BE88U hosts entry, AX86U unbound record, VPS bootstrap DNAT, k8s `headscale/headscale` Endpoints. Health is a textfile-collector metric feeding two PrometheusRule alerts.

**Tech Stack:** bash, systemd (service + timer), sqlite3, OpenSSH forced commands (`command=`), dropbear on Asuswrt-Merlin, unbound-control, iptables, kubectl (root k3s kubeconfig on m920s), PrometheusRule CRD (kube-prometheus), headscale 0.29.3 .deb.

**Spec:** `docs/superpowers/specs/2026-10-23-headscale-cold-standby-m920s-design.md`

## Global Constraints

- headscale on m920s is **0.29.3** (`headscale_0.29.3_linux_amd64.deb`), identical to dm; never a different version.
- All standby traffic is LAN (`192.168.50.0/24`) or wg0 (`10.0.0.0/24`). Nothing may depend on the tailnet (`100.64.0.0/10`) or on k3s being up, except the final Endpoints patch which talks to the local API server on m920s.
- The k8s `headscale/headscale` Service stays selectorless; only its Endpoints change, and they hold exactly one IP at a time.
- Every SSH key created is ed25519, lives under `/root/.ssh/headscale-standby-<target>`, and is authorized remotely with `command="<wrapper>",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty`.
- Addresses (verbatim from the spec): dm LAN `192.168.50.152`, dm wg0 `10.0.0.9`; m920s LAN `192.168.50.155`, m920s wg0 `10.0.0.12`; BE88U `192.168.50.1` (ssh port 2222, user `maxjeffwell`, `nvram get productid` = `RT-BE88U`); AX86U Pro `192.168.50.103` (ssh port 2222, user `maxjeffwell`, productid `RT-AX86U_PRO`); VPS vmi3610371 wg0 `10.0.0.1` (user `maxjeffwell`, passwordless sudo); bootstrap IP `198.51.100.53`; headscale ports 8081 (http), 8443 (nginx tls on wg0), 9099 (metrics), 50443 (grpc).
- Scripts under `/usr/local/sbin/`, shared constants under `/usr/local/lib/headscale-standby/common.sh`, units under `/etc/systemd/system/`.
- No commit carries `Co-Authored-By` or any AI attribution. Commits go straight to `main`.
- m920s must never hold a `/etc/hosts` pin for `headscale.el-jefe.me` and never gets a `headscale-bootstrap-dnat` unit.
- blocky on the ASUSTOR (`192.168.50.142`) is not touched.

## Review Focus

1. **dm's SQLite WAL mid-write during export** → the exported file must pass `PRAGMA integrity_check` every time; the online backup API guarantees this, a plain `cp` would not. Pinned in Task 3's integrity step.
2. **Promote run with dm up and no `--force`** → must exit 2 with `refused: dm headscale answers`, and change nothing. Pinned in Task 6.
3. **Promote partially failed (e.g. AX86U unreachable at step 7)** → earlier steps must be reported as done and the script must be re-runnable to finish; each step is idempotent (checks target before writing). Pinned in Task 6's idempotency step.
4. **Demote with dm's headscale still running** → exit 2, no DB copy. Pinned in Task 7.
5. **Sync timer still enabled after promote** → would overwrite staging while m920s is the writer; harmless to the live DB but misleading. Promote disables the timer; `headscale-standby-sync.sh` refuses to run when the local headscale is active. Pinned in Task 3.

---

## File structure

```
scripts/headscale-standby/
  README.md                          # which file goes to which host, install order
  common.sh                          # constants + helpers, installed on m920s only
  dm/headscale-standby-export.sh     # forced command on dm: export | config
  dm/sudoers-headscale-standby       # NOPASSWD for the two commands the wrapper runs
  m920s/headscale-standby-sync.sh    # pull snapshot into staging, write metrics
  m920s/headscale-standby-sync.service
  m920s/headscale-standby-sync.timer
  m920s/headscale-promote.sh
  m920s/headscale-demote.sh
  m920s/headscale-standby-status.sh  # read-only: who is live, pointer states, sync age
  m920s/nginx-headscale-bootstrap.conf
  m920s/config.yaml.sed              # dm config -> m920s config rewrite rules
  routers/headscale-dns-target.sh    # same file on BE88U and AX86U; detects which router it is on
  vps/headscale-bootstrap-target     # forced command on the VPS: status | dm | m920s
  vps/headscale-bootstrap-dnat.service
  vps/headscale-bootstrap.default    # /etc/default/headscale-bootstrap: TARGET_IP=
k8s/headscale/prometheusrule.yaml    # 2 alerts (ArgoCD app "headscale" syncs this dir)
docs/runbooks/headscale-cold-standby.md
```

Deployment is by hand (`scp` + the commands in each task); the README records the mapping so a rebuild follows it.

---

### Task 1: dm export wrapper and restricted key

**Files:**
- Create: `scripts/headscale-standby/dm/headscale-standby-export.sh`
- Create: `scripts/headscale-standby/dm/sudoers-headscale-standby`
- Create: `scripts/headscale-standby/README.md`

**Interfaces:**
- Produces: forced command on dm for user `maxjeffwell`, key `/root/.ssh/headscale-standby-dm` on m920s. `ssh -i <key> maxjeffwell@192.168.50.152 export` writes a tar stream to stdout containing `db.sqlite` (a fresh `.backup` snapshot) and `noise_private.key`. `... config` prints `/etc/headscale/config.yaml`. Anything else exits 64 with `headscale-standby-export: refused: <cmd>` on stderr.

- [ ] **Step 1: Generate the key on m920s and record the failing state**

Run on m920s (as root):
```bash
install -d -m 700 /root/.ssh
ssh-keygen -t ed25519 -N '' -C headscale-standby-dm -f /root/.ssh/headscale-standby-dm
ssh -i /root/.ssh/headscale-standby-dm -o BatchMode=yes -o StrictHostKeyChecking=accept-new maxjeffwell@192.168.50.152 export | tar t
```
Expected: `Permission denied (publickey)`.

- [ ] **Step 2: Write `dm/headscale-standby-export.sh`**

`#!/bin/bash`, `set -euo pipefail`. Dispatch on `${SSH_ORIGINAL_COMMAND:-}`:
- `export`: `sudo -n sqlite3 /var/lib/headscale/db.sqlite ".backup /var/lib/headscale/standby-export.sqlite"`, then `sudo -n tar -C /var/lib/headscale -c --transform='s/^standby-export.sqlite$/db.sqlite/' standby-export.sqlite noise_private.key` to stdout.
- `config`: `sudo -n cat /etc/headscale/config.yaml`.
- anything else: `echo "headscale-standby-export: refused: ${SSH_ORIGINAL_COMMAND:-<none>}" >&2; exit 64`.

- [ ] **Step 3: Write `dm/sudoers-headscale-standby`**

Exactly two lines, for user `maxjeffwell`, `NOPASSWD`, commands `/usr/bin/sqlite3 /var/lib/headscale/db.sqlite .backup /var/lib/headscale/standby-export.sqlite`, `/usr/bin/tar -C /var/lib/headscale -c --transform=s/^standby-export.sqlite$/db.sqlite/ standby-export.sqlite noise_private.key`, and `/usr/bin/cat /etc/headscale/config.yaml`. (dm's `maxjeffwell` already has passwordless sudo; the file still documents intent and survives a tightening.)

- [ ] **Step 4: Install on dm**

```bash
scp scripts/headscale-standby/dm/headscale-standby-export.sh scripts/headscale-standby/dm/sudoers-headscale-standby debian-marmoset:/tmp/
ssh debian-marmoset 'sudo install -m 755 /tmp/headscale-standby-export.sh /usr/local/sbin/ && sudo install -m 440 /tmp/sudoers-headscale-standby /etc/sudoers.d/headscale-standby && sudo visudo -cf /etc/sudoers.d/headscale-standby'
```
Expected: `/etc/sudoers.d/headscale-standby: parsed OK`. Append to `~maxjeffwell/.ssh/authorized_keys` on dm:
`command="/usr/local/sbin/headscale-standby-export.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 <pubkey> headscale-standby-dm`

- [ ] **Step 5: Verify export, config, and refusal**

Run on m920s:
```bash
K=/root/.ssh/headscale-standby-dm; H=maxjeffwell@192.168.50.152
ssh -i $K $H export | tar t
ssh -i $K $H config | grep -c '^server_url: https://headscale.el-jefe.me'
ssh -i $K $H 'id'; echo "exit=$?"
```
Expected: `db.sqlite` and `noise_private.key`; `1`; `headscale-standby-export: refused: id` and `exit=64`.

- [ ] **Step 6: Write `README.md`** listing each file → host → path → mode, and the install order (Task 1 → 2 → 3 → 4 → 5 → 8). Commit.

```bash
git add scripts/headscale-standby/README.md scripts/headscale-standby/dm/
git commit -m "headscale-standby: dm export wrapper and sudoers"
```

---

### Task 2: m920s inert standby install

**Files:**
- Create: `scripts/headscale-standby/common.sh`
- Create: `scripts/headscale-standby/m920s/nginx-headscale-bootstrap.conf`
- Create: `scripts/headscale-standby/m920s/config.yaml.sed`

**Interfaces:**
- Consumes: Task 1's `config` command.
- Produces on m920s: headscale 0.29.3 installed, `headscale.service` disabled+stopped; nginx installed, site `headscale-bootstrap` enabled in config but `nginx.service` disabled+stopped; `/etc/headscale/config.yaml` with m920s addresses; `/etc/headscale/tls/tls.{crt,key}` kept current by `sync-headscale-cert.timer`; `/var/lib/headscale/` (0700 headscale:headscale) and `/var/lib/headscale/standby/` (0700 root). `common.sh` exports: `DM_LAN DM_WG M920S_LAN M920S_WG BE88U AX86U_HOST AX86U_PORT VPS_WG KEY_DM KEY_BE88U KEY_AX86U KEY_VPS STAGING=/var/lib/headscale/standby METRICS=/var/lib/node_exporter/textfile_collector/headscale_standby.prom` and functions `dm_live` (curl `http://10.0.0.9:8081/health` **or** `https://192.168.50.152/health` with `--max-time 3`, exit 0 if either is 200), `local_live` (same on `127.0.0.1:8081`), `log <msg>` (stdout + `logger -t headscale-standby`).

- [ ] **Step 1: Record the failing state**

Run on m920s: `headscale version; systemctl is-enabled nginx; ls /etc/headscale`
Expected: `command not found`, `Failed to get unit file state`, `No such file`.

- [ ] **Step 2: Install headscale 0.29.3 and nginx, both disabled**

```bash
curl -fsSLo /tmp/headscale.deb https://github.com/juanfont/headscale/releases/download/v0.29.3/headscale_0.29.3_linux_amd64.deb
sudo apt-get install -y /tmp/headscale.deb nginx
sudo systemctl disable --now headscale nginx
sudo apt-mark hold headscale
```
Verify: `headscale version` prints `v0.29.3`; `systemctl is-enabled headscale nginx` prints `disabled` twice; `ss -ltn | grep -cE ':(80|443|8081|8443) '` prints `0`.

- [ ] **Step 3: Write `m920s/config.yaml.sed`** with exactly: `s/^metrics_listen_addr: 10\.0\.0\.9:9099$/metrics_listen_addr: 10.0.0.12:9099/`. Generate the config on m920s:

```bash
ssh -i /root/.ssh/headscale-standby-dm maxjeffwell@192.168.50.152 config | sed -f config.yaml.sed > /etc/headscale/config.yaml
diff <(ssh -i /root/.ssh/headscale-standby-dm maxjeffwell@192.168.50.152 config) /etc/headscale/config.yaml
```
Expected diff: exactly the one `metrics_listen_addr` line. Then `headscale configtest` → exit 0.

- [ ] **Step 4: Write `m920s/nginx-headscale-bootstrap.conf`**: dm's `/etc/nginx/sites-available/headscale-bootstrap` with `192.168.50.152` → `192.168.50.155` and `10.0.0.9` → `10.0.0.12`, nothing else changed (fetch dm's file with `ssh debian-marmoset sudo cat ...`, apply the two `sed` substitutions, commit the result). Install to `/etc/nginx/sites-available/headscale-bootstrap`, symlink into `sites-enabled`, remove `sites-enabled/default`. Verify `nginx -t` → `syntax is ok` (the cert must exist first; do Step 5 before this verify if needed).

- [ ] **Step 5: Cert sync on m920s**

Copy dm's `/usr/local/sbin/sync-headscale-cert.sh` and the `sync-headscale-cert.{service,timer}` units verbatim, except `KUBECONFIG=/etc/rancher/k3s/k3s.yaml`. `install -d -m 700 /etc/headscale/tls`. `systemctl enable --now sync-headscale-cert.timer; systemctl start sync-headscale-cert.service`. Verify: `openssl x509 -in /etc/headscale/tls/tls.crt -noout -subject` prints `CN = headscale.el-jefe.me`, and `diff` against dm's `tls.crt` is empty.

- [ ] **Step 6: State dirs and `common.sh`**

`install -d -m 700 -o headscale -g headscale /var/lib/headscale; install -d -m 700 /var/lib/headscale/standby; install -d -m 755 /usr/local/lib/headscale-standby`. Write `common.sh` per Interfaces and install it. Verify: `bash -n common.sh`; `source /usr/local/lib/headscale-standby/common.sh && dm_live; echo $?` → `0`; `local_live; echo $?` → `1`.

- [ ] **Step 7: Commit**

```bash
git add scripts/headscale-standby/common.sh scripts/headscale-standby/m920s/nginx-headscale-bootstrap.conf scripts/headscale-standby/m920s/config.yaml.sed
git commit -m "headscale-standby: m920s inert install (config, nginx site, common.sh)"
```

---

### Task 3: minute sync into staging with metrics

**Files:**
- Create: `scripts/headscale-standby/m920s/headscale-standby-sync.sh`
- Create: `scripts/headscale-standby/m920s/headscale-standby-sync.service`
- Create: `scripts/headscale-standby/m920s/headscale-standby-sync.timer`

**Interfaces:**
- Consumes: Task 1 `export`/`config`; Task 2 `common.sh`.
- Produces: `$STAGING/db.sqlite`, `$STAGING/noise_private.key`, `$STAGING/dm-config.yaml`, `$STAGING/.last-sync` (epoch seconds). `$METRICS` containing `headscale_standby_last_sync_timestamp_seconds <epoch>`, `headscale_standby_sync_ok 0|1`, `headscale_standby_health_up{target="dm"} 0|1`, `headscale_standby_health_up{target="m920s"} 0|1`. Exit 0 on success, 1 on sync failure (metrics still written), 3 if `local_live` (refuses, metrics still written with health values).

- [ ] **Step 1: Failing state**: `systemctl list-timers headscale-standby-sync.timer --no-legend | wc -l` on m920s → `0`.

- [ ] **Step 2: Write `headscale-standby-sync.sh`**

Order: write health metrics first (both probes); if `local_live` → `log "refusing: local headscale is live"`, exit 3. Else `ssh -i $KEY_DM ... export | tar -x -C $STAGING.tmp` (fresh temp dir under `$STAGING`), `sqlite3 $STAGING.tmp/db.sqlite 'PRAGMA integrity_check'` must print `ok`, `ssh ... config > dm-config.yaml`, then `mv` the three files into place atomically, write `.last-sync`, `diff -q dm-config.yaml <(sed -f /usr/local/lib/headscale-standby/config.yaml.sed /etc/headscale/config.yaml)` → on difference `log "WARN: dm config drifted from standby config"` (do not overwrite). Write metrics via temp file + `mv`. (Install `config.yaml.sed` to `/usr/local/lib/headscale-standby/` in this task.)

- [ ] **Step 3: Units**: `headscale-standby-sync.service` (`Type=oneshot`, `ExecStart=/usr/local/sbin/headscale-standby-sync.sh`); `.timer` (`OnBootSec=2min`, `OnUnitActiveSec=1min`, `AccuracySec=5s`, `[Install] WantedBy=timers.target`).

- [ ] **Step 4: Install and run once**

```bash
systemctl daemon-reload && systemctl enable --now headscale-standby-sync.timer && systemctl start headscale-standby-sync.service
ls -la /var/lib/headscale/standby/; cat /var/lib/node_exporter/textfile_collector/headscale_standby.prom
sqlite3 /var/lib/headscale/standby/db.sqlite 'PRAGMA integrity_check; SELECT count(*) FROM nodes;'
```
Expected: three files + `.last-sync`; metrics with `sync_ok 1`, `health_up{target="dm"} 1`, `health_up{target="m920s"} 0`; `ok` and `14` (today's node count; print, not assert).

- [ ] **Step 5: Verify Prometheus sees it**

`curl -s 'https://prometheus.el-jefe.me/api/v1/query?query=headscale_standby_sync_ok'` → a result with `instance="100.64.0.2:9100"` and value `1` (wait up to 2 min for scrape). (Prometheus datasource, not Mimir, per the RAPL note.)

- [ ] **Step 6: Commit**

```bash
git add scripts/headscale-standby/m920s/headscale-standby-sync.*
git commit -m "headscale-standby: minute pull sync into staging with textfile metrics"
```

---

### Task 4: router DNS target wrapper (BE88U + AX86U)

**Files:**
- Create: `scripts/headscale-standby/routers/headscale-dns-target.sh`

**Interfaces:**
- Produces: `/jffs/scripts/headscale-dns-target.sh {status|dm|m920s}` on both routers, invoked only through forced-command keys `/root/.ssh/headscale-standby-be88u` and `/root/.ssh/headscale-standby-ax86u` on m920s. `status` prints `<router> <current-ip>` (e.g. `be88u 192.168.50.152`). `dm`/`m920s` set the record to `192.168.50.152`/`192.168.50.155`, back up the edited file to `<file>.bak-<YYYYmmdd-HHMMSS>`, reload the resolver, then print the new `status` line; idempotent (no backup, no reload if already set). Exit 64 on any other argument.

- [ ] **Step 1: Failing state**: from m920s, `ssh -i /root/.ssh/headscale-standby-be88u -p 2222 maxjeffwell@192.168.50.1 status` → `Permission denied` (generate both keys first, as in Task 1 Step 1; both routers: user `maxjeffwell`, port 2222).

- [ ] **Step 2: Write `routers/headscale-dns-target.sh`** (busybox `sh`, no bashisms)

Detect router by `nvram get productid`: `RT-BE88U` → file `/jffs/configs/hosts.homearpa`, line `^[0-9.]* headscale\.el-jefe\.me$`, reload `service restart_dnsmasq`. `RT-AX86U_PRO` → file `/opt/share/unbound/configs/unbound.conf.add`, line containing `headscale.el-jefe.me. 60 IN A`, reload `unbound-control local_data_remove headscale.el-jefe.me && unbound-control local_data "headscale.el-jefe.me. 60 IN A <ip>"`. Use `$SSH_ORIGINAL_COMMAND` as the argument when set (forced command), else `$1`.

- [ ] **Step 3: Install on both routers, authorize keys**

Copy to `/jffs/scripts/headscale-dns-target.sh`, `chmod 755`. Add the key line to Merlin's authorized keys via nvram on each router:
```sh
nvram set sshd_authkeys="$(nvram get sshd_authkeys)
command=\"/jffs/scripts/headscale-dns-target.sh\",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 <pubkey> headscale-standby-<router>"
nvram commit; service restart_sshd
```

- [ ] **Step 4: Verify status, refusal, and a no-op set**

From m920s:
```bash
ssh -i /root/.ssh/headscale-standby-be88u -p 2222 maxjeffwell@192.168.50.1 status
ssh -i /root/.ssh/headscale-standby-ax86u -p 2222 maxjeffwell@192.168.50.103 status
ssh -i /root/.ssh/headscale-standby-be88u -p 2222 maxjeffwell@192.168.50.1 'cat /etc/passwd'; echo "exit=$?"
ssh -i /root/.ssh/headscale-standby-be88u -p 2222 maxjeffwell@192.168.50.1 dm   # no-op: already dm
dig +short headscale.el-jefe.me @192.168.50.1; dig +short headscale.el-jefe.me @192.168.50.103
```
Expected: `be88u 192.168.50.152`, `ax86u 192.168.50.152`, refusal with `exit=64`, `be88u 192.168.50.152` with no `.bak-` file created (`ls /jffs/configs/hosts.homearpa.bak-*` unchanged), both digs `192.168.50.152`.

- [ ] **Step 5: Commit**

```bash
git add scripts/headscale-standby/routers/headscale-dns-target.sh
git commit -m "headscale-standby: router split-horizon target wrapper (BE88U, AX86U)"
```

---

### Task 5: VPS bootstrap DNAT target wrapper

**Files:**
- Create: `scripts/headscale-standby/vps/headscale-bootstrap-target`
- Create: `scripts/headscale-standby/vps/headscale-bootstrap-dnat.service`
- Create: `scripts/headscale-standby/vps/headscale-bootstrap.default`

**Interfaces:**
- Produces on the VPS: `/etc/default/headscale-bootstrap` with `TARGET_IP=10.0.0.9`; `headscale-bootstrap-dnat.service` rewritten to `EnvironmentFile=/etc/default/headscale-bootstrap` and `${TARGET_IP}` in both iptables rules (same `After/Wants=network-pre.target`, same rule shapes as today); `/usr/local/sbin/headscale-bootstrap-target {status|dm|m920s}` → `status` prints `vps <TARGET_IP> <rule-present:yes|no>`; `dm`/`m920s` write the default file, `systemctl restart headscale-bootstrap-dnat`, verify the OUTPUT DNAT rule for the new IP exists and the old one is gone, print status. Key `/root/.ssh/headscale-standby-vps` on m920s, forced command `sudo -n /usr/local/sbin/headscale-bootstrap-target`.

- [ ] **Step 1: Failing state**: `ssh vmi3610371 'test -f /etc/default/headscale-bootstrap; echo $?'` → `1`.

- [ ] **Step 2: Write the three files** per Interfaces. The unit's two `ExecStart` and one `ExecStop` keep today's exact rule text with `10.0.0.9` replaced by `${TARGET_IP}` (the existing unit text is in the spec's §Current state; fetch it with `systemctl cat` on the VPS to copy verbatim).

- [ ] **Step 3: Install on the VPS**

```bash
scp vps/* vmi3610371:/tmp/
ssh vmi3610371 'sudo install -m 644 /tmp/headscale-bootstrap.default /etc/default/headscale-bootstrap && sudo install -m 755 /tmp/headscale-bootstrap-target /usr/local/sbin/ && sudo install -m 644 /tmp/headscale-bootstrap-dnat.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl restart headscale-bootstrap-dnat && sudo iptables -t nat -S OUTPUT | grep 198.51.100.53'
```
Expected: one rule `--to-destination 10.0.0.9:8443`. Then `tailscale status --peers=false` on the VPS still shows the node (its tailscaled still reaches dm). Authorize the m920s key in `~maxjeffwell/.ssh/authorized_keys` on the VPS with `command="sudo -n /usr/local/sbin/headscale-bootstrap-target"` and the four `no-*` options.

- [ ] **Step 4: Verify from m920s**

```bash
ssh -i /root/.ssh/headscale-standby-vps maxjeffwell@10.0.0.1 status
ssh -i /root/.ssh/headscale-standby-vps maxjeffwell@10.0.0.1 'id'; echo "exit=$?"
ssh -i /root/.ssh/headscale-standby-vps maxjeffwell@10.0.0.1 dm
```
Expected: `vps 10.0.0.9 yes`; `refused` + `exit=64`; `vps 10.0.0.9 yes` with no restart logged (`journalctl -u headscale-bootstrap-dnat --since -1min` on the VPS empty).

- [ ] **Step 5: Commit**

```bash
git add scripts/headscale-standby/vps/
git commit -m "headscale-standby: VPS bootstrap DNAT target wrapper and parameterised unit"
```

---

### Task 6: promote and status scripts

**Files:**
- Create: `scripts/headscale-standby/m920s/headscale-standby-status.sh`
- Create: `scripts/headscale-standby/m920s/headscale-promote.sh`

**Interfaces:**
- Consumes: `common.sh`; Task 4/5 wrappers; Task 3 staging + `.last-sync`.
- Produces: `headscale-standby-status.sh` prints one line per pointer: `dm-health up|down`, `m920s-health up|down`, `be88u <ip>`, `ax86u <ip>`, `vps <ip>`, `endpoints <ip>` (from `kubectl -n headscale get endpoints headscale -o jsonpath='{.subsets[0].addresses[0].ip}'` with `KUBECONFIG=/etc/rancher/k3s/k3s.yaml`), `sync-age <seconds>`, `timer enabled|disabled`. `headscale-promote.sh [--force] [--dry-run]`: exit 0 done, 2 refused, 1 step failed. Steps exactly in the spec's §3 order (guard; timer off; copy staging → live; start headscale, wait `/health`; start nginx; BE88U; AX86U; VPS; Endpoints; summary). `--dry-run` prints each step as `WOULD: <action>` with the current value and exits 0 without changing anything.

- [ ] **Step 1: Write `headscale-standby-status.sh`**, install, run. Expected today:
```
dm-health up
m920s-health down
be88u 192.168.50.152
ax86u 192.168.50.152
vps 10.0.0.9
endpoints 10.0.0.9
sync-age <under 120>
timer enabled
```

- [ ] **Step 2: Write `headscale-promote.sh`**

Guard: `dm_live && [ -z "$FORCE" ]` → `echo "refused: dm headscale answers (use --force to override)"; exit 2`. Sync age `> 900` and no `--force` → `refused: last sync <age>s ago`; exit 2. Each pointer step reads current state first and skips with `already: <value>` when set. DB copy: `rm -f /var/lib/headscale/db.sqlite{,-wal,-shm}`, `cp $STAGING/db.sqlite $STAGING/noise_private.key /var/lib/headscale/`, `chown headscale:headscale`, `chmod 600`. Wait for health: up to 30 s polling `http://127.0.0.1:8081/health`. Node count: `headscale nodes list -o json | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))'`. Endpoints patch: `kubectl -n headscale patch endpoints headscale --type=json -p '[{"op":"replace","path":"/subsets/0/addresses/0/ip","value":"10.0.0.12"}]'`. Verifies at the end: `dig +short headscale.el-jefe.me @192.168.50.1` and `@192.168.50.103` == `192.168.50.155`; `curl -s --max-time 5 https://headscale.el-jefe.me/health` resolved via `--resolve headscale.el-jefe.me:443:192.168.50.155` → 200; `ssh ... vps status` shows `10.0.0.12`; `kubectl ... endpoints` shows `10.0.0.12`. Summary lists each with OK/FAIL and prints `demote: headscale-demote.sh`.

- [ ] **Step 3: Verify the guard (Review Focus 2) and dry-run**

On m920s with dm up:
```bash
headscale-promote.sh; echo "exit=$?"
headscale-promote.sh --dry-run --force | grep -c '^WOULD:'
headscale-standby-status.sh | head -2
```
Expected: `refused: dm headscale answers (use --force to override)` and `exit=2`; `WOULD:` count `9`; status unchanged (`m920s-health down`). `ls /var/lib/headscale/` still has no `db.sqlite`.

- [ ] **Step 4: Verify idempotency logic (Review Focus 3) without promoting**

`bash -x headscale-promote.sh --dry-run --force 2>&1 | grep -c 'already:'` → `0` today (nothing is set to m920s yet). Documented expectation: after a real promote, a second run prints `already:` for every pointer step and exits 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/headscale-standby/m920s/headscale-standby-status.sh scripts/headscale-standby/m920s/headscale-promote.sh
git commit -m "headscale-standby: status and promote scripts"
```

---

### Task 7: demote script

**Files:**
- Create: `scripts/headscale-standby/m920s/headscale-demote.sh`

**Interfaces:**
- Consumes: everything above; an interactive ssh to dm as `maxjeffwell` with sudo for the dm-side actions (operator's normal key, not the forced-command key — demote is operator-run).
- Produces: `headscale-demote.sh [--keep-dm-db] [--dry-run]`: exit 0 done, 2 refused, 1 step failed. Order per spec §4: guard (dm ssh reachable AND `ssh dm systemctl is-active headscale` == `inactive`, else `refused: dm headscale is <state>`); DB decision (default copy m920s live `db.sqlite` → dm `/var/lib/headscale/db.sqlite` after `.backup` on m920s and keeping dm's as `db.sqlite.demoted-<ts>`; `--keep-dm-db` skips copy and keeps m920s's as `db.sqlite.demoted-<ts>`); stop+disable headscale, nginx on m920s; BE88U/AX86U/VPS/Endpoints back to dm values; `ssh dm sudo systemctl start headscale nginx headscale-bootstrap-dnat`; verify both paths resolve/answer from dm; `systemctl enable --now headscale-standby-sync.timer`; summary.

- [ ] **Step 1: Write `headscale-demote.sh`** per Interfaces, reusing the pointer-step functions from promote (move them into `common.sh` as `set_pointer <be88u|ax86u|vps|endpoints> <dm|m920s>` and `get_pointer <name>`; update promote to use them; keep this task's commit including that refactor).

- [ ] **Step 2: Verify guard (Review Focus 4) and dry-run**

On m920s with dm up:
```bash
headscale-demote.sh; echo "exit=$?"
headscale-demote.sh --dry-run | head -3
```
Expected: `refused: dm headscale is active` and `exit=2`; dry-run also exits 2 at the guard (the guard runs before dry-run output; document that `--dry-run` only shows steps when the guard passes).

- [ ] **Step 3: Commit**

```bash
git add scripts/headscale-standby/common.sh scripts/headscale-standby/m920s/headscale-promote.sh scripts/headscale-standby/m920s/headscale-demote.sh
git commit -m "headscale-standby: demote script; pointer helpers shared via common.sh"
```

---

### Task 8: alerts

**Files:**
- Create: `k8s/headscale/prometheusrule.yaml`

**Interfaces:**
- Consumes: Task 3 metrics.
- Produces: PrometheusRule `headscale-standby` in namespace `headscale`, labels matching the other rules in this repo (copy the `metadata.labels` block from `k8s/goldpinger/prometheusrule.yaml`), group `headscale-standby` with:
  - `HeadscaleStandbySyncStale`: `expr: (time() - headscale_standby_last_sync_timestamp_seconds > 900) or (headscale_standby_sync_ok == 0)`, `for: 10m`, `severity: warning`.
  - `HeadscaleTwoWriters`: `expr: sum(headscale_standby_health_up) == 2`, `for: 5m`, `severity: critical`, annotation `summary: both dm and m920s headscale answer /health — run headscale-demote.sh`.

- [ ] **Step 1: Failing state**: `kubectl -n headscale get prometheusrule headscale-standby` → `NotFound`.
- [ ] **Step 2: Write the file**; validate: `kubectl apply --dry-run=server -f k8s/headscale/prometheusrule.yaml` → `created (server dry run)`.
- [ ] **Step 3: Commit and let ArgoCD sync** (app `headscale` watches `k8s/headscale/`):

```bash
git add k8s/headscale/prometheusrule.yaml
git commit -m "headscale: standby sync-stale and two-writers alerts"
git push origin main
```
Verify after sync: `curl -s https://prometheus.el-jefe.me/api/v1/rules | python3 -c "import json,sys; print([r['name'] for g in json.load(sys.stdin)['data']['groups'] for r in g['rules'] if r['name'].startswith('HeadscaleStandby') or r['name']=='HeadscaleTwoWriters'])"` → both names.

---

### Task 9: runbook and rehearsal

**Files:**
- Create: `docs/runbooks/headscale-cold-standby.md`

**Interfaces:**
- Consumes: all scripts' exit codes and messages as named above.

- [ ] **Step 1: Write the runbook** with sections: When to promote (dm unreachable > 15 min and you need joins/ACL/DNS changes; not for a planned reboot); Promote (`sudo headscale-promote.sh`, what `refused:` lines mean, `--force` semantics); Demote (preconditions, `--keep-dm-db` decision rule: keep dm's DB only if m920s served no registrations, check `headscale nodes list` last-seen on both); Manual fallbacks (the exact BE88U `sed`, AX86U `unbound-control`, VPS `headscale-bootstrap-target`, and `kubectl patch` commands); Rebuilt-dm procedure (Task 2 recipe with addresses swapped, then demote); Known limits (blocky `.142` keeps dm's address up to 1 h; dm's own tailscaled is pinned to itself and stays stranded while promoted; keep headscale versions equal, `apt-mark hold` on both); Alerts and what to do.

- [ ] **Step 2: Rehearsal (needs the operator's go; schedule a quiet evening)**

With the operator present: `ssh debian-marmoset sudo systemctl stop headscale` → on m920s `headscale-promote.sh` (no `--force` needed now) → `headscale-standby-status.sh` all pointers `m920s`/`192.168.50.155`/`10.0.0.12`, `m920s-health up` → `tailscale status` on marmoset and the VPS still healthy; from marmoset `tailscale netcheck` fine; from a LAN client `curl https://headscale.el-jefe.me/health` → 200 → `headscale-demote.sh` → status back to dm values, `dm-health up`, timer `enabled`, next sync `ok`. Record node counts before/after in the runbook's "last rehearsal" line with the date.

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/headscale-cold-standby.md
git commit -m "docs: headscale cold standby runbook and first rehearsal"
git push origin main
```

---

## Self-review notes

- Spec §1–§7 each map to Tasks 2, 3, 6, 7, 8, 9, and §7 (no guard) is enforced by the absence of any dm-side unit change beyond Task 1.
- `set_pointer`/`get_pointer` names are introduced in Task 7 and used by both promote and demote from then on; Task 6's promote is written standalone and refactored in Task 7 (stated in Task 7 Step 1).
- Review Focus items 1–5 are pinned in Tasks 3, 6, 6, 7, 3 respectively.
