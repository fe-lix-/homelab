# Screen Time Monitoring

Monitor kids' screen time across multiple devices by analyzing Pi-hole DNS query logs.

## What's Tracked

| Service | Domain Patterns |
|---------|----------------|
| Komga | `komga.lab.delval.eu` |
| Netflix | `netflix.com`, `nflxvideo.net`, `nflxso.net`, `nflximg.net` |
| YouTube | `youtube.com`, `googlevideo.com`, `ytimg.com`, `youtu.be` |
| Roblox | `roblox.com`, `rbxcdn.com` |
| PKXD | `pkxd.com`, `playpkxd.com` |
| Minecraft | `mojang.com`, `minecraft.net`, `minecraftservices.com` |
| ChatGPT | `openai.com`, `chatgpt.com`, `oaiusercontent.com` |
| Claude | `claude.ai`, `anthropic.com` |

## Devices

- iPad
- iPhone
- Windows 11 PC

All devices must use Pi-hole (`10.0.0.163`) as their DNS server for queries to be tracked. See [Prerequisites](#prerequisites).

## How It Works

```
Kids' devices ──DNS queries──> Pi-hole (logs all queries with client IP + timestamp)
                                  |
                        screentime-collector (polls Pi-hole API every 60s)
                                  |
                         Categorizes queries by domain pattern -> service
                         Counts distinct "active minutes" per service per device
                                  |
                         Exposes Prometheus metrics at :9200/metrics
                                  |
                         Prometheus scrapes -> Grafana dashboard
```

**"Active minutes"**: The number of distinct minutes in which at least one DNS query matched a service's domain pattern. This is a proxy for actual screen time -- not exact, but effective for identifying usage patterns.

## Architecture

- **screentime-collector**: Python container (Alpine) polling Pi-hole's API. Follows the same pattern as `webhook-receiver` in the monitoring stack.
- **Prometheus**: Scrapes metrics from the collector every 15s.
- **Grafana**: "Screen Time" dashboard with daily totals, per-service breakdowns, activity timelines, and trends.

### Prometheus Metrics

| Metric | Labels | Description |
|--------|--------|-------------|
| `screentime_active_minutes` | `device`, `service` | Active minutes today |
| `screentime_queries_total` | `device`, `service` | DNS query count today |
| `screentime_last_seen_timestamp` | `device`, `service` | Last query Unix timestamp |
| `screentime_total_active_minutes` | `device` | Total minutes across all services |
| `screentime_collector_errors_total` | | Polling error count |
| `screentime_last_poll_timestamp` | | Last successful poll timestamp |

## Prerequisites

### 1. Static DHCP Leases

Each kid's device needs a static IP assigned via the UniFi controller (Settings > Networks > DHCP > Static Leases). This ensures the device always gets the same IP so Pi-hole logs are consistent.

### 2. DNS Configuration

Devices must query Pi-hole directly (not through the router). Two options:

**Option A (recommended): Change DHCP DNS on the router**
In UniFi controller: Settings > Networks > Default > DHCP Name Server > set to `10.0.0.163`. All devices on the network will then use Pi-hole directly, and Pi-hole will see each device's real IP.

**Option B: Per-device DNS**
Manually set DNS to `10.0.0.163` on each kid's device:
- iOS: Settings > Wi-Fi > (network) > Configure DNS > Manual > `10.0.0.163`
- Windows: Settings > Network > Ethernet/Wi-Fi > DNS server assignment > Manual > `10.0.0.163`

### 3. Pi-hole API Token

The collector needs a Pi-hole API token. Get it from: Pi-hole Admin > Settings > API > Show API token. Store it in the Ansible vault as `screentime_pihole_api_token`.

### 4. Vault Configuration

Add to `vault.yml`:
```yaml
screentime_pihole_api_token: "<token from Pi-hole>"
screentime_devices:
  - name: "kid_ipad"
    ip: "10.0.0.XX"
  - name: "kid_iphone"
    ip: "10.0.0.XX"
  - name: "kid_pc"
    ip: "10.0.0.XX"
```

## Relationship to Apple Screen Time

Apple Screen Time (via Family Sharing) provides:
- Exact per-app usage minutes on iOS
- Enforcement (app limits, downtime schedules)
- Works on cellular / off-WiFi

This Pi-hole-based monitoring adds:
- Unified dashboard across iOS + Windows in Grafana
- Windows PC tracking (Apple Screen Time doesn't cover this)
- Cross-device aggregation ("total YouTube across all devices")
- Historical trends over 30+ days
- No agent installation needed on any device

They are complementary -- Apple Screen Time handles iOS enforcement, this system provides visibility.

## Adding a New Service

Edit `roles/screentime/defaults/main.yml` and add to `screentime_services`:

```yaml
screentime_services:
  new_service:
    domains:
      - "example.com"
      - "cdn.example.com"
```

Then deploy: `make deploy-role ROLE=screentime`

To find the right domains: check Pi-hole's Query Log (pihole.lab.delval.eu/admin) while using the service to see which domains are queried.

## Adding a New Device

1. Assign a static DHCP lease in UniFi
2. Ensure the device uses Pi-hole for DNS
3. Add to `screentime_devices` in vault
4. Deploy: `make deploy-role ROLE=screentime`

## Limitations

- **DNS-based = approximate**: Background queries (prefetch, keep-alive) may slightly inflate minutes. The "distinct minutes" metric smooths this out.
- **DNS-over-HTTPS bypass**: If a device/browser uses DoH (e.g., Firefox default), queries bypass Pi-hole. iOS respects network DNS by default. On Windows, ensure DoH is disabled in browser settings.
- **Off-WiFi**: When devices are off home WiFi (cellular, school, etc.), no queries reach Pi-hole. Apple Screen Time covers this gap for iOS.
- **Domain overlap**: Some CDN domains may be shared between services. Tune domain lists after observing real data.
- **Not real-time**: Metrics update every 60 seconds. Grafana refresh adds another 15s delay.

## Deployment

```bash
make deploy-role ROLE=screentime    # Deploy the collector
make deploy-role ROLE=monitoring    # Update Prometheus config + Grafana dashboard
```

## Verification

```bash
# Check collector is running
ssh kazaddum curl -s http://127.0.0.1:9200/health

# Check metrics are being emitted
ssh kazaddum curl -s http://127.0.0.1:9200/metrics | grep screentime

# Check Grafana dashboard
# Open grafana.lab.delval.eu -> Screen Time dashboard
```
