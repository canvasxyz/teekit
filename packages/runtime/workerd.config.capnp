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
          (
            name = "quote",
            esModule = embed "dist/bindings/quote.js"
          ),
        ],
        compatibilityDate = "2024-01-01",
        compatibilityFlags = ["nodejs_compat"],

        bindings = [
          (
            name = "QUOTE",
            module = "quote"
          ),
        ],
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
