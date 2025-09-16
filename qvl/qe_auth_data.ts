import { extractPemCertificates } from './utils.js';

/**
 * Parse the qe_auth_data structure which contains:
 * - 40 bytes of header/metadata
 * - 4 bytes UInt32LE length field for certificate data
 * - Certificate data (PEM certificates separated by newlines)
 */
export function parseQeAuthData(qeAuthData: Buffer) {
  if (qeAuthData.length < 44) {
    return {
      header: qeAuthData,
      certificateLength: 0,
      certificates: []
    };
  }

  // First 40 bytes are header/metadata
  const header = qeAuthData.slice(0, 40);
  
  // Next 4 bytes are the certificate data length (UInt32LE)
  const certificateLength = qeAuthData.readUInt32LE(40);
  
  // Certificates start at offset 44
  const certificateData = qeAuthData.slice(44, 44 + certificateLength);
  
  // Extract PEM certificates
  const certificates = extractPemCertificates(certificateData);
  
  return {
    header,
    certificateLength,
    certificates,
    certificateData
  };
}

/**
 * Structure of the 40-byte header in qe_auth_data:
 * - Bytes 0-7: Variable data (possibly identifier or partial hash)
 * - Bytes 8-31: Fixed pattern 0x01 through 0x18 (24 bytes)
 * - Bytes 32-39: Fixed pattern 0x1a through 0x1f followed by 0x05 0x00
 */
export function parseQeAuthDataHeader(header: Buffer) {
  if (header.length < 40) {
    throw new Error('QE auth data header must be at least 40 bytes');
  }
  
  return {
    prefix: header.slice(0, 8),
    fixedPattern1: header.slice(8, 32),  // Should be 0x01...0x18
    fixedPattern2: header.slice(32, 40), // Should be 0x1a...0x1f, 0x05, 0x00
  };
}