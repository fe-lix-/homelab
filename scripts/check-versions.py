#!/usr/bin/env python3
"""Check and update Docker image versions for homelab services.

Usage:
    python3 scripts/check-versions.py            # Show current vs latest
    python3 scripts/check-versions.py --update    # Update defaults files

Set GITHUB_TOKEN env var to avoid GitHub API rate limiting (60 req/hr unauthenticated).
"""

import json
import os
import re
import sys
import urllib.request
from pathlib import Path

ROLES_DIR = Path(__file__).resolve().parent.parent / "roles"
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")


def github_request(url):
    headers = {"Accept": "application/vnd.github.v3+json"}
    if GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def github_latest_release(repo):
    data = github_request(f"https://api.github.com/repos/{repo}/releases/latest")
    return data["tag_name"]


def dockerhub_tags(name, namespace="library", page_size=50):
    url = f"https://hub.docker.com/v2/repositories/{namespace}/{name}/tags?page_size={page_size}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())["results"]


def strip_linuxserver(tag):
    """Strip linuxserver suffixes (-lsNNN, -rN) and v prefix from release tags.

    Linuxserver release tags look like: 4.0.16.2944-ls268, 5.1.4-r0-ls337, v1.5.6-ls123
    Docker image tags use the upstream version: 4.0.16, 5.1.4, 1.5.6
    We strip suffixes, the v prefix, and any trailing build numbers beyond
    the upstream version (3 parts for most, detected by semver pattern).
    """
    tag = re.sub(r"-ls\d+$", "", tag)
    tag = re.sub(r"-r\d+$", "", tag)
    tag = tag.lstrip("v")
    # For *arr apps: tags like 4.0.16.2944 -> 4.0.16 (strip build number)
    # Keep only the semver-like part (up to 3 dotted numbers)
    m = re.match(r"^(\d+\.\d+\.\d+)", tag)
    if m:
        return m.group(1)
    return tag


def get_cadvisor_latest():
    """Find latest cadvisor version from GCR (GitHub releases often lag image availability)."""
    url = "https://gcr.io/v2/cadvisor/cadvisor/tags/list"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=10) as resp:
        tags = json.loads(resp.read())["tags"]
    versions = sorted(
        [t for t in tags if re.match(r"^v\d+\.\d+\.\d+$", t)],
        key=lambda t: [int(x) for x in t[1:].split(".")],
    )
    return versions[-1] if versions else None


def get_nginx_stable():
    """Find latest nginx stable version by resolving the 'stable' tag digest."""
    # Fetch the stable tag directly
    url = "https://hub.docker.com/v2/repositories/library/nginx/tags/stable"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=10) as resp:
        stable_digest = json.loads(resp.read())["digest"]

    # Search for a plain semver tag (e.g. 1.28.2) sharing that digest
    url = "https://hub.docker.com/v2/repositories/library/nginx/tags?page_size=100&name=1."
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=10) as resp:
        for tag in json.loads(resp.read())["results"]:
            if re.match(r"^\d+\.\d+\.\d+$", tag["name"]) and tag["digest"] == stable_digest:
                return tag["name"]
    return None


# (display_name, var_name, github_repo, transform_fn, role_dir)
# transform_fn converts a GitHub release tag_name to a Docker image tag
# role_dir defaults to display_name if not specified
GITHUB_SERVICES = [
    ("jellyfin", "jellyfin_version", "jellyfin/jellyfin", lambda t: t.lstrip("v")),
    ("komga", "komga_version", "gotson/komga", lambda t: t.lstrip("v")),
    ("homepage", "homepage_version", "gethomepage/homepage", lambda t: t),
    ("audiobookshelf", "audiobookshelf_version", "advplyr/audiobookshelf", lambda t: t.lstrip("v")),
    ("uptime-kuma", "uptime_kuma_version", "louislam/uptime-kuma", lambda t: t),
    ("grafana", "grafana_version", "grafana/grafana", lambda t: t.lstrip("v"), "monitoring"),
    ("loki", "loki_version", "grafana/loki", lambda t: t.lstrip("v"), "monitoring"),
    ("alloy", "alloy_version", "grafana/alloy", lambda t: t, "monitoring"),
    ("prometheus", "prometheus_version", "prometheus/prometheus", lambda t: t, "monitoring"),
    ("node-exporter", "node_exporter_version", "prometheus/node_exporter", lambda t: t, "monitoring"),
    ("goploader", "goploader_version", "Depado/goploader", lambda t: t.lstrip("v")),
    ("authelia", "authelia_version", "authelia/authelia", lambda t: t.lstrip("v")),
    ("homeassistant", "homeassistant_version", "home-assistant/core", lambda t: t.lstrip("v")),
]

LINUXSERVER_SERVICES = [
    "sonarr", "radarr", "lidarr", "prowlarr",
    "bazarr", "qbittorrent", "sabnzbd",
]

# (display_name, var_name, namespace, image_name, tracked_tag)
# Tracks services that have no versioned tags — pinned by digest.
# Fetches the current digest of tracked_tag and compares to the stored digest.
DOCKERHUB_DIGEST_SERVICES = [
    ("mediathekarr", "mediathekarr_version", "pcjones", "mediathekarr", "beta"),
]


def dockerhub_tag_digest(namespace, image, tag):
    """Fetch the current digest for a specific Docker Hub tag."""
    tags = dockerhub_tags(image, namespace=namespace)
    for t in tags:
        if t["name"] == tag:
            return t["digest"]
    return None


ROLE_DIR_OVERRIDES = {
    "cadvisor": "monitoring",
}


def _role_dir(name):
    """Return the role directory for a service, checking for role_dir overrides."""
    if name in ROLE_DIR_OVERRIDES:
        return ROLE_DIR_OVERRIDES[name]
    for entry in GITHUB_SERVICES:
        if entry[0] == name and len(entry) > 4:
            return entry[4]
    return name


def read_current_version(role, var):
    defaults = ROLES_DIR / _role_dir(role) / "defaults" / "main.yml"
    for line in defaults.read_text().splitlines():
        m = re.match(rf'^{re.escape(var)}:\s*"?([^"\s#]+)"?\s*(#.*)?$', line)
        if m:
            return m.group(1)
    return None


def update_version(role, var, new_version):
    defaults = ROLES_DIR / _role_dir(role) / "defaults" / "main.yml"
    content = defaults.read_text()
    content = re.sub(
        rf'^({re.escape(var)}:\s*)"?[^"\s]+"?',
        rf'\1"{new_version}"',
        content,
        flags=re.MULTILINE,
    )
    defaults.write_text(content)


def fetch_latest(role, var):
    """Return the latest Docker tag for a service, or (None, error_msg) on failure."""
    try:
        # Linuxserver images
        if role in LINUXSERVER_SERVICES:
            tag = github_latest_release(f"linuxserver/docker-{role}")
            return strip_linuxserver(tag), None

        # Nginx (Docker Hub)
        if role == "nginx":
            version = get_nginx_stable()
            if not version:
                return None, "could not find stable tag"
            return version, None

        # cadvisor (GCR — GitHub releases often ahead of image availability)
        if role == "cadvisor":
            version = get_cadvisor_latest()
            if not version:
                return None, "could not find tag"
            return version, None

        # GitHub-hosted services
        for name, _, repo, transform, *_ in GITHUB_SERVICES:
            if name == role:
                return transform(github_latest_release(repo)), None

        # Digest-pinned services
        for name, _, namespace, image, tag in DOCKERHUB_DIGEST_SERVICES:
            if name == role:
                digest = dockerhub_tag_digest(namespace, image, tag)
                if not digest:
                    return None, f"tag '{tag}' not found"
                return digest, None

        return None, "unknown service"
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}"
    except Exception as e:
        return None, str(e)


def main():
    do_update = "--update" in sys.argv

    services = (
        [(name, f"{name}_version") for name in LINUXSERVER_SERVICES]
        + [(name, var) for name, var, *_ in GITHUB_SERVICES]
        + [("nginx", "nginx_version")]
        + [("cadvisor", "cadvisor_version")]
        + [(name, var) for name, var, *_ in DOCKERHUB_DIGEST_SERVICES]
    )

    print(f"\n{'Service':<20} {'Current':<20} {'Latest':<20} {'Status'}")
    print("-" * 75)

    updates = []
    errors = 0

    for role, var in services:
        current = read_current_version(role, var)
        latest, err = fetch_latest(role, var)

        if err:
            print(f"{role:<20} {current or '?':<20} {'ERROR':<20} {err}")
            errors += 1
            continue

        if current == latest:
            status = "ok"
        else:
            status = "UPDATE AVAILABLE"
            updates.append((role, var, current, latest))

        print(f"{role:<20} {current or '?':<20} {latest:<20} {status}")

    print()

    if errors:
        print(f"{errors} error(s) fetching versions.")

    if not updates:
        print("All services are up to date.")
        return 0

    print(f"{len(updates)} update(s) available.")

    if do_update:
        print()
        for role, var, current, latest in updates:
            update_version(role, var, latest)
            print(f"  {role}: {current} -> {latest}")
        print("\nDefaults files updated. Review changes with 'git diff', then 'make deploy'.")
    else:
        print("Run with --update to apply all updates.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
