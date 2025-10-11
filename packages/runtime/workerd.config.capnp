# Workerd configuration for teekit runtime

using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (
      name = "main",
      worker = (
        modules = [
          (
            name = "server.js",
            esModule = embed "dist/server.js"
          ),
        ],
        compatibilityDate = "2024-01-01",
        compatibilityFlags = ["nodejs_compat"],

        bindings = [],
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
