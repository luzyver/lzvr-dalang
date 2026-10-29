# Incident Response

## Response Metrics

- **MTTD** (Mean Time to Detect): Target < 5 minutes
- **MTTA** (Mean Time to Acknowledge): Target < 5 minutes
- **MTTR** (Mean Time to Resolve): Target < 30 minutes
- **MTBF** (Mean Time Between Failures): Maximize

### Severity Levels

| Level | Impact | Response | Example |
|-------|--------|----------|---------|
| SEV1 | Complete outage | Immediate | Database down, payment failed |
| SEV2 | Major degradation | 15 min | API latency >5s, 50% errors |
| SEV3 | Minor degradation | 1 hour | Non-critical feature broken |
| SEV4 | Low impact | Business hours | UI glitch, logging issues |

## Runbook Template

```markdown
# Runbook: High API Error Rate

## Symptoms
- Alert: `sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) > 0.05`
- Dashboard: https://grafana.example.com/d/api-errors

## Impact
Users cannot complete purchases (~$X per minute)

## Triage
1. Check dashboard for affected endpoints
2. Check recent deployments: `kubectl rollout history deployment/api`
3. Check dependencies: database, redis, external APIs

## Resolution

> **Warning:** the options below change production. Confirm the cluster context (`kubectl config current-context`), preview with `kubectl diff` or `--dry-run=server` where supported, and run only with the person's approval.

### Option 1: Rollback
kubectl rollout history deployment/api -n production
kubectl rollout undo deployment/api -n production

### Option 2: Scale Up
kubectl scale deployment/api --replicas=10 -n production

### Option 3: Fix Config
kubectl set env deployment/api DB_POOL_SIZE=50 -n production --dry-run=server -o yaml   # review, then re-run without --dry-run

## Verification
- [ ] Error rate <1%
- [ ] P95 latency <500ms
- [ ] Health checks passing

## Communication
- Update status page
- Notify #incidents
- Post if user-facing
```

## Auto-Remediation Script

> **Warning:** this script rolls back a production deployment. Run it only as an approved runbook step (or behind an approval gate), with a cooldown so it cannot loop, and test it in staging first. The Deployment `rollbackTo` field was removed in apps/v1, so the rollback restores the previous ReplicaSet's pod template instead.

```python
#!/usr/bin/env python3
import time
from kubernetes import client, config
from prometheus_api_client import PrometheusConnect

COOLDOWN_SECONDS = 3600

class IncidentRemediator:
    def __init__(self, prometheus_url, approved=False):
        config.load_kube_config()
        self.k8s = client.AppsV1Api()
        self.prometheus = PrometheusConnect(url=prometheus_url)
        self.approved = approved  # set only after the person approves the rollback
        self.last_rollback = 0.0

    def check_high_error_rate(self):
        query = (
            'sum(rate(http_requests_total{status=~"5.."}[5m]))'
            ' / sum(rate(http_requests_total[5m])) > 0.05'
        )
        result = self.prometheus.custom_query(query)
        return len(result) > 0

    def rollback_deployment(self, namespace, deployment):
        if not self.approved or time.time() - self.last_rollback < COOLDOWN_SECONDS:
            return False
        selector = self.k8s.read_namespaced_deployment(deployment, namespace).spec.selector.match_labels
        label = ",".join(f"{k}={v}" for k, v in selector.items())
        sets = self.k8s.list_namespaced_replica_set(namespace, label_selector=label).items
        sets.sort(key=lambda r: int(r.metadata.annotations["deployment.kubernetes.io/revision"]))
        if len(sets) < 2:
            return False
        previous = sets[-2]
        # Patch the pod template back to the previous revision (what `kubectl rollout undo` does)
        body = {'spec': {'template': previous.spec.template.to_dict()}}
        self.k8s.patch_namespaced_deployment(deployment, namespace, body)
        self.last_rollback = time.time()
        return True

    def create_incident(self, summary):
        raise NotImplementedError("page the on-call via your incident tool")

    def remediate(self):
        if self.check_high_error_rate():
            if self.rollback_deployment('production', 'api'):
                time.sleep(120)
                if not self.check_high_error_rate():
                    return  # Success
            # Escalate if remediation fails or was not approved
            self.create_incident("Auto-remediation failed")
```

## Postmortem Template

```markdown
# Postmortem: API Outage - 2024-01-15

**Date**: January 15, 2024
**Duration**: 45 minutes (14:23 - 15:08 UTC)
**Severity**: SEV1
**Impact**: Complete API outage, ~$25K revenue loss

## Summary
API became unresponsive due to database connection pool exhaustion
from slow query in v2.3.1.

## Timeline (UTC)
- 14:23 - Alert fired
- 14:27 - Incident declared SEV1
- 14:30 - Rollback initiated
- 14:45 - Identified slow query
- 14:50 - Killed queries
- 15:08 - Resolved

## Root Cause
New query missing index on `user_id`, causing full table scans that
exhausted connection pool under load.

## Impact
- 100% API failure for 45 minutes
- 15,000 users affected
- $25K revenue loss
- 200+ support tickets

## Action Items
| Action | Owner | Deadline |
|--------|-------|----------|
| Add index on user_id | DB team | 2024-01-16 |
| Add query perf testing | Platform | 2024-01-22 |
| Increase staging DB size | Infra | 2024-01-30 |

## Lessons Learned
- Performance testing must use production-scale data
- Connection pool exhaustion needs active intervention
- Consider circuit breakers for DB operations
```

## PagerDuty Configuration

```yaml
schedules:
  - name: Primary On-Call
    time_zone: America/New_York
    layers:
      - rotation_turn_length_seconds: 604800  # 1 week
        users: [PXXXXXX, PXXXXXX, PXXXXXX]

escalation_policies:
  - name: Production
    rules:
      - escalation_delay_in_minutes: 0
        targets: [{type: schedule, id: primary}]
      - escalation_delay_in_minutes: 15
        targets: [{type: schedule, id: secondary}]
      - escalation_delay_in_minutes: 30
        targets: [{type: user, id: manager}]
```

## Chaos Engineering

> **Warning:** chaos experiments disrupt running services. Target staging first; run in production only as a planned, approved game day.

```yaml
# chaos-mesh: Pod failure test, recurring (the v2 `scheduler` field is replaced by a Schedule resource)
apiVersion: chaos-mesh.org/v1alpha1
kind: Schedule
metadata:
  name: pod-failure-test
spec:
  schedule: "@every 2h"
  type: PodChaos
  historyLimit: 5
  concurrencyPolicy: Forbid
  podChaos:
    action: pod-failure
    mode: one
    duration: "30s"
    selector:
      namespaces: [staging]
      labelSelectors:
        app: api
```

```bash
#!/bin/bash
# Game Day: Database failover drill

echo "🎮 Game Day: Database failover"
slack-cli -d incidents "Starting failover drill"

# Simulate failure (planned, approved drill only: never run this outside a scheduled game day)
kubectl delete pod postgres-0 -n production

# Monitor recovery
start=$(date +%s)
while ! kubectl get pod postgres-1 | grep Running; do
  sleep 5
done
duration=$(($(date +%s) - start))

echo "Failover: ${duration}s" >> results.md
curl -f https://api.example.com/health || echo "FAIL"
```

## Evidence Collection & Forensics

```bash
#!/bin/bash
# collect-evidence.sh - Preserve incident evidence

INCIDENT_ID=$1
EVIDENCE_DIR="incidents/${INCIDENT_ID}/evidence"
mkdir -p $EVIDENCE_DIR

# Preserve logs
kubectl logs -l app=api --all-containers --timestamps \
  --since=2h > $EVIDENCE_DIR/pod-logs.txt

# Capture current state
kubectl get all -n production -o yaml > $EVIDENCE_DIR/k8s-state.yaml
kubectl describe pods -n production > $EVIDENCE_DIR/pod-details.txt

# Network traces: capture packets only with approval (they may contain personal data).
# Use an ephemeral debug container instead of installing tcpdump in the app pod, then copy the file out with `kubectl cp`.
kubectl debug -n production deploy/api -it --image=nicolaka/netshoot --target=api -- \
  tcpdump -i any -w /tmp/capture.pcap -G 60 -W 5

# Memory/CPU snapshot
kubectl top pods -n production > $EVIDENCE_DIR/resource-usage.txt

# Git commit at time of incident
git log --since="2 hours ago" --oneline > $EVIDENCE_DIR/recent-commits.txt

# Database queries: in Dalang use the db_query tool (not psql with implicit credentials)
# db_query: SELECT * FROM pg_stat_activity   -> save the result to $EVIDENCE_DIR/db-activity.txt

# Create timeline
echo "$(date): Evidence collection completed" >> $EVIDENCE_DIR/timeline.txt
```

## Communication Templates

```markdown
## SEV1 Initial Notification

**INCIDENT ALERT - SEV1**

**Status**: Investigating
**Impact**: Payment API unavailable (100% error rate)
**Started**: 2024-01-15 14:23 UTC
**Affected**: All users (~15K active sessions)
**Lead**: @oncall-engineer
**War Room**: https://zoom.us/incident-123

Updates every 15 minutes or on major change.

---

## SEV1 Resolution Notification

**INCIDENT RESOLVED**

**Summary**: Payment API restored after database connection pool exhaustion
**Duration**: 45 minutes (14:23 - 15:08 UTC)
**Resolution**: Rollback to v2.3.0 + query optimization
**Impact**: 15K users, ~$25K revenue loss
**Next Steps**: Postmortem scheduled for Jan 16 10am

Thanks to @oncall-team for rapid response.
```

## Incident Classification

| Type | Examples | Response Team | Escalation |
|------|----------|---------------|------------|
| **Security** | Breach, data leak, unauthorized access | Security + DevOps | CISO, Legal |
| **Service** | Outage, degradation, errors | DevOps + SRE | Engineering VP |
| **Data** | Corruption, loss, sync issues | DBA + DevOps | CTO |
| **Compliance** | GDPR, SOC2, audit violations | Compliance + Legal | CEO |
| **Third-party** | Provider outage, API failures | DevOps + Product | Account manager |

## Security Incident Specifics

```bash
# Compromise investigation checklist
□ Isolate affected systems
□ Preserve logs and memory dumps
□ Identify attack vector
□ Check for lateral movement
□ Scan for malware/backdoors
□ Review access logs for 30 days
□ Identify data accessed
□ Assess exfiltration risk
□ Check for persistence mechanisms
□ Coordinate with security team
□ Notify legal if PII involved
□ Document chain of custody
```

## Compliance Requirements

```yaml
# Incident notification requirements
gdpr:
  notification_deadline: 72h
  authority: Data Protection Officer
  required_info:
    - Nature of breach
    - Data categories affected
    - Number of individuals
    - Consequences
    - Remediation measures

sox:
  notification_deadline: immediate
  authority: Audit Committee
  documentation:
    - Financial impact
    - Control failures
    - Remediation plan

pci_dss:
  notification_deadline: 24h
  authority: Card brands + acquirer
  required_info:
    - Cardholder data affected
    - Incident timeline
    - Forensic investigation
```

## Best Practices

- Maintain runbooks for critical services
- Practice with game days monthly
- Automate common remediation
- Keep postmortems blameless
- Track incident metrics
- Test recovery procedures
- Document all incidents
- Improve detection continuously
- Preserve evidence chain properly
- Coordinate communication clearly
- Escalate security incidents immediately
- Understand compliance obligations
- Train team on response procedures
- Review and update playbooks quarterly
