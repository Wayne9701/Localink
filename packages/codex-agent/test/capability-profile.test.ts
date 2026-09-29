import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CAPABILITY_PROFILE,
  projectCodexNativeCapabilities,
  type InstalledCodexApp,
} from '../src/capability-profile.js';

async function writeFakeCodexAppServer(
  executable: string,
  installedResult: unknown,
  appReadResult: unknown,
): Promise<void> {
  await writeFile(
    executable,
    `#!/usr/bin/env node
const installedResult = ${JSON.stringify(installedResult)};
const appReadResult = ${JSON.stringify(appReadResult)};
if (process.argv[2] === 'mcp' && process.argv[3] === 'list') {
  console.log('Name Command Args Env Cwd Status Auth');
  console.log('engineering-bridge /bin/node - - - enabled Unsupported');
  console.log('bigquery /bin/toolbox - - - enabled Unsupported');
  process.exit(0);
}
if (!process.argv.includes('app-server')) process.exit(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  for (;;) {
    const newline = input.indexOf('\\n');
    if (newline < 0) break;
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    let result;
    if (message.method === 'initialize') result = {};
    else if (message.method === 'app/installed') result = installedResult;
    else if (
      message.method === 'app/read' &&
      message.params?.includeTools === true &&
      JSON.stringify(message.params?.appIds) === JSON.stringify(['dynamic_codexless'])
    ) result = appReadResult;
    else {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32602, message: 'unexpected request' },
      }) + '\\n');
      continue;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
  }
});
`,
    { mode: 0o700 },
  );
}

test('codex-native-v1 inherits normal capabilities and restricts only recursive tools', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'localink-profile-'));
  const executable = path.join(root, 'fake-codex');
  const secret = 'MUST_NOT_SURVIVE_04C';
  await writeFile(
    executable,
    `#!/bin/sh
printf '%s\\n' 'Name Command Args Env Cwd Status Auth'
printf '%s\\n' 'engineering-bridge /bin/node --token ${secret} SECRET=${secret} - enabled Unsupported'
printf '%s\\n' 'bigquery /bin/toolbox --secret ${secret} - - enabled Unsupported'
printf '%s\\n' 'lark-mcp /bin/lark - - - disabled Unsupported'
printf '\\n'
printf '%s\\n' 'Name Url Bearer Status Auth'
printf '%s\\n' 'singular https://example.invalid/${secret} - enabled Unknown'
`,
    { mode: 0o700 },
  );
  try {
    const projection = await projectCodexNativeCapabilities(
      executable,
      undefined,
      async () => [
        {
          id: 'asdk_engineering',
          runtimeName: 'Engineering Bridge',
          enabled: true,
          callable: true,
        },
        {
          id: 'asdk_codexless',
          runtimeName: 'Codexless',
          enabled: true,
          callable: true,
          codexlessToolNames: [
            'codex.agent_start',
            'codex.agent_show',
            'codex.command_exec',
            'codex.command_exec_extra',
            'codex.precise_edit',
            'localagent.run',
            'localfs.inspect',
            'localgit.status',
            'bigquery.find_list_table_ids',
            'lark.im_search',
            'apple.sales_report',
            'bilibili.video_metrics',
            'singular.report',
            'codex.browser_read',
          ],
        },
        {
          id: 'asdk_devspace',
          runtimeName: 'DevSpace',
          enabled: true,
          callable: true,
        },
        {
          id: 'asdk_localink',
          runtimeName: 'Localink',
          enabled: true,
          callable: true,
        },
        {
          id: 'connector_github',
          runtimeName: 'GitHub',
          enabled: true,
          callable: true,
          description: secret,
          url: `https://example.invalid/${secret}`,
          token: secret,
        } as unknown as InstalledCodexApp,
      ],
    );
    assert.equal(projection.profile, CAPABILITY_PROFILE);
    assert.deepEqual(projection.configuredServerNames, [
      'bigquery',
      'engineering-bridge',
      'lark-mcp',
      'singular',
    ]);
    assert.deepEqual(projection.deniedServerNames, ['engineering-bridge']);
    assert.deepEqual(projection.deniedAppNames, [
      'Codexless',
      'DevSpace',
      'Engineering Bridge',
      'Localink',
    ]);
    assert.deepEqual(projection.launchArgs, [
      '-c',
      'mcp_servers.engineering-bridge.enabled=false',
      '-c',
      'apps.asdk_codexless.default_tools_enabled=false',
      '-c',
      'apps.asdk_codexless.tools={ "apple.sales_report" = { enabled = true }, "bigquery.find_list_table_ids" = { enabled = true }, "bilibili.video_metrics" = { enabled = true }, "codex.browser_read" = { enabled = true }, "codex.command_exec_extra" = { enabled = true }, "lark.im_search" = { enabled = true }, "singular.report" = { enabled = true } }',
      '-c',
      'apps.asdk_devspace.default_tools_enabled=false',
      '-c',
      'apps.asdk_engineering.default_tools_enabled=false',
      '-c',
      'apps.asdk_localink.default_tools_enabled=false',
    ]);
    assert.equal(JSON.stringify(projection).includes(secret), false);
    assert.equal(
      projection.launchArgs.some((arg) => arg.startsWith('features.')),
      false,
    );
    assert.equal(
      projection.launchArgs.includes('mcp_servers.bigquery.enabled=false'),
      false,
    );
    assert.equal(
      projection.launchArgs.includes('mcp_servers.lark-mcp.enabled=true'),
      false,
    );
    assert.equal(
      projection.launchArgs.includes('apps.connector_github.enabled=false'),
      false,
    );
    assert.equal(
      projection.launchArgs.some((arg) => arg.endsWith('.enabled=false')),
      true,
    );
    assert.equal(
      projection.launchArgs.some(
        (arg) => arg.startsWith('apps.') && arg.endsWith('.enabled=false'),
      ),
      false,
    );
    const codexlessOverrides = projection.launchArgs.filter((arg) =>
      arg.startsWith('apps.asdk_codexless.tools='),
    );
    assert.equal(codexlessOverrides.length, 1);
    for (const allowed of [
      'bigquery.find_list_table_ids',
      'lark.im_search',
      'apple.sales_report',
      'bilibili.video_metrics',
      'singular.report',
      'codex.browser_read',
      'codex.command_exec_extra',
    ]) {
      assert.equal(
        codexlessOverrides[0]?.includes(
          `${JSON.stringify(allowed)} = { enabled = true }`,
        ),
        true,
      );
    }
    for (const denied of [
      'codex.agent_show',
      'codex.agent_start',
      'codex.command_exec',
      'codex.precise_edit',
      'localagent.run',
      'localfs.inspect',
      'localgit.status',
    ]) {
      assert.equal(
        codexlessOverrides[0]?.includes(`${JSON.stringify(denied)} =`),
        false,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('codex-native-v1 does not force-enable already-disabled target apps', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'localink-profile-'));
  const executable = path.join(root, 'fake-codex');
  await writeFile(
    executable,
    `#!/bin/sh
printf '%s\\n' 'Name Command Args Env Cwd Status Auth'
printf '%s\\n' 'bigquery /bin/toolbox - - - enabled Unsupported'
`,
    { mode: 0o700 },
  );
  try {
    const projection = await projectCodexNativeCapabilities(
      executable,
      undefined,
      async () => [
        {
          id: 'asdk_localink',
          runtimeName: 'Localink',
          enabled: false,
          callable: false,
        },
        {
          id: 'asdk_codexless',
          runtimeName: 'Codexless',
          enabled: false,
          callable: false,
        },
        {
          id: 'connector_gmail',
          runtimeName: 'Gmail',
          enabled: true,
          callable: true,
        },
      ],
    );
    assert.deepEqual(projection.deniedServerNames, []);
    assert.deepEqual(projection.deniedAppNames, []);
    assert.deepEqual(projection.launchArgs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('official app/read generates Codexless default deny plus one safe-tools table', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'localink-profile-'));
  const executable = path.join(root, 'fake-codex');
  const secret = 'MUST_NOT_SURVIVE_APP_READ';
  await writeFakeCodexAppServer(
    executable,
    {
      apps: [
        {
          id: 'dynamic_codexless',
          runtimeName: 'Codexless',
          enabled: true,
          callable: true,
          ignoredSecret: secret,
        },
      ],
    },
    {
      apps: [
        {
          id: 'dynamic_codexless',
          name: 'Codexless',
          description: secret,
          iconUrl: `https://example.invalid/${secret}`,
          toolSummaries: [
            {
              name: 'codex.agent_start',
              description: secret,
              isEnabled: true,
            },
            {
              name: 'codex.command_exec',
              description: secret,
              isEnabled: false,
            },
            {
              name: 'bigquery.query',
              description: secret,
              isEnabled: false,
            },
            {
              name: 'codex.browser_read',
              description: secret,
              isEnabled: false,
            },
          ],
        },
      ],
      missingAppIds: [],
    },
  );
  try {
    const projection = await projectCodexNativeCapabilities(executable);
    assert.deepEqual(projection.launchArgs, [
      '-c',
      'mcp_servers.engineering-bridge.enabled=false',
      '-c',
      'apps.dynamic_codexless.default_tools_enabled=false',
      '-c',
      'apps.dynamic_codexless.tools={ "bigquery.query" = { enabled = true }, "codex.browser_read" = { enabled = true } }',
    ]);
    assert.equal(JSON.stringify(projection).includes(secret), false);
    assert.equal(
      projection.launchArgs.some((arg) => arg.includes('codex.agent_start')),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('official app/read fails closed on malformed required tool metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'localink-profile-'));
  const executable = path.join(root, 'fake-codex');
  await writeFakeCodexAppServer(
    executable,
    {
      apps: [
        {
          id: 'dynamic_codexless',
          runtimeName: 'Codexless',
          enabled: true,
          callable: true,
        },
      ],
    },
    {
      apps: [{ id: 'dynamic_codexless', toolSummaries: null }],
      missingAppIds: [],
    },
  );
  try {
    await assert.rejects(
      projectCodexNativeCapabilities(executable),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'CAPABILITY_ISOLATION_UNAVAILABLE',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capability projection fails closed on malformed installed-app metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'localink-profile-'));
  const executable = path.join(root, 'fake-codex');
  await writeFile(
    executable,
    `#!/bin/sh
printf '%s\\n' 'Name Command Args Env Cwd Status Auth'
printf '%s\\n' 'bigquery /bin/toolbox - - - enabled Unsupported'
`,
    { mode: 0o700 },
  );
  try {
    await assert.rejects(
      projectCodexNativeCapabilities(
        executable,
        undefined,
        async () =>
          [
            {
              id: 'account.specific.id',
              runtimeName: 'Codexless',
              enabled: true,
              callable: true,
              codexlessToolNames: ['codex.agent_start'],
            },
          ] as readonly InstalledCodexApp[],
      ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'CAPABILITY_ISOLATION_UNAVAILABLE',
    );
    await assert.rejects(
      projectCodexNativeCapabilities(executable, undefined, async () => [
        {
          id: 'dynamic_codexless',
          runtimeName: 'Codexless',
          enabled: true,
          callable: true,
        },
      ]),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'CAPABILITY_ISOLATION_UNAVAILABLE',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capability projection fails closed on oversized Codexless tool count or launch arg', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'localink-profile-'));
  const executable = path.join(root, 'fake-codex');
  await writeFile(
    executable,
    `#!/bin/sh
printf '%s\\n' 'Name Command Args Env Cwd Status Auth'
printf '%s\\n' 'bigquery /bin/toolbox - - - enabled Unsupported'
`,
    { mode: 0o700 },
  );
  try {
    await assert.rejects(
      projectCodexNativeCapabilities(executable, undefined, async () => [
        {
          id: 'dynamic_codexless',
          runtimeName: 'Codexless',
          enabled: true,
          callable: true,
          codexlessToolNames: Array.from(
            { length: 1025 },
            (_, index) => `tool.${index}`,
          ),
        },
      ]),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'CAPABILITY_ISOLATION_UNAVAILABLE',
    );
    const maximumLengthToolNames = Array.from({ length: 1024 }, (_, index) => {
      const prefix = `safe.${index}.`;
      return prefix + 'x'.repeat(256 - Buffer.byteLength(prefix));
    });
    await assert.rejects(
      projectCodexNativeCapabilities(executable, undefined, async () => [
        {
          id: 'dynamic_codexless',
          runtimeName: 'Codexless',
          enabled: true,
          callable: true,
          codexlessToolNames: maximumLengthToolNames,
        },
      ]),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'CAPABILITY_ISOLATION_UNAVAILABLE',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capability projection fails closed when official MCP enumeration is unavailable', async () => {
  await assert.rejects(
    projectCodexNativeCapabilities('/definitely/missing/codex'),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'CAPABILITY_ISOLATION_UNAVAILABLE',
  );
});
