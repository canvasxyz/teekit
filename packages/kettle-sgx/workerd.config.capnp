using Workerd = import "/workerd/workerd.capnp";

# Static workerd configuration for Gramine SGX enclave.
# This config is measured into MRENCLAVE for attestation.
# The kettle launcher may override socket bindings at runtime.

const config :Workerd.Config = (
  v8Flags = ["--abort-on-uncaught-exception"],
  services = [
    (
      name = "main",
      worker = (
        modules = [
          ( name = "worker.js", esModule = embed "worker.js" ),
          ( name = "app.js", esModule = embed "app.js" ),
          ( name = "externals.js", esModule = embed "externals.js" ),
          ( name = "hono", esModule = embed "externals.js" ),
          ( name = "hono/cors", esModule = embed "externals.js" ),
          ( name = "hono/ws", esModule = embed "externals.js" ),
          ( name = "hono/cloudflare-workers", esModule = embed "externals.js" ),
          ( name = "hono/utils/http-status", esModule = embed "externals.js" ),
          ( name = "@teekit/kettle/worker", esModule = embed "externals.js" ),
          ( name = "@teekit/tunnel", esModule = embed "externals.js" ),
          ( name = "@teekit/tunnel/samples", esModule = embed "externals.js" ),
          ( name = "@teekit/qvl", esModule = embed "externals.js" ),
          ( name = "@teekit/qvl/utils", esModule = embed "externals.js" ),
          ( name = "cbor-x", esModule = embed "externals.js" ),
          ( name = "@noble/ciphers", esModule = embed "externals.js" ),
          ( name = "@noble/ciphers/salsa", esModule = embed "externals.js" ),
          ( name = "@noble/hashes", esModule = embed "externals.js" ),
          ( name = "@noble/hashes/sha256", esModule = embed "externals.js" ),
          ( name = "@noble/hashes/sha512", esModule = embed "externals.js" ),
          ( name = "@noble/hashes/blake2b", esModule = embed "externals.js" ),
          ( name = "@noble/hashes/crypto", esModule = embed "externals.js" ),
          ( name = "@noble/hashes/sha1", esModule = embed "externals.js" ),
          ( name = "@noble/hashes/sha2", esModule = embed "externals.js" ),
          ( name = "@noble/hashes/utils", esModule = embed "externals.js" ),
          ( name = "@noble/curves", esModule = embed "externals.js" ),
          ( name = "@noble/curves/ed25519", esModule = embed "externals.js" ),
          ( name = "@scure/base", esModule = embed "externals.js" ),
        ],
        compatibilityDate = "2025-11-05",
        compatibilityFlags = ["nodejs_compat", "new_module_registry"],
        bindings = [
          ( name = "HONO_DO", durableObjectNamespace = "HonoDurableObject" ),
          ( name = "QUOTE_SERVICE", service = "quote" ),
          ( name = "STATIC_FILES", service = "static-files" ),
        ],
        durableObjectNamespaces = [
          ( className = "HonoDurableObject", uniqueKey = "hono-durable-object-0", enableSql = true ),
        ],
        durableObjectStorage = (localDisk = "do-storage"),
      ),
    ),
    ( name = "quote", external = ( address = "127.0.0.1:3333" ) ),
    ( name = "static-files", disk = "/opt/kettle/static" ),
    ( name = "do-storage", disk = ( path = "/var/lib/kettle/do-storage", writable = true ) ),
  ],
  sockets = [
    ( name = "http", address = "*:3001", http = (), service = "main" ),
  ]
);
