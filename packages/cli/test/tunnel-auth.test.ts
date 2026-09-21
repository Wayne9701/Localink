import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { REQUIRED_LOCAL_MCP_PROTOCOL_VERSION } from '@localink/openai-tunnel';
import { PROTOCOL_VERSION } from '@localink/mcp-server';

async function source(relativeUrl: string): Promise<string> {
  return readFile(fileURLToPath(new URL(relativeUrl, import.meta.url)), 'utf8');
}

test('doctor, recovery, bootstrap, configure, and status use auth metadata only', async () => {
  const cliSource = await source('../../src/cli.ts');
  const inspectionSource = await source(
    '../../../service/src/tunnel-auth-file.ts',
  );
  assert.match(cliSource, /inspectTunnelAuthFile/u);
  assert.doesNotMatch(inspectionSource, /readFile/u);
  assert.match(inspectionSource, /lstat\(authFile\)/u);
  assert.doesNotMatch(cliSource, /createKeychainAvailabilityProbe/u);
  assert.doesNotMatch(cliSource, /MacOSKeychainSecretProvider/u);
});

test('Keychain is reachable only through the explicit one-time migration command', async () => {
  const cliSource = await source('../../src/cli.ts');
  assert.equal(cliSource.match(/new MacOSKeychainAdapter/g)?.length, 1);
  assert.match(
    cliSource,
    /migrateLegacyKeychainTunnelAuth\([\s\S]*?new MacOSKeychainAdapter\(new SystemSecurityExecutor\(60_000\)\)/u,
  );
  assert.match(cliSource, /migrate-keychain-auth/u);
});

test('Tunnel runtime uses fixed file-reference wrapper without secret env injection', async () => {
  const cliSource = await source('../../src/cli.ts');
  const wrapperSource = await source('../../../service/src/tunnel-wrapper.ts');
  assert.doesNotMatch(wrapperSource, /readFile/u);
  assert.doesNotMatch(wrapperSource, /\.read\(/u);
  assert.match(wrapperSource, /secretInjected: false/u);
  assert.match(wrapperSource, /injectedEnvironmentKeys: \[\]/u);
  assert.doesNotMatch(cliSource, /secretRef: config\.secretRef/u);
});

test('Tunnel configuration is pinned to the Localink-owned client and current MCP protocol', async () => {
  const cliSource = await source('../../src/cli.ts');
  assert.equal(REQUIRED_LOCAL_MCP_PROTOCOL_VERSION, PROTOCOL_VERSION);
  assert.match(
    cliSource,
    /discoverTunnelClient\(\{\s*explicitPath: localinkTunnelClientPath\(root\)/u,
  );
  assert.doesNotMatch(
    cliSource,
    /async function configureTunnel[\s\S]*?discoverTunnelClient\(\)/u,
  );
});
