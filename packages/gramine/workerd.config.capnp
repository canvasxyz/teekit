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
          ( name = "worker.js", esModule = embed "/opt/kettle/worker.js" ),
          ( name = "app.js", esModule = embed "/opt/kettle/app.js" ),
          ( name = "externals.js", esModule = embed "/opt/kettle/externals.js" ),
          ( name = "hono", esModule = embed "/opt/kettle/externals.js" ),
          ( name = "hono/cors", esModule = embed "/opt/kettle/externals.js" ),
          ( name = "hono/ws", esModule = embed "/opt/kettle/externals.js" ),
          ( name = "hono/cloudflare-workers", esModule = embed "/opt/kettle/externals.js" ),
          ( name = "hono/utils/http-status", esModule = embed "/opt/kettle/externals.js" ),
          ( name = "@teekit/kettle/worker", esModule = embed "/opt/kettle/externals.js" ),
          ( name = "@teekit/tunnel", esModule = embed "/opt/kettle/externals.js" ),
          ( name = "@teekit/tunnel/samples", esModule = embed "/opt/kettle/externals.js" ),
          ( name = "@teekit/qvl", esModule = embed "/opt/kettle/externals.js" ),
          ( name = "@teekit/qvl/utils", esModule = embed "/opt/kettle/externals.js" ),
          ( name = "cbor-x", esModule = embed "/opt/kettle/externals.js" ),
          ( name = "@noble/ciphers", esModule = embed "/opt/kettle/externals.js" ),
          ( name = "@noble/ciphers/salsa", esModule = embed "/opt/kettle/externals.js" ),
          ( name = "@noble/hashes", esModule = embed "/opt/kettle/externals.js" ),
          ( name = "@noble/hashes/sha256", esModule = embed "/opt/kettle/externals.js" ),
          ( name = "@noble/hashes/sha512", esModule = embed "/opt/kettle/externals.js" ),
          ( name = "@noble/hashes/blake2b", esModule = embed "/opt/kettle/externals.js" ),
          ( name = "@noble/hashes/crypto", esModule = embed "/opt/kettle/externals.js" ),
          ( name = "@noble/hashes/sha1", esModule = embed "/opt/kettle/externals.js" ),
          ( name = "@noble/hashes/sha2", esModule = embed "/opt/kettle/externals.js" ),
          ( name = "@noble/hashes/utils", esModule = embed "/opt/kettle/externals.js" ),
          ( name = "@noble/curves", esModule = embed "/opt/kettle/externals.js" ),
          ( name = "@noble/curves/ed25519", esModule = embed "/opt/kettle/externals.js" ),
          ( name = "@scure/base", esModule = embed "/opt/kettle/externals.js" ),
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
