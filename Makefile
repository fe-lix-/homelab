.PHONY: deploy deploy-role collections vault-edit vault-create check diff logs-backup logs-immich versions versions-update check-mediathekarr-geo authelia-hash-password check-ownership provision-monitors manga-scheduler-next mc-stop mc-start dump-router generate-password

-include .env
export

VAULT_PASS_FILE := $(HOME)/.config/vaultpass
VAULT_ARG := $(if $(wildcard $(VAULT_PASS_FILE)),--vault-password-file $(VAULT_PASS_FILE),--ask-vault-pass)

# SSH user for direct server access (logs, scripts)
# Ansible remote user is set in ansible.cfg (remote_user = ansible)
# Copy .env.dist to .env and fill in your values
SSH_USER  ?= YOUR_SSH_USER
SERVER    ?= YOUR_SERVER_IP
SSH_KEY   ?= ~/.ssh/homelab

# Deploy the full playbook
deploy:
	ansible-playbook site.yml $(VAULT_ARG) --force-handlers; true

# Deploy a single role: make deploy-role ROLE=backup
deploy-role:
	ansible-playbook site.yml $(VAULT_ARG) --tags $(ROLE) --force-handlers; true

# Install required Ansible collections
collections:
	ansible-galaxy collection install -r requirements.yml

# Edit the vault file
vault-edit:
	ansible-vault edit $(VAULT_ARG) inventories/production/group_vars/all/vault.yml

# Create the vault file (first time only)
vault-create:
	ansible-vault create inventories/production/group_vars/all/vault.yml

# Dry-run — show changes without applying
check:
	ansible-playbook site.yml $(VAULT_ARG) --check --diff

# Show diff of what would change
diff:
	ansible-playbook site.yml $(VAULT_ARG) --diff

# Check backup logs on server
logs-backup:
	ssh -i $(SSH_KEY) $(SSH_USER)@$(SERVER) "sudo journalctl -u restic-backup.service -e"

# Check immich logs on server
logs-immich:
	ssh -i $(SSH_KEY) $(SSH_USER)@$(SERVER) "sudo docker logs immich-server --tail 30"

# Check for Docker image version updates
versions:
	python3 scripts/check-versions.py

# Update all Docker image versions to latest stable
versions-update:
	python3 scripts/check-versions.py --update

# Generate an Authelia-compatible argon2id password hash
authelia-hash-password:
	ssh -i $(SSH_KEY) $(SSH_USER)@$(SERVER) -t "docker run --rm -it authelia/authelia:latest authelia crypto hash generate argon2"

# Show when manga-scheduler will next run
manga-scheduler-next:
	ssh -i $(SSH_KEY) $(SSH_USER)@$(SERVER) "systemctl list-timers manga-scheduler.timer"

# Check that MediathekArr is routing through Germany (VLAN 30 VPN)
check-mediathekarr-geo:
	python3 scripts/check-mediathekarr-geo.py

# Verify file ownership and group scheme for service accounts
check-ownership:
	ssh -i $(SSH_KEY) $(SSH_USER)@$(SERVER) "sudo bash -s" < scripts/check-ownership.sh

# Provision Uptime Kuma monitors from defaults
provision-monitors:
	ssh -i $(SSH_KEY) $(SSH_USER)@$(SERVER) "sudo python3 /opt/uptime-kuma/provision-monitors.py"

# Force stop Minecraft (proxy auto-routes to fake server)
mc-stop:
	ssh -i $(SSH_KEY) $(SSH_USER)@$(SERVER) "sudo docker compose -f /opt/minecraft/docker-compose.yml down"

# Force start Minecraft (proxy auto-routes to MC once it's up)
mc-start:
	ssh -i $(SSH_KEY) $(SSH_USER)@$(SERVER) "sudo /opt/minecraft/mc-start.sh"

# Generate a random 32-character password
generate-password:
	@python3 -c "import secrets, string; print(secrets.token_urlsafe(32))"

# Dump UniFi router config to /tmp/router-dump/
dump-router:
	ansible-playbook dump-router.yml $(VAULT_ARG)
