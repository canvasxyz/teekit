# Workerd configuration for teekit runtime

using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (
      name = "main",
      worker = (
        modules = [
          (
            name = "worker.js",
            esModule = embed "dist/worker.js"
          ),
        ],
        compatibilityDate = "2024-01-01",
        compatibilityFlags = ["nodejs_compat"],

        # No QUOTE module binding in base config; server falls back to sample quote
      )
    ),
  ],

  sockets = [
    (
      name = "http",
      address = "*:3001",
      http = (),
      service = "main"
    ),
  ]
);
