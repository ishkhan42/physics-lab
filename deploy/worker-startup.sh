#!/bin/bash
set -euo pipefail
umask 077
export HOME=/var/lib/physics-lab/operator
mkdir -p "$HOME"
metadata=http://metadata.google.internal/computeMetadata/v1
project=$(curl --fail --silent --show-error --max-time 15 -H 'Metadata-Flavor: Google' "$metadata/project/project-id")
image=$(curl --fail --silent --show-error --max-time 15 -H 'Metadata-Flavor: Google' "$metadata/instance/attributes/physics-lab-worker-image")
auth_version=$(curl --fail --silent --show-error --max-time 15 -H 'Metadata-Flavor: Google' "$metadata/instance/attributes/physics-lab-worker-auth-version")
if [[ ! "$auth_version" =~ ^[1-9][0-9]*$ ]]; then
  printf 'Worker authentication must use a pinned secret version.\n' >&2
  exit 1
fi
if [[ ! "$image" =~ ^[a-z0-9-]+-docker\.pkg\.dev/[a-z0-9-]+/[a-z0-9-]+/[a-z0-9-]+@sha256:[a-f0-9]{64}$ ]]; then
  printf 'Worker image must be an immutable Artifact Registry digest.\n' >&2
  exit 1
fi
registry=${image%%/*}
docker-credential-gcr configure-docker --registries "$registry"
docker pull "$image"
docker tag "$image" physics-lab-harness:local

# COS has no package manager; parse credentials in the already-pulled, network-denied Node image without logging them.
read_credential() {
  docker run --rm --pull=never --log-driver=none -i --network=none --read-only \
    --cap-drop=ALL --security-opt=no-new-privileges --user=10001:10001 \
    --memory=128m --pids-limit=16 --cpus=0.25 --entrypoint=node "$image" \
    -e 'const fs=require("node:fs");const data=JSON.parse(fs.readFileSync(0,"utf8"));const value=process.argv[1]==="token"?data.access_token:Buffer.from(data.payload.data,"base64").toString("utf8");if(typeof value!=="string"||value.length<32||value.length>8192||/[\r\n]/.test(value))throw new Error("Invalid runtime credential");process.stdout.write(value);' "$1"
}
access_token=$(curl --fail --silent --show-error --max-time 15 -H 'Metadata-Flavor: Google' "$metadata/instance/service-accounts/default/token" | read_credential token)
worker_token=$(curl --fail --silent --show-error --max-time 30 -H "Authorization: Bearer $access_token" "https://secretmanager.googleapis.com/v1/projects/$project/secrets/physics-lab-worker-auth/versions/$auth_version:access" | read_credential secret)
unset access_token
printf 'WORKER_AUTH_TOKEN=%s\nPORT=8081\n' "$worker_token" > /run/physics-lab-worker.env
unset worker_token
if docker container inspect physics-lab-gateway >/dev/null 2>&1; then
  docker stop --time 30 physics-lab-gateway
  docker rm physics-lab-gateway
fi
docker run --rm --pull=never --log-driver=none --network=none --read-only \
  --cap-drop=ALL --security-opt=no-new-privileges --user=10001:10001 \
  --memory=512m --pids-limit=64 --cpus=1 --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --entrypoint=node "$image" server/worker-check.ts
docker run -d --name physics-lab-gateway --restart unless-stopped --stop-timeout 30 \
  --publish 8081:8081 --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --user=0:0 --memory=256m --pids-limit=64 --cpus=0.25 \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
  --env-file /run/physics-lab-worker.env --entrypoint=node "$image" server/worker-gateway.ts
docker exec physics-lab-gateway docker version --format '{{.Server.Version}}'
docker exec physics-lab-gateway node --input-type=module -e '
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){
    try{
      const response=await fetch("http://127.0.0.1:8081/",{signal:AbortSignal.timeout(500)});
      if(response.ok&&(await response.json()).ready===true)process.exit(0);
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error("The private worker did not become ready.");
'
printf 'Physics Lab private worker gateway started.\n'
