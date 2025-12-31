// SGX Entrypoint for Gramine
//
// This binary serves as the entrypoint for Gramine SGX enclaves. It:
// 1. Starts an HTTP server for SGX quote generation (attestation)
// 2. Launches workerd as a child process
// 3. Forwards signals to workerd for graceful shutdown
//
// The quote service uses Gramine's /dev/attestation pseudo-filesystem
// to generate DCAP quotes for remote attestation.
//
// Usage:
//   sgx-entrypoint [--port PORT] -- workerd_args...
//
// Environment:
//   QUOTE_SERVICE_PORT - Port for the quote service (default: 3333)

package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"
)

const (
	defaultPort                = 3333
	attestationUserReportData  = "/dev/attestation/user_report_data"
	attestationQuote           = "/dev/attestation/quote"
	attestationType            = "/dev/attestation/attestation_type"
	rateLimitWindowMs          = 60_000  // 1 minute window
	rateLimitMaxRequests       = 10      // max 10 quote requests per minute per IP
	rateLimitCleanupIntervalMs = 300_000 // cleanup old entries every 5 minutes

	// Default workerd binary path
	defaultWorkerdPath = "/usr/local/bin/workerd"
)

type rateLimitEntry struct {
	count       int
	windowStart int64
}

type quoteService struct {
	rateLimitMap map[string]*rateLimitEntry
	mu           sync.RWMutex
}

func newQuoteService() *quoteService {
	qs := &quoteService{
		rateLimitMap: make(map[string]*rateLimitEntry),
	}

	// Start periodic cleanup
	go func() {
		ticker := time.NewTicker(rateLimitCleanupIntervalMs * time.Millisecond)
		defer ticker.Stop()
		for range ticker.C {
			qs.cleanupRateLimitEntries()
		}
	}()

	return qs
}

// Check if a request should be rate limited
func (qs *quoteService) isRateLimited(ip string) bool {
	qs.mu.Lock()
	defer qs.mu.Unlock()

	now := time.Now().UnixMilli()
	entry, exists := qs.rateLimitMap[ip]

	if !exists || now-entry.windowStart > rateLimitWindowMs {
		// New window
		qs.rateLimitMap[ip] = &rateLimitEntry{
			count:       1,
			windowStart: now,
		}
		return false
	}

	if entry.count >= rateLimitMaxRequests {
		return true
	}

	entry.count++
	return false
}

// Clean up expired rate limit entries
func (qs *quoteService) cleanupRateLimitEntries() {
	qs.mu.Lock()
	defer qs.mu.Unlock()

	now := time.Now().UnixMilli()
	for ip, entry := range qs.rateLimitMap {
		if now-entry.windowStart > rateLimitWindowMs {
			delete(qs.rateLimitMap, ip)
		}
	}
}

// Check if we're running inside a Gramine SGX enclave
func isGramineEnclave() bool {
	_, err := os.Stat(attestationQuote)
	return err == nil
}

// Get the attestation type (should be "dcap" for SGX DCAP)
func getAttestationType() string {
	data, err := os.ReadFile(attestationType)
	if err != nil {
		return ""
	}
	return string(data)
}

type sgxQuoteData struct {
	Quote      []byte `json:"quote"`
	ReportData []byte `json:"report_data"`
}

// Generate an SGX DCAP quote with the given report data
func generateSgxQuote(reportData []byte) (*sgxQuoteData, error) {
	if len(reportData) != 64 {
		return nil, fmt.Errorf("report_data must be exactly 64 bytes, got %d", len(reportData))
	}

	if !isGramineEnclave() {
		return nil, fmt.Errorf("not running inside a Gramine SGX enclave")
	}

	// Write report_data to trigger quote generation
	if err := os.WriteFile(attestationUserReportData, reportData, 0644); err != nil {
		return nil, fmt.Errorf("failed to write report_data: %w", err)
	}

	// Read the generated quote
	quote, err := os.ReadFile(attestationQuote)
	if err != nil {
		return nil, fmt.Errorf("failed to read quote: %w", err)
	}

	return &sgxQuoteData{
		Quote:      quote,
		ReportData: reportData,
	}, nil
}

// Generate a quote bound to an x25519 public key
//
// The binding follows the same pattern as the TDX quote service:
// report_data[0:32] = SHA256(public_key)
// report_data[32:64] = zeros (or additional binding data)
func generateKeyBoundQuote(x25519PublicKey []byte) (*sgxQuoteData, error) {
	// Create report_data with key binding
	reportData := make([]byte, 64)

	if len(x25519PublicKey) > 0 {
		// Hash the public key into the first 32 bytes
		hash := sha256.Sum256(x25519PublicKey)
		copy(reportData[:32], hash[:])
	}
	// Second 32 bytes remain zeros (could be used for additional binding)

	return generateSgxQuote(reportData)
}

// HTTP handlers

func (qs *quoteService) healthzHandler(w http.ResponseWriter, r *http.Request) {
	// Enable CORS
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	inEnclave := isGramineEnclave()
	attType := getAttestationType()

	response := map[string]interface{}{
		"status":           "ok",
		"service":          "sgx-entrypoint",
		"enclave":          inEnclave,
		"attestation_type": attType,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func (qs *quoteService) quoteHandler(w http.ResponseWriter, r *http.Request) {
	// Enable CORS
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Rate limiting for quote generation (CPU-intensive operation)
	clientIP, _, _ := net.SplitHostPort(r.RemoteAddr)
	if clientIP == "" {
		clientIP = "unknown"
	}

	if qs.isRateLimited(clientIP) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Retry-After", "60")
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error":   "rate limit exceeded",
			"message": fmt.Sprintf("Maximum %d quote requests per minute", rateLimitMaxRequests),
		})
		return
	}

	var publicKey []byte

	if r.Method == http.MethodPost {
		// Read request body
		body, err := io.ReadAll(r.Body)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": "failed to read body"})
			return
		}
		defer r.Body.Close()

		var data struct {
			PublicKey []byte `json:"publicKey"`
		}

		if len(body) > 0 {
			if err := json.Unmarshal(body, &data); err != nil {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadRequest)
				json.NewEncoder(w).Encode(map[string]string{"error": "invalid JSON body"})
				return
			}
			publicKey = data.PublicKey
		}
	}

	// Check if we're in an enclave
	if !isGramineEnclave() {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotImplemented)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Not running inside SGX enclave",
			"hint":  "Run with: gramine-sgx workerd ...",
		})
		return
	}

	// Generate the quote
	quoteData, err := generateKeyBoundQuote(publicKey)
	if err != nil {
		log.Printf("[sgx-entrypoint] Quote generation error: %v", err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	// Return as JSON with base64-encoded values (same format as TDX service)
	response := map[string]string{
		"quote":       base64.StdEncoding.EncodeToString(quoteData.Quote),
		"tee_type":    "sgx",
		"report_data": base64.StdEncoding.EncodeToString(quoteData.ReportData),
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// startQuoteService starts the HTTP server for quote generation
func startQuoteService(port int) *http.Server {
	qs := newQuoteService()

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", qs.healthzHandler)
	mux.HandleFunc("/quote", qs.quoteHandler)

	addr := fmt.Sprintf("0.0.0.0:%d", port)
	server := &http.Server{
		Addr:    addr,
		Handler: mux,
	}

	go func() {
		log.Printf("[sgx-entrypoint] Quote service listening on http://%s", addr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("[sgx-entrypoint] Quote service error: %v", err)
		}
	}()

	return server
}

// waitForQuoteService waits for the quote service to be ready
func waitForQuoteService(port int, timeout time.Duration) error {
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	deadline := time.Now().Add(timeout)

	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, 100*time.Millisecond)
		if err == nil {
			conn.Close()
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}

	return fmt.Errorf("quote service did not start within %v", timeout)
}

func main() {
	// Parse port from environment
	port := defaultPort
	if portEnv := os.Getenv("QUOTE_SERVICE_PORT"); portEnv != "" {
		if p, err := strconv.Atoi(portEnv); err == nil {
			port = p
		}
	}

	// Find workerd arguments (everything after the binary name)
	// Usage: sgx-entrypoint [workerd_args...]
	// The entrypoint is called by Gramine with: sgx-entrypoint serve --experimental ...
	workerdArgs := os.Args[1:]

	log.Printf("[sgx-entrypoint] Starting SGX entrypoint")
	log.Printf("[sgx-entrypoint] Enclave: %v", isGramineEnclave())
	log.Printf("[sgx-entrypoint] Attestation type: %s", getAttestationType())

	// Start the quote service
	server := startQuoteService(port)

	// Wait for the quote service to be ready
	if err := waitForQuoteService(port, 10*time.Second); err != nil {
		log.Fatalf("[sgx-entrypoint] %v", err)
	}
	log.Printf("[sgx-entrypoint] Quote service ready on port %d", port)

	// Start workerd
	workerdPath := defaultWorkerdPath
	if path := os.Getenv("WORKERD_PATH"); path != "" {
		workerdPath = path
	}

	log.Printf("[sgx-entrypoint] Starting workerd: %s %v", workerdPath, workerdArgs)

	cmd := exec.Command(workerdPath, workerdArgs...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin

	// Set up signal handling
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGTERM, syscall.SIGINT)

	// Start workerd
	if err := cmd.Start(); err != nil {
		log.Fatalf("[sgx-entrypoint] Failed to start workerd: %v", err)
	}

	log.Printf("[sgx-entrypoint] workerd started with PID %d", cmd.Process.Pid)

	// Wait for either workerd to exit or a signal
	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()

	select {
	case sig := <-sigChan:
		log.Printf("[sgx-entrypoint] Received signal %v, forwarding to workerd", sig)
		if cmd.Process != nil {
			cmd.Process.Signal(sig)
		}
		// Wait for workerd to exit after signal
		<-done
	case err := <-done:
		if err != nil {
			log.Printf("[sgx-entrypoint] workerd exited with error: %v", err)
		} else {
			log.Printf("[sgx-entrypoint] workerd exited normally")
		}
	}

	// Shutdown the quote service gracefully
	server.Close()

	// Exit with the same code as workerd if possible
	if cmd.ProcessState != nil {
		os.Exit(cmd.ProcessState.ExitCode())
	}
}
