import path from 'node:path';
import { ServiceFoundationError } from './errors.js';
import type { LaunchAgentDefinition } from './types.js';

const ALLOWED_ENVIRONMENT_KEYS = [
  'LOCALINK_CONFIG_ROOT',
  'LOCALINK_LOG_ROOT',
  'LOCALINK_STATE_ROOT',
] as const;

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function stringElement(value: string, indent: string): string {
  return `${indent}<string>${escapeXml(value)}</string>`;
}

function keyValue(key: string, value: string, indent = '  '): string[] {
  return [`${indent}<key>${key}</key>`, stringElement(value, indent)];
}

function booleanValue(key: string, value: boolean): string[] {
  return [`  <key>${key}</key>`, `  <${value ? 'true' : 'false'}/>`];
}

export function renderLaunchAgentPlist(
  definition: LaunchAgentDefinition,
): string {
  const environmentKeys = Object.keys(definition.EnvironmentVariables).sort();
  if (
    definition.ProgramArguments.length === 0 ||
    !definition.ProgramArguments.every((value) => !value.includes('\0')) ||
    !path.isAbsolute(definition.ProgramArguments[0] ?? '') ||
    !path.isAbsolute(definition.WorkingDirectory) ||
    !path.isAbsolute(definition.StandardOutPath) ||
    !path.isAbsolute(definition.StandardErrorPath) ||
    definition.Umask !== '077' ||
    (definition.StartInterval !== undefined &&
      (!Number.isInteger(definition.StartInterval) ||
        definition.StartInterval <= 0)) ||
    environmentKeys.length !== ALLOWED_ENVIRONMENT_KEYS.length ||
    !environmentKeys.every(
      (key, index) => key === [...ALLOWED_ENVIRONMENT_KEYS].sort()[index],
    ) ||
    !Object.values(definition.EnvironmentVariables).every(
      (value) => path.isAbsolute(value) && !value.includes('\0'),
    )
  ) {
    throw new ServiceFoundationError(
      'PLIST_INVALID',
      'LaunchAgent definition violates the path, argv, schedule, or environment contract.',
    );
  }
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    ...keyValue('Label', definition.Label),
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...definition.ProgramArguments.map((value) => stringElement(value, '    ')),
    '  </array>',
    ...keyValue('WorkingDirectory', definition.WorkingDirectory),
    ...booleanValue('RunAtLoad', definition.RunAtLoad),
    ...booleanValue('KeepAlive', definition.KeepAlive),
    ...(definition.StartInterval === undefined
      ? []
      : [
          '  <key>StartInterval</key>',
          `  <integer>${definition.StartInterval}</integer>`,
        ]),
    ...keyValue('StandardOutPath', definition.StandardOutPath),
    ...keyValue('StandardErrorPath', definition.StandardErrorPath),
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(definition.EnvironmentVariables)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([key, value]) => keyValue(escapeXml(key), value, '    ')),
    '  </dict>',
    ...keyValue('Umask', definition.Umask),
    '</dict>',
    '</plist>',
    '',
  ];
  return lines.join('\n');
}
