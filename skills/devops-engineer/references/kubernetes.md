# Kubernetes Manifests

## Complete Deployment Stack

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
  labels:
    app: app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: app
  template:
    metadata:
      labels:
        app: app
    spec:
      containers:
        - name: app
          image: ghcr.io/org/app:1.0.0   # pin a version or digest, never :latest
          ports:
            - containerPort: 3000
          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
            limits:
              memory: "256Mi"
              cpu: "500m"
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /ready
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 5
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: database-url
---
apiVersion: v1
kind: Service
metadata:
  name: app
spec:
  selector:
    app: app
  ports:
    - port: 80
      targetPort: 3000
  type: ClusterIP
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: app
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  tls:
    - hosts: [app.example.com]
      secretName: app-tls
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: app
                port:
                  number: 80
```

## ConfigMap and Secrets

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  LOG_LEVEL: "info"
  API_TIMEOUT: "30s"
---
apiVersion: v1
kind: Secret
metadata:
  name: app-secrets
type: Opaque
stringData:
  database-url: "postgres://<db-user>:<db-password>@host:5432/db"
```

## Horizontal Pod Autoscaler

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: app-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: app
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
```

## Quick Reference

| Resource | Purpose |
|----------|---------|
| Deployment | Manages ReplicaSets, rolling updates |
| Service | Internal load balancing, DNS |
| Ingress | External HTTP/HTTPS routing |
| ConfigMap | Non-sensitive configuration |
| Secret | Sensitive data (base64 encoded) |
| HPA | Auto-scaling based on metrics |
| PVC | Persistent storage claims |

## Common kubectl Commands

> **Warning:** `apply`, `exec` and `rollout undo` change a live cluster. Check the context (`kubectl config current-context`), pass `-n <namespace>`, preview with `kubectl diff -f` or `--dry-run=server`, and run only with the person's approval.

```bash
kubectl apply -f deployment.yaml --dry-run=server   # review, then re-run without the flag
kubectl get pods -n <namespace> -l app=app
kubectl describe pod <pod-name> -n <namespace>
kubectl logs -f <pod-name> -n <namespace>
kubectl exec -it <pod-name> -n <namespace> -- /bin/sh
kubectl rollout status deployment/app -n <namespace>
kubectl rollout undo deployment/app -n <namespace>
```
