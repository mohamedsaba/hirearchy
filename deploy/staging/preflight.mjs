import { execFileSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';

/**
 * @typedef {{ name: string, passed: boolean, message?: string }} PreflightCheckResult
 */

/**
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {PreflightCheckResult[]}
 */
export function runPreflightChecks(env = process.env) {
  const results = [];

  // 1. Node.js runtime version
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  results.push({
    name: 'Node.js runtime >= 20',
    passed: nodeMajor >= 20,
    message: `Running Node.js v${process.versions.node}`,
  });

  // 2. Docker CLI availability
  try {
    const dockerVer = execFileSync('docker', ['--version'], {
      encoding: 'utf8',
    }).trim();
    results.push({
      name: 'Docker CLI installed',
      passed: true,
      message: dockerVer,
    });
  } catch {
    results.push({
      name: 'Docker CLI installed',
      passed: false,
      message: 'docker command not found or not in PATH',
    });
  }

  // 3. Staging Proof Private Key validation
  const proofKey = env.STAGING_PROOF_PRIVATE_KEY;
  if (!proofKey) {
    results.push({
      name: 'STAGING_PROOF_PRIVATE_KEY configured',
      passed: false,
      message: 'Variable STAGING_PROOF_PRIVATE_KEY is missing',
    });
  } else {
    try {
      const der = Buffer.from(proofKey, 'base64');
      const keyObj = createPrivateKey({
        key: der,
        format: 'der',
        type: 'pkcs8',
      });
      const isEd25519 = keyObj.asymmetricKeyType === 'ed25519';
      results.push({
        name: 'STAGING_PROOF_PRIVATE_KEY format (Ed25519 PKCS#8)',
        passed: isEd25519,
        message: isEd25519 ? 'Valid Ed25519 private key' : 'Key is not Ed25519',
      });
    } catch {
      results.push({
        name: 'STAGING_PROOF_PRIVATE_KEY format (Ed25519 PKCS#8)',
        passed: false,
        message: 'Invalid base64 DER key',
      });
    }
  }

  // 4. Candidate Token Encryption Key validation
  const encKey = env.HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY;
  if (!encKey) {
    results.push({
      name: 'HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY configured',
      passed: false,
      message: 'Variable HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY is missing',
    });
  } else {
    try {
      const keyBytes = Buffer.from(encKey, 'base64');
      const isValid = keyBytes.length === 32;
      results.push({
        name: 'HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY length (32 bytes)',
        passed: isValid,
        message: isValid
          ? 'Valid 32-byte AES key'
          : `Expected 32 bytes, got ${keyBytes.length}`,
      });
    } catch {
      results.push({
        name: 'HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY length (32 bytes)',
        passed: false,
        message: 'Invalid base64 key',
      });
    }
  }

  // 5. Database URL structure check
  const dbUrl = env.STAGING_DATABASE_URL;
  if (!dbUrl) {
    results.push({
      name: 'STAGING_DATABASE_URL configured',
      passed: false,
      message: 'Variable STAGING_DATABASE_URL is missing',
    });
  } else {
    const isPostgres =
      dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://');
    results.push({
      name: 'STAGING_DATABASE_URL scheme',
      passed: isPostgres,
      message: isPostgres
        ? 'PostgreSQL scheme confirmed'
        : 'Must start with postgres://',
    });
  }

  return results;
}

if (process.argv[1] && process.argv[1].endsWith('preflight.mjs')) {
  console.log('--- Staging Preflight Checks ---');
  const checks = runPreflightChecks();
  let allPassed = true;
  for (const check of checks) {
    const symbol = check.passed ? '✓' : '✗';
    console.log(
      `${symbol} ${check.name}: ${check.message || (check.passed ? 'OK' : 'FAILED')}`,
    );
    if (!check.passed) allPassed = false;
  }
  process.exit(allPassed ? 0 : 1);
}
