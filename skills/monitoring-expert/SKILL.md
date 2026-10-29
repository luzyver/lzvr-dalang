---
name: monitoring-expert
description: Configures monitoring systems, implements structured logging pipelines, creates Prometheus/Grafana dashboards, defines alerting rules, and instruments distributed tracing. Implements Prometheus/Grafana stacks, conducts load testing, performs application profiling, and plans infrastructure capacity. Use when setting up application monitoring, adding observability to services, debugging production issues with logs/metrics/traces, running load tests with k6 or Artillery, profiling CPU/memory bottlenecks, or forecasting capacity needs.
license: MIT
metadata:
  author: https://github.com/Jeffallan
  company: https://synergetic.solutions
  version: "1.1.0"
  domain: devops
  triggers: monitoring, observability, logging, metrics, tracing, alerting, Prometheus, Grafana, DataDog, APM, performance testing, load testing, profiling, capacity planning, bottleneck
  role: specialist
  scope: implementation
  output-format: code
  related-skills: devops-engineer, debugging-wizard, architecture-designer
---

# Monitoring Expert

Observability and performance specialist implementing comprehensive monitoring, alerting, tracing, and performance testing systems.

## Running inside Dalang

- Follow the project first: use the versions, platforms, tools and layout it already has. Tools, clouds and versions named in this skill are examples and defaults, not requirements; never switch or upgrade them on your own.
- Do not add dependencies, frameworks or services the project does not already use unless the person asks.
- Commands that change a live system are hard to undo: `terraform apply`/`destroy`, `kubectl apply`/`delete`, `helm upgrade`/`rollback`, failovers and chaos drills, credential rotation, git history rewrites. Show the plan or a dry run first (`terraform plan`, `kubectl diff`, `--dry-run=server`) and ask before running it, unless the person authorized exactly this; on servers run it only through ssh_exec.
- Related skills it names that are installed here: `architecture-designer`, `devops-engineer`.
- `debugging-wizard` is not installed here; use the Dalang `systematic-debugging` skill instead.
- Databases only through the Dalang db_* tools and servers only through ssh_list_hosts/ssh_exec; never connect with credentials from .env or config files.
- Code and commands in references/ are illustrative and may use outdated API or tool versions: check them against the project's versions and current docs, pin versions, and never run them against production without a dry run and the person's approval.

## Core Workflow

1. **Assess** — Identify what needs monitoring (SLIs, critical paths, business metrics)
2. **Instrument** — Add logging, metrics, and traces to the application (see examples below)
3. **Collect** — Configure aggregation and storage (Prometheus scrape, log shipper, OTLP endpoint); verify data arrives before proceeding
4. **Visualize** — Build dashboards using RED (Rate/Errors/Duration) or USE (Utilization/Saturation/Errors) methods
5. **Alert** — Define threshold and anomaly alerts on critical paths; validate no false-positive flood before shipping

## Quick-Start Examples

### Structured Logging (Node.js / Pino)
```js
import pino from 'pino';

const logger = pino({ level: 'info' });

// Good — structured fields, includes correlation ID
logger.info({ requestId: req.id, userId: req.user.id, durationMs: elapsed }, 'order.created');

// Bad — string interpolation, no correlation
console.log(`Order created for user ${userId}`);
```

### Prometheus Metrics (Node.js)
```js
import { Counter, Histogram, register } from 'prom-client';

const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'],
});

const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'route'],
  buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5],
});

// Instrument a route
app.use((req, res, next) => {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    // Route template (/orders/:id), not req.path: raw paths explode label cardinality
    const route = req.route?.path ?? 'unmatched';
    httpRequests.inc({ method: req.method, route, status: res.statusCode });
    end({ method: req.method, route });
  });
  next();
});

// Expose scrape endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});
```

### OpenTelemetry Tracing (Node.js)
```js
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { trace, SpanStatusCode } from '@opentelemetry/api';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({ url: 'http://jaeger:4318/v1/traces' }),
});
sdk.start();

// Manual span around a critical operation
const tracer = trace.getTracer('order-service');
async function processOrder(orderId) {
  const span = tracer.startSpan('order.process');
  span.setAttribute('order.id', orderId);
  try {
    const result = await db.saveOrder(orderId);
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    span.end();
  }
}
```

### Prometheus Alerting Rule
```yaml
groups:
  - name: api.rules
    rules:
      - alert: HighErrorRate
        expr: |
          sum by (route) (rate(http_requests_total{status=~"5.."}[5m]))
          / sum by (route) (rate(http_requests_total[5m])) > 0.05
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Error rate above 5% on {{ $labels.route }}"
```

### k6 Load Test
Run load tests against staging or a dedicated test environment, never production without the person's approval.
```js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '1m', target: 50 },   // ramp up
    { duration: '5m', target: 50 },   // sustained load
    { duration: '1m', target: 0 },    // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],  // 95th percentile < 500 ms
    http_req_failed:   ['rate<0.01'],  // error rate < 1%
  },
};

export default function () {
  const res = http.get('https://api.example.com/orders');
  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(1);
}
```

## Reference Guide

Load detailed guidance based on context:

| Topic | Reference | Load When |
|-------|-----------|-----------|
| Logging | `references/structured-logging.md` | Pino, JSON logging |
| Metrics | `references/prometheus-metrics.md` | Counter, Histogram, Gauge |
| Tracing | `references/opentelemetry.md` | OpenTelemetry, spans |
| Alerting | `references/alerting-rules.md` | Prometheus alerts |
| Dashboards | `references/dashboards.md` | RED/USE method, Grafana |
| Performance Testing | `references/performance-testing.md` | Load testing, k6, Artillery, benchmarks |
| Profiling | `references/application-profiling.md` | CPU/memory profiling, bottlenecks |
| Capacity Planning | `references/capacity-planning.md` | Scaling, forecasting, budgets |

## Constraints

### MUST DO
- Use structured logging (JSON)
- Include request IDs for correlation
- Set up alerts for critical paths
- Monitor business metrics, not just technical
- Use appropriate metric types (counter/gauge/histogram)
- Implement health check endpoints

### MUST NOT DO
- Log sensitive data (passwords, tokens, PII)
- Alert on every error (alert fatigue)
- Use string interpolation in logs (use structured fields)
- Skip correlation IDs in distributed systems

Maintained by [@jeffallan](https://github.com/jeffallan), Principal Consultant at [Synergetic Solutions](https://synergetic.solutions)

[Documentation](https://jeffallan.github.io/claude-skills/skills/devops/monitoring-expert/)
