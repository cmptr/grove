#!/usr/bin/env bash
# provision-aws.sh — Provision Grove on AWS g4dn.xlarge (T4 GPU, spot)
# Idempotent: safe to re-run. Finds existing resources by Project=grove tag.
# Usage: ./scripts/provision-aws.sh [--dry-run]
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
AWS_ACCOUNT="420265757862"
REGION="us-west-2"
INSTANCE_TYPE="g4dn.xlarge"
SPOT_MAX_PRICE="0.20"          # on-demand is $0.526/hr; T4 spot ~$0.10–0.16/hr
KEY_NAME="grove-key"
KEY_PATH="$HOME/.ssh/grove-aws.pem"
TAG_KEY="Project"
TAG_VAL="grove"
DOMAIN="api.grove.md"
GROVE_REPO="git@github.com:jmilinovich/grove.git"
VAULT_REPO="git@github.com:jmilinovich/vault-life.git"
TEI_IMAGE="ghcr.io/huggingface/text-embeddings-inference:cuda-1.9"
TEI_MODEL="Qwen/Qwen3-Embedding-0.6B"

# Ubuntu 24.04 LTS (Noble) — deep-learning AMI with NVIDIA drivers in us-west-2
# AWS Deep Learning Base AMI (Ubuntu 24.04) — GPU-ready, updated quarterly
# Find latest: aws ec2 describe-images --owners amazon --filters ...
AMI_ID="ami-0b0efc9bee98cf2eb"   # Deep Learning Base Ubuntu 24.04 (NVIDIA drivers pre-installed)

AWS="aws --region $REGION"
DRY="${1:-}"

tag_filter='Name=tag:Project,Values=grove'

log()  { echo "==> $*"; }
warn() { echo "!!! $*" >&2; }

# ── 1. SSH Key Pair ───────────────────────────────────────────────────────────
log "Checking SSH key pair '$KEY_NAME'..."
existing_key=$($AWS ec2 describe-key-pairs \
  --filters "Name=key-name,Values=$KEY_NAME" \
  --query 'KeyPairs[0].KeyName' --output text 2>/dev/null || true)

if [[ "$existing_key" == "$KEY_NAME" ]]; then
  log "Key pair '$KEY_NAME' already exists."
else
  log "Creating key pair '$KEY_NAME' → $KEY_PATH"
  $AWS ec2 create-key-pair \
    --key-name "$KEY_NAME" \
    --query 'KeyMaterial' --output text > "$KEY_PATH"
  chmod 600 "$KEY_PATH"
  log "Saved private key to $KEY_PATH"
fi

# ── 2. VPC ────────────────────────────────────────────────────────────────────
log "Checking for existing Grove VPC..."
VPC_ID=$($AWS ec2 describe-vpcs \
  --filters "$tag_filter" \
  --query 'Vpcs[0].VpcId' --output text)

if [[ "$VPC_ID" == "None" || -z "$VPC_ID" ]]; then
  log "Creating VPC..."
  VPC_ID=$($AWS ec2 create-vpc --cidr-block 10.42.0.0/16 \
    --query 'Vpc.VpcId' --output text)
  $AWS ec2 create-tags --resources "$VPC_ID" \
    --tags "Key=$TAG_KEY,Value=$TAG_VAL" "Key=Name,Value=grove-vpc"
  $AWS ec2 modify-vpc-attribute --vpc-id "$VPC_ID" \
    --enable-dns-hostnames '{"Value":true}'
  log "Created VPC: $VPC_ID"
else
  log "Reusing VPC: $VPC_ID"
fi

# ── 3. Internet Gateway ───────────────────────────────────────────────────────
log "Checking for existing Internet Gateway..."
IGW_ID=$($AWS ec2 describe-internet-gateways \
  --filters "$tag_filter" \
  --query 'InternetGateways[0].InternetGatewayId' --output text)

if [[ "$IGW_ID" == "None" || -z "$IGW_ID" ]]; then
  log "Creating Internet Gateway..."
  IGW_ID=$($AWS ec2 create-internet-gateway \
    --query 'InternetGateway.InternetGatewayId' --output text)
  $AWS ec2 create-tags --resources "$IGW_ID" \
    --tags "Key=$TAG_KEY,Value=$TAG_VAL" "Key=Name,Value=grove-igw"
  $AWS ec2 attach-internet-gateway --internet-gateway-id "$IGW_ID" --vpc-id "$VPC_ID"
  log "Created and attached IGW: $IGW_ID"
else
  log "Reusing IGW: $IGW_ID"
fi

# ── 4. Subnet ─────────────────────────────────────────────────────────────────
log "Checking for existing subnet..."
SUBNET_ID=$($AWS ec2 describe-subnets \
  --filters "$tag_filter" "Name=vpc-id,Values=$VPC_ID" \
  --query 'Subnets[0].SubnetId' --output text)

if [[ "$SUBNET_ID" == "None" || -z "$SUBNET_ID" ]]; then
  # Pick first AZ in region
  AZ=$($AWS ec2 describe-availability-zones \
    --query 'AvailabilityZones[0].ZoneName' --output text)
  log "Creating subnet in $AZ..."
  SUBNET_ID=$($AWS ec2 create-subnet \
    --vpc-id "$VPC_ID" --cidr-block 10.42.1.0/24 \
    --availability-zone "$AZ" \
    --query 'Subnet.SubnetId' --output text)
  $AWS ec2 create-tags --resources "$SUBNET_ID" \
    --tags "Key=$TAG_KEY,Value=$TAG_VAL" "Key=Name,Value=grove-subnet"
  $AWS ec2 modify-subnet-attribute --subnet-id "$SUBNET_ID" \
    --map-public-ip-on-launch
  log "Created subnet: $SUBNET_ID"
else
  log "Reusing subnet: $SUBNET_ID"
fi

# ── 5. Route Table ────────────────────────────────────────────────────────────
log "Checking route table..."
RTB_ID=$($AWS ec2 describe-route-tables \
  --filters "$tag_filter" "Name=vpc-id,Values=$VPC_ID" \
  --query 'RouteTables[0].RouteTableId' --output text)

if [[ "$RTB_ID" == "None" || -z "$RTB_ID" ]]; then
  log "Creating route table..."
  RTB_ID=$($AWS ec2 create-route-table --vpc-id "$VPC_ID" \
    --query 'RouteTable.RouteTableId' --output text)
  $AWS ec2 create-tags --resources "$RTB_ID" \
    --tags "Key=$TAG_KEY,Value=$TAG_VAL" "Key=Name,Value=grove-rtb"
  $AWS ec2 create-route --route-table-id "$RTB_ID" \
    --destination-cidr-block 0.0.0.0/0 --gateway-id "$IGW_ID"
  $AWS ec2 associate-route-table --route-table-id "$RTB_ID" --subnet-id "$SUBNET_ID"
  log "Created route table: $RTB_ID"
else
  log "Reusing route table: $RTB_ID"
fi

# ── 6. Security Group ─────────────────────────────────────────────────────────
log "Checking for existing security group..."
SG_ID=$($AWS ec2 describe-security-groups \
  --filters "$tag_filter" "Name=vpc-id,Values=$VPC_ID" \
  --query 'SecurityGroups[0].GroupId' --output text)

if [[ "$SG_ID" == "None" || -z "$SG_ID" ]]; then
  log "Creating security group..."
  SG_ID=$($AWS ec2 create-security-group \
    --group-name grove-sg \
    --description "Grove security group" \
    --vpc-id "$VPC_ID" \
    --query 'GroupId' --output text)
  $AWS ec2 create-tags --resources "$SG_ID" \
    --tags "Key=$TAG_KEY,Value=$TAG_VAL" "Key=Name,Value=grove-sg"
  $AWS ec2 authorize-security-group-ingress --group-id "$SG_ID" \
    --ip-permissions \
    'IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=0.0.0.0/0}]' \
    'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0}]' \
    'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]'
  log "Created security group: $SG_ID (ports 22, 80, 443 open)"
else
  log "Reusing security group: $SG_ID"
fi

# ── 7. Check for running instance ─────────────────────────────────────────────
log "Checking for existing Grove instance..."
INSTANCE_ID=$($AWS ec2 describe-instances \
  --filters "$tag_filter" "Name=instance-state-name,Values=running,stopped,pending" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)

if [[ "$INSTANCE_ID" != "None" && -n "$INSTANCE_ID" ]]; then
  log "Found existing instance: $INSTANCE_ID"
  INSTANCE_STATE=$($AWS ec2 describe-instances \
    --instance-ids "$INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].State.Name' --output text)
  log "Instance state: $INSTANCE_STATE"
else
  # ── 8. Launch Spot Instance (using run-instances with spot market options) ───
  log "Launching g4dn.xlarge spot instance..."

  INSTANCE_ID=$($AWS ec2 run-instances \
    --image-id "$AMI_ID" \
    --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" \
    --security-group-ids "$SG_ID" \
    --subnet-id "$SUBNET_ID" \
    --instance-market-options '{"MarketType":"spot","SpotOptions":{"MaxPrice":"'"$SPOT_MAX_PRICE"'","SpotInstanceType":"persistent","InstanceInterruptionBehavior":"stop"}}' \
    --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":100,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
    --tag-specifications \
      "ResourceType=instance,Tags=[{Key=$TAG_KEY,Value=$TAG_VAL},{Key=Name,Value=grove-server}]" \
      "ResourceType=volume,Tags=[{Key=$TAG_KEY,Value=$TAG_VAL}]" \
    --query 'Instances[0].InstanceId' --output text)

  log "Instance launched: $INSTANCE_ID"
fi

# ── 9. Wait for instance running ──────────────────────────────────────────────
log "Waiting for instance $INSTANCE_ID to be running..."
$AWS ec2 wait instance-running --instance-ids "$INSTANCE_ID"
log "Instance is running."

# Ensure Name tag is set
$AWS ec2 create-tags --resources "$INSTANCE_ID" \
  --tags "Key=Name,Value=grove-server" "Key=$TAG_KEY,Value=$TAG_VAL" 2>/dev/null || true

PUBLIC_IP=$($AWS ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)

log "Public IP: $PUBLIC_IP"

# ── 10. Wait for SSH ──────────────────────────────────────────────────────────
log "Waiting for SSH to be available on $PUBLIC_IP..."
for i in $(seq 1 30); do
  if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 \
       -i "$KEY_PATH" "ubuntu@$PUBLIC_IP" "echo ok" 2>/dev/null; then
    log "SSH is up."
    break
  fi
  echo "  ... waiting for SSH ($i/30)"
  sleep 10
done

# ── 11. Remote setup ──────────────────────────────────────────────────────────
log "Running setup on $PUBLIC_IP..."

ssh -o StrictHostKeyChecking=no -i "$KEY_PATH" "ubuntu@$PUBLIC_IP" \
  sudo bash -s "$DOMAIN" "$GROVE_REPO" "$VAULT_REPO" "$TEI_IMAGE" "$TEI_MODEL" \
  << 'REMOTE_SETUP'
#!/usr/bin/env bash
set -euo pipefail

DOMAIN="$1"
GROVE_REPO="$2"
VAULT_REPO="$3"
TEI_IMAGE="$4"
TEI_MODEL="$5"

export DEBIAN_FRONTEND=noninteractive
export HOME=/root

log() { echo "==> [remote] $*"; }

# ── System packages ───────────────────────────────────────────────────────────
log "Installing system packages..."
apt-get update -qq
apt-get install -y -qq \
  git curl wget unzip nginx certbot python3-certbot-nginx \
  build-essential ca-certificates gnupg lsb-release

# ── Docker ────────────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  log "Installing Docker..."
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
  log "Docker installed."
else
  log "Docker already installed."
fi

# ── NVIDIA Container Toolkit (for GPU in Docker) ──────────────────────────────
# Note: NVIDIA kernel drivers come pre-installed on the Deep Learning Base AMI
if ! dpkg -l nvidia-container-toolkit &>/dev/null; then
  log "Installing NVIDIA Container Toolkit..."
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
    | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    > /etc/apt/sources.list.d/nvidia-container-toolkit.list
  apt-get update -qq
  apt-get install -y -qq nvidia-container-toolkit
  nvidia-ctk runtime configure --runtime=docker
  systemctl restart docker
  log "NVIDIA Container Toolkit installed."
else
  log "NVIDIA Container Toolkit already installed."
fi

# ── Node.js 22 ────────────────────────────────────────────────────────────────
if ! node --version 2>/dev/null | grep -q '^v22'; then
  log "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
  log "Node.js $(node --version) installed."
else
  log "Node.js 22 already installed."
fi

# ── PM2 ───────────────────────────────────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  log "Installing PM2..."
  npm install -g pm2
  pm2 startup systemd -u root --hp /root | tail -1 | bash
fi

# ── QMD ───────────────────────────────────────────────────────────────────────
if ! command -v qmd &>/dev/null; then
  log "Installing QMD..."
  npm install -g @tobilu/qmd
fi

# ── Clone/update Grove ────────────────────────────────────────────────────────
if [[ ! -d /root/grove ]]; then
  log "Cloning grove repo..."
  # Use HTTPS fallback if SSH keys not configured
  git clone "$GROVE_REPO" /root/grove || \
    git clone "https://github.com/jmilinovich/grove.git" /root/grove
else
  log "Updating grove repo..."
  git -C /root/grove pull --ff-only || true
fi
cd /root/grove && npm install && npm run build 2>/dev/null || true

# ── Clone/update vault ────────────────────────────────────────────────────────
if [[ ! -d /root/life ]]; then
  log "Cloning vault..."
  git clone "$VAULT_REPO" /root/life || \
    git clone "https://github.com/jmilinovich/vault-life.git" /root/life
else
  log "Updating vault..."
  git -C /root/life pull --ff-only || true
fi

# ── TEI (Text Embeddings Inference) ──────────────────────────────────────────
log "Setting up TEI container..."
# Pull image
docker pull "$TEI_IMAGE"

# Stop existing container if running
docker rm -f grove-tei 2>/dev/null || true

# Launch TEI on port 8090 with GPU
docker run -d \
  --name grove-tei \
  --restart unless-stopped \
  --gpus all \
  -p 8090:80 \
  -v /root/.cache/huggingface:/root/.cache/huggingface \
  "$TEI_IMAGE" \
  --model-id "$TEI_MODEL" \
  --port 80 \
  --max-client-batch-size 512

log "TEI started on port 8090 with model $TEI_MODEL"

# Wait for TEI to be healthy
log "Waiting for TEI to become healthy (up to 5 min)..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:8090/health &>/dev/null; then
    log "TEI is healthy."
    break
  fi
  echo "  ... waiting ($i/30)"
  sleep 10
done

# ── Nginx config ──────────────────────────────────────────────────────────────
log "Configuring nginx..."
cat > /etc/nginx/sites-available/grove << NGINX
server {
    listen 80;
    server_name $DOMAIN;

    # Allow large payloads (embedding batches)
    client_max_body_size 64m;

    location / {
        proxy_pass http://localhost:8420;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/grove /etc/nginx/sites-enabled/grove
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# ── Certbot TLS ───────────────────────────────────────────────────────────────
log "Checking TLS certificate..."
if [[ ! -d /etc/letsencrypt/live/$DOMAIN ]]; then
  log "Obtaining TLS certificate for $DOMAIN..."
  certbot --nginx -d "$DOMAIN" \
    --non-interactive --agree-tos \
    --email "jm@grove.md" \
    --redirect || log "WARNING: certbot failed — DNS may not be pointed yet. Run certbot manually after updating DNS."
else
  log "TLS certificate already exists."
fi

# ── PM2 processes ─────────────────────────────────────────────────────────────
log "Configuring PM2 processes..."

# grove-proxy
if pm2 describe grove-proxy &>/dev/null; then
  pm2 restart grove-proxy
else
  pm2 start /root/grove/dist/proxy.js --name grove-proxy \
    --cwd /root/grove \
    -- 2>/dev/null || \
  pm2 start "npm run proxy" --name grove-proxy --cwd /root/grove
fi

# qmd-mcp (MCP server on :8181)
if pm2 describe qmd-mcp &>/dev/null; then
  pm2 restart qmd-mcp
else
  pm2 start "qmd mcp --vault /root/life --port 8181" \
    --name qmd-mcp --interpreter none
fi

# qmd-server (BM25 search on :8177)
if pm2 describe qmd-server &>/dev/null; then
  pm2 restart qmd-server
else
  pm2 start "qmd server --vault /root/life --port 8177" \
    --name qmd-server --interpreter none
fi

pm2 save
log "PM2 processes configured."
pm2 list

# ── Cron: vault sync every 5 min ─────────────────────────────────────────────
log "Setting up vault sync cron..."
CRON_LINE="*/5 * * * * git -C /root/life pull --ff-only --quiet 2>&1 | logger -t grove-vault-sync"
(crontab -l 2>/dev/null | grep -v 'grove-vault-sync' ; echo "$CRON_LINE") | crontab -
log "Cron job set: vault sync every 5 minutes."

log ""
log "Setup complete!"
REMOTE_SETUP

# ── 12. Summary ───────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  Grove provisioning complete"
echo "════════════════════════════════════════════════════════════════════"
echo ""
echo "  Instance ID : $INSTANCE_ID"
echo "  Public IP   : $PUBLIC_IP"
echo "  SSH         : ssh -i $KEY_PATH ubuntu@$PUBLIC_IP"
echo ""
echo "  ── DNS Update Required (Cloudflare) ─────────────────────────────"
echo ""
echo "  Update the A record for $DOMAIN:"
echo ""
echo "    Type  : A"
echo "    Name  : grove"
echo "    Value : $PUBLIC_IP"
echo "    TTL   : Auto (or 60s)"
echo "    Proxy : DNS only (grey cloud) initially, then enable after TLS"
echo ""
echo "  Steps:"
echo "  1. Log in to dash.cloudflare.com"
echo "  2. Select the grove.md zone"
echo "  3. Go to DNS → Records"
echo "  4. Update or add the A record above"
echo "  5. Wait ~60s for propagation"
echo "  6. Run certbot on the instance (or re-run this script):"
echo "     ssh -i $KEY_PATH ubuntu@$PUBLIC_IP"
echo "     sudo certbot --nginx -d $DOMAIN --non-interactive --agree-tos \\"
echo "       --email jm@grove.md --redirect"
echo ""
echo "  ── Spot Instance Notes ──────────────────────────────────────────"
echo "  Type    : Persistent spot (instance stopped on interruption)"
echo "  Max bid : \$$SPOT_MAX_PRICE/hr (on-demand: \$0.526/hr)"
echo "  If interrupted, the instance will stop and restart automatically"
echo "  when capacity is available again."
echo ""
echo "  ── Verify services ─────────────────────────────────────────────"
echo "  ssh -i $KEY_PATH ubuntu@$PUBLIC_IP pm2 list"
echo "  curl http://$PUBLIC_IP/health       # grove proxy"
echo "  curl http://$PUBLIC_IP:8090/health  # TEI embeddings"
echo ""
echo "════════════════════════════════════════════════════════════════════"
