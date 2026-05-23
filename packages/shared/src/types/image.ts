export const PRESET_IMAGES = {
  base: {
    tag: "optio-base:latest",
    label: "Base",
    description: "Git, Node.js, Python 3, gh CLI, glab CLI, Claude Code. Minimal footprint.",
    languages: [],
  },
  node: {
    tag: "optio-node:latest",
    label: "Node.js",
    description: "Base + pnpm, yarn, bun, native build tools.",
    languages: ["javascript", "typescript"],
  },
  python: {
    tag: "optio-python:latest",
    label: "Python",
    description: "Base + pip, uv, poetry, venv support.",
    languages: ["python"],
  },
  go: {
    tag: "optio-go:latest",
    label: "Go",
    description: "Base + Go 1.23, protoc, gopls.",
    languages: ["go"],
  },
  rust: {
    tag: "optio-rust:latest",
    label: "Rust",
    description: "Base + rustup, cargo, cargo-nextest.",
    languages: ["rust"],
  },
  ruby: {
    tag: "optio-ruby:latest",
    label: "Ruby",
    description: "Base + rbenv, Ruby 3.3, bundler, rake, rubocop, solargraph.",
    languages: ["ruby"],
  },
  dart: {
    tag: "optio-dart:latest",
    label: "Dart",
    description: "Base + Dart SDK, dart_style.",
    languages: ["dart"],
  },
  full: {
    tag: "optio-full:latest",
    label: "Full",
    description: "Everything: Node.js, Python, Go, Rust, Docker, Postgres/Redis clients.",
    languages: ["javascript", "typescript", "python", "go", "rust"],
  },
  dind: {
    tag: "optio-dind:latest",
    label: "Docker-in-Docker",
    description:
      "Base + Docker daemon & CLI for repos that need docker build/run. Requires DinD enabled.",
    languages: [],
  },
} as const;

export type PresetImageId = keyof typeof PRESET_IMAGES;

export interface RepoImageConfig {
  /** Use a preset image */
  preset?: PresetImageId;
  /** OR use a custom image tag */
  customImage?: string;
  /** OR build from a Dockerfile in the repo */
  dockerfilePath?: string;
  /** Extra apt packages to install at pod startup */
  extraPackages?: string[];
}
