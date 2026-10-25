# A Coder template for Optio (docs/remote-workspaces.md): a Kubernetes pod with a home
# volume, the repo checked out, and the Optio Local daemon paired as a
# machine. Optio fills the optio_* parameters when it creates or starts a
# workspace for a piece of work; a workspace made by hand leaves them blank
# and is a plain workspace.
#
#   coder templates push optio-workspace -d . --variable namespace=coder

terraform {
  required_providers {
    coder = {
      source = "coder/coder"
    }
    kubernetes = {
      source = "hashicorp/kubernetes"
    }
  }
}

provider "coder" {}

variable "use_kubeconfig" {
  type        = bool
  description = "Use ~/.kube/config on the provisioner (false: the in-cluster service account)"
  default     = false
}

variable "namespace" {
  type        = string
  description = "The namespace workspaces are created in"
}

variable "image" {
  type        = string
  description = "The workspace image: Node.js 20+, git, curl and the agent CLI (claude and/or opencode) on PATH"
  default     = "codercom/enterprise-node:ubuntu"
}

variable "image_pull_secret" {
  type        = string
  description = "A docker-registry Secret in the namespace for pulling the image from a private registry (blank: none)"
  default     = ""
}

variable "storage_class" {
  type        = string
  description = "The home volume's storage class (blank: the cluster's default)"
  default     = ""
}

# A private CA (README.md, "A private CA"): the workspace trusts the image's
# CAs plus this one — the Coder agent's download, the Optio CLI's install,
# git, Node (the Optio daemon, Claude Code) and the rest.
variable "ca_configmap" {
  type        = string
  description = "A ConfigMap in the namespace holding the PEM of an internal CA to trust (key: ca_configmap_key). Blank: ca_pem, else the image's CAs only"
  default     = ""
}

variable "ca_configmap_key" {
  type        = string
  description = "The key in ca_configmap that holds the PEM"
  default     = "ca.crt"
}

variable "ca_pem" {
  type        = string
  description = "Or the internal CA's PEM itself: each workspace gets a ConfigMap with it"
  default     = ""
}

provider "kubernetes" {
  config_path = var.use_kubeconfig ? "~/.kube/config" : null
}

data "coder_provisioner" "me" {}
data "coder_workspace" "me" {}
data "coder_workspace_owner" "me" {}

# ── What a person picks ──────────────────────────────────────────────────────

data "coder_parameter" "cpu" {
  name         = "cpu"
  display_name = "CPU"
  description  = "Cores"
  type         = "number"
  default      = "2"
  mutable      = true
  order        = 1
  option {
    name  = "2 cores"
    value = "2"
  }
  option {
    name  = "4 cores"
    value = "4"
  }
  option {
    name  = "8 cores"
    value = "8"
  }
}

data "coder_parameter" "memory" {
  name         = "memory"
  display_name = "Memory"
  description  = "GiB"
  type         = "number"
  default      = "4"
  mutable      = true
  order        = 2
  option {
    name  = "2 GiB"
    value = "2"
  }
  option {
    name  = "4 GiB"
    value = "4"
  }
  option {
    name  = "8 GiB"
    value = "8"
  }
  option {
    name  = "16 GiB"
    value = "16"
  }
}

data "coder_parameter" "home_disk_size" {
  name         = "home_disk_size"
  display_name = "Home disk"
  description  = "GiB"
  type         = "number"
  default      = "10"
  mutable      = false
  order        = 3
  validation {
    min = 1
    max = 200
  }
}

data "coder_parameter" "repo_url" {
  name         = "repo_url"
  display_name = "Repository"
  description  = "HTTPS URL to clone into the checkout (Optio passes a Task's repository here)"
  type         = "string"
  default      = ""
  mutable      = true
  order        = 4
}

data "coder_parameter" "git_token" {
  name         = "git_token"
  display_name = "Git token"
  description  = "Clones and pushes over HTTPS with this token. Blank: the workspace's own git credentials (Coder external auth, SSH)"
  type         = "string"
  default      = ""
  mutable      = true
  order        = 5
}

# ── What Optio fills (docs/remote-workspaces.md, "Coder") ─────────────────

data "coder_parameter" "optio_server" {
  name         = "optio_server"
  display_name = "Optio server"
  description  = "Set by Optio — leave blank"
  type         = "string"
  default      = ""
  mutable      = true
  order        = 100
}

data "coder_parameter" "optio_token" {
  name         = "optio_token"
  display_name = "Optio pairing token"
  description  = "Set by Optio — leave blank. Ephemeral: the next build doesn't keep it"
  type         = "string"
  default      = ""
  mutable      = true
  ephemeral    = true
  order        = 101
}

data "coder_parameter" "optio_host_id" {
  name         = "optio_host_id"
  display_name = "Optio machine"
  description  = "Set by Optio — leave blank"
  type         = "string"
  default      = ""
  mutable      = true
  order        = 102
}

data "coder_parameter" "optio_checkout_dir" {
  name         = "optio_checkout_dir"
  display_name = "Checkout"
  description  = "Where the repo is checked out, and where Optio's agent works"
  type         = "string"
  default      = "/home/coder/repo"
  mutable      = true
  order        = 103
}

# The agent policy's deny rules (docs/agent-policy.md): Claude Code's managed
# settings and OpenCode's managed config, mounted read-only at
# /etc/claude-code and /etc/opencode, the tier a repo's own settings can't
# override. Blank = no rules.
data "coder_parameter" "optio_claude_managed_settings" {
  name         = "optio_claude_managed_settings"
  display_name = "Agent policy (Claude Code)"
  description  = "Set by Optio — leave blank"
  type         = "string"
  default      = ""
  mutable      = true
  order        = 104
}

data "coder_parameter" "optio_opencode_managed_config" {
  name         = "optio_opencode_managed_config"
  display_name = "Agent policy (OpenCode)"
  description  = "Set by Optio — leave blank"
  type         = "string"
  default      = ""
  mutable      = true
  order        = 105
}

# ── The agent ────────────────────────────────────────────────────────────────

resource "coder_agent" "main" {
  os   = "linux"
  arch = data.coder_provisioner.me.arch

  env = {
    OPTIO_SERVER         = data.coder_parameter.optio_server.value
    OPTIO_TOKEN          = data.coder_parameter.optio_token.value
    OPTIO_LOCAL_HOST_ID  = data.coder_parameter.optio_host_id.value
    OPTIO_LOCAL_HOSTNAME = data.coder_workspace.me.name
    OPTIO_CHECKOUT_DIR   = data.coder_parameter.optio_checkout_dir.value
    REPO_URL             = data.coder_parameter.repo_url.value
    GIT_TOKEN            = data.coder_parameter.git_token.value
  }

  startup_script = <<-EOT
    set -eu
    CHECKOUT="$${OPTIO_CHECKOUT_DIR:-/home/coder/repo}"

    # Git over HTTPS with the token, read from the environment when git asks
    # (nothing is written to disk). Without one, git uses the workspace's own
    # credentials.
    if [ -n "$${GIT_TOKEN:-}" ] && [ -n "$${REPO_URL:-}" ]; then
      host=$(printf '%s' "$REPO_URL" | sed -E 's#^https?://([^/]+).*#\1#')
      git config --global "credential.https://$host.helper" \
        '!f() { echo username=oauth2; echo "password=$GIT_TOKEN"; }; f'
    fi

    # The checkout: cloned once, kept on the home volume across restarts.
    if [ -n "$${REPO_URL:-}" ] && [ ! -d "$CHECKOUT/.git" ]; then
      mkdir -p "$(dirname "$CHECKOUT")"
      git clone "$REPO_URL" "$CHECKOUT"
    fi
    mkdir -p "$CHECKOUT"

    # Optio pairs this workspace as a machine (the parameters are set by
    # Optio; blank when the workspace was made by hand).
    if [ -n "$${OPTIO_TOKEN:-}" ]; then
      curl -fsSL "$OPTIO_SERVER/api/cli/install.sh" | sh   # ~/.optio/bin/optio (Node 20+)
      nohup "$HOME/.optio/bin/optio" --server "$OPTIO_SERVER" --api-key "$OPTIO_TOKEN" \
        local up --no-remote-dirs --dir "$CHECKOUT" --name "$OPTIO_LOCAL_HOSTNAME" \
        > /tmp/optio-local.log 2>&1 &
    fi
  EOT

  metadata {
    display_name = "Optio daemon"
    key          = "optio"
    script       = "pgrep -f 'optio.js.*local up' >/dev/null && echo paired || echo -"
    interval     = 30
    timeout      = 5
  }
}

# ── The pod ──────────────────────────────────────────────────────────────────

locals {
  name = "coder-${lower(data.coder_workspace_owner.me.name)}-${lower(data.coder_workspace.me.name)}"
  labels = {
    "app.kubernetes.io/name"     = "coder-workspace"
    "app.kubernetes.io/instance" = local.name
    "app.kubernetes.io/part-of"  = "coder"
    "com.coder.workspace.id"     = data.coder_workspace.me.id
    "com.coder.workspace.name"   = data.coder_workspace.me.name
    "com.coder.user.id"          = data.coder_workspace_owner.me.id
    "com.coder.user.username"    = data.coder_workspace_owner.me.name
  }

  # The internal CA: the ConfigMap named, else one made from ca_pem, else none.
  ca_configmap = var.ca_configmap != "" ? var.ca_configmap : (var.ca_pem != "" ? "${local.name}-ca" : "")
  ca_key       = var.ca_configmap != "" ? var.ca_configmap_key : "ca.crt"
  # The ca-bundle init container writes the image's CAs plus the internal one
  # (bundle.crt) and the internal one alone (internal.crt) here, as Optio's own
  # agent pods have it; these variables point every TLS client at them.
  ca_dir = "/etc/optio/ca"
  ca_env = local.ca_configmap == "" ? {} : {
    SSL_CERT_FILE      = "${local.ca_dir}/bundle.crt" # OpenSSL, Go (the Coder agent), Python
    CURL_CA_BUNDLE     = "${local.ca_dir}/bundle.crt" # curl (the agent's download, install.sh)
    GIT_SSL_CAINFO     = "${local.ca_dir}/bundle.crt"
    REQUESTS_CA_BUNDLE = "${local.ca_dir}/bundle.crt"
    PIP_CERT           = "${local.ca_dir}/bundle.crt"
    CARGO_HTTP_CAINFO  = "${local.ca_dir}/bundle.crt"
    AWS_CA_BUNDLE      = "${local.ca_dir}/bundle.crt"
    # Node (the Optio CLI and daemon, Claude Code, npm) adds it to its own roots.
    NODE_EXTRA_CA_CERTS = "${local.ca_dir}/internal.crt"
  }
}

resource "kubernetes_config_map_v1" "ca" {
  count = var.ca_configmap == "" && var.ca_pem != "" ? 1 : 0
  metadata {
    name      = "${local.name}-ca"
    namespace = var.namespace
    labels    = local.labels
  }
  data = {
    "ca.crt" = var.ca_pem
  }
}

# The agent policy's files (the two parameters above), one ConfigMap for both.
locals {
  claude_policy   = data.coder_parameter.optio_claude_managed_settings.value
  opencode_policy = data.coder_parameter.optio_opencode_managed_config.value
}

resource "kubernetes_config_map_v1" "agent_policy" {
  count = local.claude_policy != "" || local.opencode_policy != "" ? 1 : 0
  metadata {
    name      = "${local.name}-agent-policy"
    namespace = var.namespace
    labels    = local.labels
  }
  data = merge(
    local.claude_policy != "" ? { "managed-settings.json" = local.claude_policy } : {},
    local.opencode_policy != "" ? { "opencode.json" = local.opencode_policy } : {},
  )
}

resource "kubernetes_persistent_volume_claim" "home" {
  metadata {
    name      = "${local.name}-home"
    namespace = var.namespace
    labels    = local.labels
  }
  wait_until_bound = false
  spec {
    access_modes       = ["ReadWriteOnce"]
    storage_class_name = var.storage_class == "" ? null : var.storage_class
    resources {
      requests = {
        storage = "${data.coder_parameter.home_disk_size.value}Gi"
      }
    }
  }
  lifecycle {
    ignore_changes = all
  }
}

resource "kubernetes_deployment" "main" {
  count            = data.coder_workspace.me.start_count
  wait_for_rollout = false
  depends_on = [
    kubernetes_persistent_volume_claim.home,
    kubernetes_config_map_v1.ca,
    kubernetes_config_map_v1.agent_policy,
  ]

  metadata {
    name      = local.name
    namespace = var.namespace
    labels    = local.labels
  }

  spec {
    replicas = 1
    selector {
      match_labels = {
        "app.kubernetes.io/instance" = local.name
      }
    }
    strategy {
      type = "Recreate"
    }
    template {
      metadata {
        labels = local.labels
      }
      spec {
        security_context {
          run_as_user     = 1000
          fs_group        = 1000
          run_as_non_root = true
        }
        dynamic "image_pull_secrets" {
          for_each = var.image_pull_secret == "" ? [] : [1]
          content {
            name = var.image_pull_secret
          }
        }
        # The image's CA bundle with the internal CA appended (public CAs keep
        # working). Debian / Ubuntu / Alpine, RHEL, or none: the internal CA alone.
        dynamic "init_container" {
          for_each = local.ca_configmap == "" ? [] : [1]
          content {
            name              = "ca-bundle"
            image             = var.image
            image_pull_policy = "IfNotPresent"
            command = ["sh", "-c", <<-EOT
              for f in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt; do
                if [ -s "$f" ]; then cat "$f"; echo; break; fi
              done > /ca/bundle.crt
              cat /src/ca.crt >> /ca/bundle.crt
              cp /src/ca.crt /ca/internal.crt
            EOT
            ]
            security_context {
              run_as_user = 1000
            }
            volume_mount {
              mount_path = "/src"
              name       = "ca-source"
              read_only  = true
            }
            volume_mount {
              mount_path = "/ca"
              name       = "ca"
            }
          }
        }
        container {
          name              = "dev"
          image             = var.image
          image_pull_policy = "IfNotPresent"
          command           = ["sh", "-c", coder_agent.main.init_script]
          security_context {
            run_as_user = 1000
          }
          env {
            name  = "CODER_AGENT_TOKEN"
            value = coder_agent.main.token
          }
          dynamic "env" {
            for_each = local.ca_env
            content {
              name  = env.key
              value = env.value
            }
          }
          resources {
            requests = {
              cpu    = "250m"
              memory = "512Mi"
            }
            limits = {
              cpu    = data.coder_parameter.cpu.value
              memory = "${data.coder_parameter.memory.value}Gi"
            }
          }
          volume_mount {
            mount_path = "/home/coder"
            name       = "home"
          }
          dynamic "volume_mount" {
            for_each = local.ca_configmap == "" ? [] : [1]
            content {
              mount_path = local.ca_dir
              name       = "ca"
              read_only  = true
            }
          }
          # The agent policy, read-only: the agent can't change its own rules.
          dynamic "volume_mount" {
            for_each = local.claude_policy == "" ? [] : [1]
            content {
              mount_path = "/etc/claude-code"
              name       = "agent-policy-claude"
              read_only  = true
            }
          }
          dynamic "volume_mount" {
            for_each = local.opencode_policy == "" ? [] : [1]
            content {
              mount_path = "/etc/opencode"
              name       = "agent-policy-opencode"
              read_only  = true
            }
          }
        }
        volume {
          name = "home"
          persistent_volume_claim {
            claim_name = kubernetes_persistent_volume_claim.home.metadata[0].name
          }
        }
        dynamic "volume" {
          for_each = local.ca_configmap == "" ? [] : [1]
          content {
            name = "ca-source"
            config_map {
              name = local.ca_configmap
              items {
                key  = local.ca_key
                path = "ca.crt"
              }
            }
          }
        }
        dynamic "volume" {
          for_each = local.ca_configmap == "" ? [] : [1]
          content {
            name = "ca"
            empty_dir {}
          }
        }
        dynamic "volume" {
          for_each = local.claude_policy == "" ? [] : [1]
          content {
            name = "agent-policy-claude"
            config_map {
              name = "${local.name}-agent-policy"
              items {
                key  = "managed-settings.json"
                path = "managed-settings.json"
              }
            }
          }
        }
        dynamic "volume" {
          for_each = local.opencode_policy == "" ? [] : [1]
          content {
            name = "agent-policy-opencode"
            config_map {
              name = "${local.name}-agent-policy"
              items {
                key  = "opencode.json"
                path = "opencode.json"
              }
            }
          }
        }
      }
    }
  }
}
