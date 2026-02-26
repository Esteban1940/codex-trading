# Deploy with systemd

This option is useful when you run the bot directly on a Linux host.

## 1) Install units

```bash
sudo cp ops/systemd/codex-worker.service /etc/systemd/system/
sudo cp ops/systemd/codex-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable codex-worker.service codex-api.service
```

## 2) First start

```bash
sudo systemctl start codex-worker.service
sudo systemctl start codex-api.service
sudo systemctl status codex-worker.service --no-pager -l
sudo systemctl status codex-api.service --no-pager -l
```

## 3) Controlled rollout and rollback

Rollout latest `main` with full checks:

```bash
./scripts/deploy-rollout.sh rollout
```

Rollback to previous commit (or specific ref):

```bash
./scripts/deploy-rollout.sh rollback HEAD~1
# or
./scripts/deploy-rollout.sh rollback <commit-or-tag>
```
