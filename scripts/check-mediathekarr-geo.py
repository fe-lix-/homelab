#!/usr/bin/env python3
"""Check that the MediathekArr container's outbound IP is located in Germany.

Usage:
    python3 scripts/check-mediathekarr-geo.py

Runs 'docker exec mediathekarr curl' inside the container so the request
goes through the VLAN 30 macvlan interface (German VPN), not the host network.
Requires SSH access to the homelab server (set SSH_TARGET env var or edit below).
"""

import json
import os
import subprocess
import sys


SSH_TARGET = os.environ.get("SSH_TARGET", "YOUR_USERNAME@YOUR_SERVER_IP")
SSH_KEY = "~/.ssh/homelab"


def get_container_ip_info():
    """Run curl inside the mediathekarr container to get its external IP info."""
    result = subprocess.run(
        [
            "ssh", "-i", SSH_KEY, SSH_TARGET,
            "docker exec mediathekarr wget -qO- --timeout=10 https://ipinfo.io/json",
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        print(f"ERROR: SSH/docker exec failed:\n{result.stderr.strip()}")
        sys.exit(1)
    return json.loads(result.stdout)


def main():
    print("Checking MediathekArr container external IP geolocation...")

    info = get_container_ip_info()

    ip      = info.get("ip", "unknown")
    country = info.get("country", "unknown")
    region  = info.get("region", "unknown")
    city    = info.get("city", "unknown")
    org     = info.get("org", "unknown")

    print(f"  IP:      {ip}")
    print(f"  Country: {country}")
    print(f"  Region:  {region}")
    print(f"  City:    {city}")
    print(f"  Org:     {org}")
    print()

    if country == "DE":
        print("OK — container is routing through Germany.")
        return 0
    else:
        print(f"FAIL — expected country DE, got '{country}'.")
        print("The VLAN 30 German VPN route may not be working correctly.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
